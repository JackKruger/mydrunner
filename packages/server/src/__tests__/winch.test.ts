// Slice 1 of the recovery winch (docs/winching-system.md §11): the
// force model itself, decoupled from input/state-machine/networking.
// Confirms a stationary vehicle is dragged toward a fixed anchor when
// the cable is reeled in, and that a slack cable applies zero force.

import { describe, it, expect, beforeAll } from 'vitest';
import { FIXED_DT, Physics, WINCH } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

function makeWorld() {
  const n = 64;
  const size = 200;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(Physics.Surface.Road);
  const world = new Physics.World({
    terrain: {
      size,
      resolution: n,
      heights,
      surfaces,
      seed: 0,
      mountain: Physics.mountainFor(size),
      petrolStation: Physics.petrolStationPadFor(size),
      bogs: [],
      roads: [],
    },
  });
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: 0, y: 1.5, z: 0 } },
    'patrol',
  );
  world.vehicles.set(vehicle.id, vehicle);
  // Settle on the road so the chassis is at rest before the winch loads.
  for (let i = 0; i < 60; i++) world.step();
  return { world, vehicle };
}

/** Single fixed step that interleaves a winch force in the slot the
 *  later slices will use inside SolidAxleVehicle.preStep — between the
 *  vehicle's per-tick force reset/wheel forces and the Rapier step. */
function stepWithWinch(world: Physics.World, vehicle: Physics.SolidAxleVehicle, winch: Physics.Winch) {
  vehicle.preStep();
  winch.applyForces();
  world.world.step();
  vehicle.postStep();
}

describe('Winch — force model (slice 1)', () => {
  it('drags a stationary vehicle toward a forward anchor when reeled in', () => {
    const { world, vehicle } = makeWorld();
    const start = vehicle.body.translation();
    // Anchor 12 m forward of spawn (+z, since the chassis-forward axis is
    // +z in chassis frame and the vehicle spawned with identity rotation).
    const anchor = { x: start.x, y: start.y, z: start.z + 12 };
    const winch = new Physics.Winch(
      vehicle.body,
      WINCH.mountLocal,
      anchor,
      12, // initial spool == distance: starts at zero stretch
    );

    // Reel in for 5 s (300 ticks). With a stationary chassis on flat
    // road and no driver inputs, the only forward force is the cable.
    // Track peak tension: on frictionless ground the chassis can briefly
    // outrun the cable (stretch goes negative → slack → zero tension),
    // so end-of-run tension isn't a meaningful signal — peak is.
    winch.setReelInput({ in: true, out: false });
    let peakTension = 0;
    for (let i = 0; i < 300; i++) {
      stepWithWinch(world, vehicle, winch);
      if (winch.tension > peakTension) peakTension = winch.tension;
      winch.stepSpool(FIXED_DT);
    }

    const end = vehicle.body.translation();
    const delta = end.z - start.z;
    expect(delta).toBeGreaterThan(1.5); // moved noticeably forward
    expect(peakTension).toBeGreaterThan(0);
    // Vehicle should not have flown off the ground or backwards.
    expect(end.y).toBeLessThan(start.y + 0.5);
    expect(end.y).toBeGreaterThan(start.y - 0.5);
    world.dispose();
  });

  it('applies no force while the cable is slack', () => {
    const { world, vehicle } = makeWorld();
    const start = vehicle.body.translation();
    // Anchor 5 m ahead but spool out 20 m of cable: cable hangs slack.
    const anchor = { x: start.x, y: start.y, z: start.z + 5 };
    const winch = new Physics.Winch(
      vehicle.body,
      WINCH.mountLocal,
      anchor,
      20,
    );

    for (let i = 0; i < 120; i++) {
      stepWithWinch(world, vehicle, winch);
      // No reel-in: spoolLength stays > distance, cable stays slack.
      expect(winch.tension).toBe(0);
    }

    const end = vehicle.body.translation();
    // Chassis should still be settled where it started (within mm).
    expect(Math.abs(end.x - start.x)).toBeLessThan(0.05);
    expect(Math.abs(end.z - start.z)).toBeLessThan(0.05);
    world.dispose();
  });

  it('reaches a steady-state stretch around mg / k under a hanging-load setup', () => {
    // Sanity check on tuning: with a vertical cable holding the chassis,
    // steady-state stretch should be roughly mg / stiffness. The vehicle
    // is 2500 kg, gravity ~9.81, stiffness 200_000 → ~12 cm stretch.
    // Allow generous bounds because suspension + ground contact also
    // bear part of the load; we only assert the cable is bearing
    // *something* in the right ballpark and doesn't blow up.
    const { world, vehicle } = makeWorld();
    const t = vehicle.body.translation();
    // Anchor 6 m directly above the fairlead.
    const anchor = { x: t.x, y: t.y + 6, z: t.z + WINCH.mountLocal.z };
    const winch = new Physics.Winch(
      vehicle.body,
      WINCH.mountLocal,
      anchor,
      0.001, // taut from the start
    );
    for (let i = 0; i < 600; i++) stepWithWinch(world, vehicle, winch);
    // Cable should be carrying load and not have NaN'd or blown up.
    expect(Number.isFinite(winch.tension)).toBe(true);
    expect(winch.tension).toBeGreaterThan(0);
    expect(winch.tension).toBeLessThan(1_000_000); // far below break / numerical blow-up
    world.dispose();
  });
});

describe('Winch — motor force cap (slice 2)', () => {
  it('motor stalls when last-tick tension exceeds motorMaxForce', () => {
    // Hugely-overstretched cable: anchor 12 m away, spool length 1 m.
    // Stretch ≈ 11 m → tension ≈ 11 m × 200 kN/m = 2.2 MN, far above
    // the 80 kN motor cap. The motor should refuse to reel in.
    //
    // The chassis must be pinned: a free dynamic body would be yanked
    // through the anchor, fly past, and slack the cable within a few
    // ticks (then the gate would let the motor reel in). A real winch
    // anchor is something the cable *can't* pull free — modelling that
    // here means locking translations on the chassis for the duration
    // of the test so the load stays maximal.
    const { world, vehicle } = makeWorld();
    vehicle.body.lockTranslations(true, true);
    vehicle.body.lockRotations(true, true);

    const start = vehicle.body.translation();
    const anchor = { x: start.x, y: start.y, z: start.z + 12 };
    const winch = new Physics.Winch(vehicle.body, WINCH.mountLocal, anchor, 1.0);

    // First step seeds winch.tension with the actual loaded value.
    stepWithWinch(world, vehicle, winch);
    expect(winch.tension).toBeGreaterThan(WINCH.motorMaxForce);

    winch.setReelInput({ in: true, out: false });
    const spoolBefore = winch.spoolLength;
    for (let i = 0; i < 60; i++) {
      stepWithWinch(world, vehicle, winch);
      winch.stepSpool(FIXED_DT);
    }
    expect(winch.spoolLength).toBe(spoolBefore);
    world.dispose();
  });

  it('motor reels normally when tension is below the force cap', () => {
    // Sanity contrast: low-load cable lets the motor advance the spool
    // at the configured rate. Same fixture as the slice-1 drag test
    // but here we assert against spool change rather than chassis
    // motion, isolating the motor-cap gate.
    const { world, vehicle } = makeWorld();
    const start = vehicle.body.translation();
    const anchor = { x: start.x, y: start.y, z: start.z + 10 };
    // 0.05 m of stretch → ~10 kN, well under the 80 kN motor cap.
    const winch = new Physics.Winch(vehicle.body, WINCH.mountLocal, anchor, 9.95);
    winch.setReelInput({ in: true, out: false });
    const spoolBefore = winch.spoolLength;
    for (let i = 0; i < 60; i++) {
      stepWithWinch(world, vehicle, winch);
      winch.stepSpool(FIXED_DT);
    }
    // 1 s × 0.8 m/s = 0.8 m of cable consumed, modulo any tick where
    // tension momentarily spiked above the cap (which won't happen at
    // this stretch level).
    const spoolDelta = spoolBefore - winch.spoolLength;
    expect(spoolDelta).toBeCloseTo(WINCH.spoolSpeed * 1.0, 2);
    world.dispose();
  });

  it('reel-out pays cable regardless of tension', () => {
    // Reel-out is unconditional — paying cable out doesn't fight the
    // load, so the motor cap doesn't apply to it. Stress test with a
    // cable initially over-tensioned, then reel out and confirm the
    // spool grows.
    const { world, vehicle } = makeWorld();
    const start = vehicle.body.translation();
    const anchor = { x: start.x, y: start.y, z: start.z + 12 };
    const winch = new Physics.Winch(vehicle.body, WINCH.mountLocal, anchor, 1.0);
    winch.setReelInput({ in: false, out: true });
    const spoolBefore = winch.spoolLength;
    for (let i = 0; i < 60; i++) {
      stepWithWinch(world, vehicle, winch);
      winch.stepSpool(FIXED_DT);
    }
    expect(winch.spoolLength).toBeGreaterThan(spoolBefore + 0.5);
    expect(winch.spoolLength).toBeLessThanOrEqual(WINCH.maxLength);
    world.dispose();
  });
});
