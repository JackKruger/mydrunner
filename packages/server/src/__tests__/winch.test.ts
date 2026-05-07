// Slices 1–3 of the recovery winch (docs/winching-system.md §11).
//
// Slice 1 (force model): an attached, taut cable pulls the chassis
//   toward the anchor; a slack cable applies zero force; a hanging-load
//   tuning sanity check.
// Slice 2 (motor cap): reel-in stalls when last-tick tension exceeds
//   WINCH.motorMaxForce; reels normally otherwise; reel-out is
//   unconditional.
// Slice 3 (state machine + vehicle integration): every vehicle owns a
//   Winch field; phase transitions via toggleDeploy / setStaticAnchor /
//   release; world.step runs winch forces and spool advance inline
//   with vehicle physics.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, WINCH } from '@mydrunner/shared';

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

describe('Winch — force model (slice 1)', () => {
  it('drags a stationary vehicle toward a forward anchor when reeled in', () => {
    const { world, vehicle } = makeWorld();
    const start = vehicle.body.translation();
    // Anchor 12 m forward of spawn (+z is chassis-forward at identity).
    vehicle.winch.setStaticAnchor(
      { x: start.x, y: start.y, z: start.z + 12 },
      12, // initial spool == distance: starts at zero stretch
    );

    // Reel in for 5 s (300 ticks). With a stationary chassis on flat
    // road and no driver inputs, the only forward force is the cable.
    // Track peak tension: on frictionless ground the chassis can briefly
    // outrun the cable (stretch goes negative → slack → zero tension),
    // so end-of-run tension isn't a meaningful signal — peak is.
    vehicle.winch.setReelInput({ in: true, out: false });
    let peakTension = 0;
    for (let i = 0; i < 300; i++) {
      world.step();
      if (vehicle.winch.tension > peakTension) peakTension = vehicle.winch.tension;
    }

    const end = vehicle.body.translation();
    const delta = end.z - start.z;
    expect(delta).toBeGreaterThan(1.5);
    expect(peakTension).toBeGreaterThan(0);
    expect(end.y).toBeLessThan(start.y + 0.5);
    expect(end.y).toBeGreaterThan(start.y - 0.5);
    world.dispose();
  });

  it('applies no force while the cable is slack', () => {
    const { world, vehicle } = makeWorld();
    const start = vehicle.body.translation();
    // Anchor 5 m ahead but spool out 20 m of cable: cable hangs slack.
    vehicle.winch.setStaticAnchor(
      { x: start.x, y: start.y, z: start.z + 5 },
      20,
    );

    for (let i = 0; i < 120; i++) {
      world.step();
      expect(vehicle.winch.tension).toBe(0);
    }

    const end = vehicle.body.translation();
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
    vehicle.winch.setStaticAnchor(
      { x: t.x, y: t.y + 6, z: t.z + WINCH.mountLocal.z },
      0.001,
    );
    for (let i = 0; i < 600; i++) world.step();
    expect(Number.isFinite(vehicle.winch.tension)).toBe(true);
    expect(vehicle.winch.tension).toBeGreaterThan(0);
    expect(vehicle.winch.tension).toBeLessThan(1_000_000);
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
    vehicle.winch.setStaticAnchor(
      { x: start.x, y: start.y, z: start.z + 12 },
      1.0,
    );

    // First step seeds tension with the actual loaded value.
    world.step();
    expect(vehicle.winch.tension).toBeGreaterThan(WINCH.motorMaxForce);

    vehicle.winch.setReelInput({ in: true, out: false });
    const spoolBefore = vehicle.winch.spoolLength;
    for (let i = 0; i < 60; i++) world.step();
    expect(vehicle.winch.spoolLength).toBe(spoolBefore);
    world.dispose();
  });

  it('motor reels normally when tension is below the force cap', () => {
    const { world, vehicle } = makeWorld();
    const start = vehicle.body.translation();
    // 0.05 m of stretch → ~10 kN, well under the 80 kN motor cap.
    vehicle.winch.setStaticAnchor(
      { x: start.x, y: start.y, z: start.z + 10 },
      9.95,
    );
    vehicle.winch.setReelInput({ in: true, out: false });
    const spoolBefore = vehicle.winch.spoolLength;
    for (let i = 0; i < 60; i++) world.step();
    // 1 s × 0.8 m/s = 0.8 m of cable consumed, modulo any tick where
    // tension momentarily spiked above the cap (which won't happen at
    // this stretch level).
    const spoolDelta = spoolBefore - vehicle.winch.spoolLength;
    expect(spoolDelta).toBeCloseTo(WINCH.spoolSpeed * 1.0, 2);
    world.dispose();
  });

  it('reel-out pays cable regardless of tension', () => {
    const { world, vehicle } = makeWorld();
    const start = vehicle.body.translation();
    vehicle.winch.setStaticAnchor(
      { x: start.x, y: start.y, z: start.z + 12 },
      1.0,
    );
    vehicle.winch.setReelInput({ in: false, out: true });
    const spoolBefore = vehicle.winch.spoolLength;
    for (let i = 0; i < 60; i++) world.step();
    expect(vehicle.winch.spoolLength).toBeGreaterThan(spoolBefore + 0.5);
    expect(vehicle.winch.spoolLength).toBeLessThanOrEqual(WINCH.maxLength);
    world.dispose();
  });
});

describe('Winch — state machine (slice 3)', () => {
  it('default phase is stowed and applyForces is a no-op', () => {
    const { world, vehicle } = makeWorld();
    expect(vehicle.winch.phase).toBe('stowed');
    const start = vehicle.body.translation();
    for (let i = 0; i < 60; i++) world.step();
    const end = vehicle.body.translation();
    expect(Math.abs(end.x - start.x)).toBeLessThan(0.05);
    expect(Math.abs(end.z - start.z)).toBeLessThan(0.05);
    expect(vehicle.winch.tension).toBe(0);
    world.dispose();
  });

  it('toggleDeploy moves stowed ↔ deployed and is a no-op while attached', () => {
    const { world, vehicle } = makeWorld();
    expect(vehicle.winch.phase).toBe('stowed');
    vehicle.winch.toggleDeploy();
    expect(vehicle.winch.phase).toBe('deployed');
    vehicle.winch.toggleDeploy();
    expect(vehicle.winch.phase).toBe('stowed');

    const t = vehicle.body.translation();
    vehicle.winch.setStaticAnchor({ x: t.x, y: t.y, z: t.z + 8 }, 8);
    expect(vehicle.winch.phase).toBe('attached');
    vehicle.winch.toggleDeploy();
    expect(vehicle.winch.phase).toBe('attached'); // no-op while attached
    world.dispose();
  });

  it('release returns to stowed and zeroes the spool', () => {
    const { world, vehicle } = makeWorld();
    const t = vehicle.body.translation();
    vehicle.winch.setStaticAnchor({ x: t.x, y: t.y, z: t.z + 8 }, 8);
    expect(vehicle.winch.phase).toBe('attached');
    vehicle.winch.release();
    expect(vehicle.winch.phase).toBe('stowed');
    expect(vehicle.winch.spoolLength).toBe(0);
    expect(vehicle.winch.tension).toBe(0);
    world.dispose();
  });

  it('resetTo (KeyR) releases the cable so a teleport doesn’t leave it pulling', () => {
    const { world, vehicle } = makeWorld();
    const t = vehicle.body.translation();
    // Anchor 10 m forward, spool only 4 m. The fairlead sits 1.7 m
    // forward of body centre (mountLocal.z), so true cable length is
    // ~8.3 m — comfortably above the 4 m spool, ensuring obvious
    // tension on the first step.
    vehicle.winch.setStaticAnchor({ x: t.x, y: t.y, z: t.z + 10 }, 4);
    world.step();
    expect(vehicle.winch.tension).toBeGreaterThan(0);
    vehicle.resetTo({ position: { x: 0, y: 1.5, z: 0 } });
    expect(vehicle.winch.phase).toBe('stowed');
    expect(vehicle.winch.tension).toBe(0);
    world.dispose();
  });
});
