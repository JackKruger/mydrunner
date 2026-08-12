// Vehicle-level regressions for the solid-axle beam: droop, landing,
// articulation, repeated steps, portal clearance, and the internal
// chassis/beam reaction pair.
//
// axle.test.ts and travelStops.test.ts already pin the pure functions. These
// run the whole owner tick against a real Rapier world instead, because the
// behaviours below are properties of how the contact and suspension phases
// compose — an axle function can be correct in isolation while the phase that
// drives it feeds it the wrong pose or leaks an internal force into the
// chassis.

import { beforeAll, describe, expect, it } from 'vitest';
import { FIXED_DT, GRAVITY_Y } from '../constants.js';
import { EMPTY_INPUT, Physics, createStockBuild } from '../index.js';
import type { VehicleBuild } from '../types.js';

beforeAll(async () => { await Physics.initRapier(); });

const CRAWLER: VehicleBuild = {
  ...createStockBuild('outclaw'),
  suspensionId: 'outclaw.suspension.flex-100',
  axleId: 'outclaw.axle.portal-240',
  tireId: 'outclaw.tire.xt-40-wide',
  wheelId: 'outclaw.wheel.beadlock-alloy',
};

interface TerrainEdit {
  (x: number, z: number): { height?: number; surface?: number } | null;
}

function makeWorld(edit?: TerrainEdit, resolution = 128, size = 60): Physics.World {
  const heights = new Float32Array(resolution * resolution);
  const surfaces = new Uint8Array(resolution * resolution).fill(Physics.Surface.Dirt);
  for (let zi = 0; zi < resolution; zi++) {
    const z = (zi / (resolution - 1) - 0.5) * size;
    for (let xi = 0; xi < resolution; xi++) {
      const x = (xi / (resolution - 1) - 0.5) * size;
      const patch = edit?.(x, z);
      if (!patch) continue;
      if (patch.height !== undefined) heights[zi * resolution + xi] = patch.height;
      if (patch.surface !== undefined) surfaces[zi * resolution + xi] = patch.surface;
    }
  }
  return new Physics.World({
    terrain: {
      size,
      resolution,
      heights,
      surfaces,
      seed: 11,
      mountain: Physics.mountainFor(size),
      petrolStation: Physics.petrolStationPadFor(size),
      ...Physics.dryWater(resolution),
      bogs: [],
      roads: [],
    },
    obstacles: [],
  });
}

function spawn(
  world: Physics.World,
  build: VehicleBuild = createStockBuild('ridgeback'),
  position = { x: 0, y: 2, z: 0 },
): Physics.SolidAxleVehicle {
  const vehicle = world.spawnVehicle('rig', { position }, build) as Physics.SolidAxleVehicle;
  vehicle.setInput({ ...EMPTY_INPUT, seq: 1 });
  return vehicle;
}

function settle(world: Physics.World, ticks: number): void {
  for (let i = 0; i < ticks; i++) world.step();
}

function upY(vehicle: Physics.SolidAxleVehicle): number {
  const q = vehicle.getState().rotation;
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}

/** Zero the body's velocities, advance one tick, and report what the tick put
 *  back. Starting from rest makes the result the tick's own impulse rather
 *  than a history of everything before it. */
function stepFromRest(
  world: Physics.World,
  vehicle: Physics.SolidAxleVehicle,
): { x: number; y: number; z: number; spin: number } {
  vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  world.step();
  const state = vehicle.getState();
  return {
    x: state.linVel.x,
    y: state.linVel.y,
    z: state.linVel.z,
    spin: Math.hypot(state.angVel.x, state.angVel.y, state.angVel.z),
  };
}

describe('solid axle: unsupported droop', () => {
  it('extends both beams to full droop and reports no wheel contact in the air', () => {
    const world = makeWorld();
    const vehicle = spawn(world);
    settle(world, 120);
    const droopMax = vehicle.geom.front.droopMax;

    vehicle.body.setTranslation({ x: 0, y: 25, z: 0 }, true);
    vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    settle(world, 90);

    const state = vehicle.getState();
    for (const wheel of state.wheels) expect(wheel.contact).toBe(false);
    for (const axle of state.axles!) {
      expect(axle.rideY).toBeLessThan(-droopMax * 0.99);
      expect(axle.rideY).toBeGreaterThanOrEqual(-droopMax - 1e-6);
    }
    world.dispose();
  });

  it('leaves the airborne chassis in free fall while the beam sits on its rebound stop', () => {
    // The rebound stop is a large force between the chassis mount and the
    // beam, and at full droop it is fully engaged. It is an *internal* pair:
    // with nothing holding the wheel up it may move the relative axle DOF but
    // must not accelerate the rigid body that already owns the beam's mass.
    // If the `hasSuspensionSupport` gate on the stop force ever comes off,
    // this is the test that fails.
    //
    // Measured against the same vehicle a few ticks earlier, with the beam
    // still near its settled pose and the stop not yet engaged, rather than
    // against a hand-computed free-fall figure: Rapier applies its linear
    // damping multiplicatively inside the step, so restating that here would
    // pin this test to an integrator detail instead of to the invariant.
    const world = makeWorld();
    const vehicle = spawn(world);
    settle(world, 120);
    vehicle.body.setTranslation({ x: 0, y: 25, z: 0 }, true);

    world.step();
    const restingBeam = vehicle.getState().axles![0].rideY;
    const unengaged = stepFromRest(world, vehicle);

    settle(world, 90);
    const droopedBeam = vehicle.getState().axles![0].rideY;
    const engaged = stepFromRest(world, vehicle);

    // The two samples have to be taken either side of the rebound stop's
    // engagement point, or this compares nothing.
    const reboundStart = -vehicle.geom.front.droopMax * 0.85;
    expect(restingBeam).toBeGreaterThan(reboundStart);
    expect(droopedBeam).toBeLessThan(reboundStart);

    expect(engaged.y).toBeCloseTo(unengaged.y, 12);
    expect(engaged.x).toBeCloseTo(unengaged.x, 12);
    expect(engaged.z).toBeCloseTo(unengaged.z, 12);
    expect(engaged.spin).toBeCloseTo(unengaged.spin, 12);
    // And the fall itself is gravity, to a few parts in ten thousand — enough
    // to catch a leaked force without encoding how damping is applied.
    expect(engaged.y / (GRAVITY_Y * FIXED_DT)).toBeCloseTo(1, 3);
    world.dispose();
  });
});

describe('solid axle: landing', () => {
  it('absorbs a 1.2 m drop without punching through or bouncing back to height', () => {
    const world = makeWorld();
    const vehicle = spawn(world);
    settle(world, 240);
    const restY = vehicle.getState().position.y;

    const dropY = restY + 1.2;
    vehicle.body.setTranslation({ x: 0, y: dropY, z: 0 }, true);
    vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    let lowest = Infinity;
    let rebound = -Infinity;
    let landed = false;
    for (let i = 0; i < 300; i++) {
      world.step();
      const y = vehicle.getState().position.y;
      lowest = Math.min(lowest, y);
      if (!landed && y <= restY) landed = true;
      if (landed) rebound = Math.max(rebound, y);
    }

    expect(landed).toBe(true);
    // Suspension compresses on impact, but the chassis must not be driven
    // through its own settled ride height by more than the available travel.
    expect(lowest).toBeGreaterThan(restY - vehicle.geom.front.bumpMax - 0.05);
    // A spring that returns more than it absorbed would climb back toward the
    // drop; anything at or above it is energy the contact solver invented.
    expect(rebound).toBeLessThan(dropY);

    const settled = vehicle.getState();
    expect(Math.abs(settled.linVel.y)).toBeLessThan(0.1);
    expect(settled.position.y).toBeCloseTo(restY, 1);
    expect(upY(vehicle)).toBeGreaterThan(0.98);
    world.dispose();
  });
});

describe('solid axle: articulation', () => {
  it('keeps both wheels of an axle loaded over a one-sided rise, within the cap', () => {
    // A 0.22 m pad under the front-left wheel only, placed from the build's
    // own axle geometry rather than guessed coordinates. A solid axle answers
    // this by rotating about its centre so the right wheel follows the ground
    // down; an independent-suspension answer — lifting the opposite wheel off
    // the ground — is the regression.
    const geom = Physics.geomFor(CRAWLER);
    const padZ = geom.front.centerLocalZ;
    const padX = -geom.front.trackHalf;
    const world = makeWorld((x, z) => (
      Math.abs(x - padX) < 0.8 && Math.abs(z - padZ) < 0.8 ? { height: 0.22 } : null
    ));
    const vehicle = spawn(world, CRAWLER, { x: 0, y: 2.4, z: 0 });
    settle(world, 300);

    const state = vehicle.getState();
    const roll = state.axles![0].rollAngle;
    // Left wheel up means the beam rotates toward negative roll.
    expect(roll).toBeLessThan(-0.02);
    expect(Math.abs(roll)).toBeLessThanOrEqual(geom.front.maxArticulation + 1e-6);
    for (const wheel of state.wheels) expect(wheel.contact).toBe(true);
    expect(upY(vehicle)).toBeGreaterThan(0.9);
    world.dispose();
  });
});

describe('solid axle: repeated steps', () => {
  // Whoops: a pad on alternating sides every 4 m. Each one articulates both
  // beams hard in the opposite direction from the last, so a beam that snapped
  // between poses, or a contact phase that launched off a leading face, shows
  // up here as a rollover, a launch, or a stall.
  function alternatingSteps(height: number): Physics.World {
    return makeWorld((x, z) => {
      const index = Math.floor((z + 30) / 4);
      if (((z + 30) % 4) >= 1.6) return null;
      const leftSide = index % 2 === 0;
      return (leftSide ? x < 0 : x > 0) ? { height } : null;
    });
  }

  function traverse(height: number): {
    progress: number; worstUp: number; highest: number;
    minRoll: number; maxRoll: number; maxArticulation: number;
  } {
    const world = alternatingSteps(height);
    const vehicle = spawn(world, CRAWLER, { x: 0, y: 2.4, z: -12 });
    settle(world, 120);
    const startZ = vehicle.getState().position.z;
    let worstUp = 1;
    let highest = -Infinity;
    let minRoll = 0;
    let maxRoll = 0;
    for (let tick = 0; tick < 10 * 60; tick++) {
      vehicle.setInput({
        ...EMPTY_INPUT, seq: tick + 2, throttle: 0.45, transferCase: '4l',
      });
      world.step();
      const state = vehicle.getState();
      worstUp = Math.min(worstUp, upY(vehicle));
      highest = Math.max(highest, state.position.y);
      for (const axle of state.axles!) {
        minRoll = Math.min(minRoll, axle.rollAngle);
        maxRoll = Math.max(maxRoll, axle.rollAngle);
      }
    }
    const result = {
      progress: vehicle.getState().position.z - startZ,
      worstUp,
      highest,
      minRoll,
      maxRoll,
      maxArticulation: vehicle.geom.front.maxArticulation,
    };
    world.dispose();
    return result;
  }

  it('crosses alternating 0.35 m steps, articulating both ways', () => {
    // 0.35 m at 0.45 throttle covers ~13 m in ten seconds. The nearest cliff
    // in the swept height x throttle grid is 0.40 m at the same throttle,
    // which manages ~1 m, so the bar below has real margin — and a change
    // that halves this crawler's step-climbing genuinely should fail here.
    const run = traverse(0.35);
    expect(run.progress).toBeGreaterThan(8);
    // Both signs: the beam has to answer a left-side rise and a right-side
    // rise, not settle into one pose and stay there.
    expect(run.minRoll).toBeLessThan(-0.03);
    expect(run.maxRoll).toBeGreaterThan(0.03);
    expect(Math.abs(run.minRoll)).toBeLessThanOrEqual(run.maxArticulation);
    expect(run.maxRoll).toBeLessThanOrEqual(run.maxArticulation);
    // Upright throughout, not merely upright at the end.
    expect(run.worstUp).toBeGreaterThan(0.8);
    expect(run.highest).toBeLessThan(3);
  }, 20_000);

  it('stalls against alternating 0.6 m steps without launching or rolling', () => {
    // Being stopped is the correct outcome, and the reason is the wheel
    // radius. A *one-sided* face taller than the hub meets the tyre at or
    // above its centre, so the edge reaction on that wheel has no upward
    // component, and the wheel on the flat opposite side offers nothing to
    // lift with. Swept across height x throttle, the ceiling sits between
    // 0.45 m (climbs, but only at 0.7 throttle) and 0.50 m (never climbs at
    // any throttle) — which brackets this crawler's 0.508 m radius.
    //
    // The limit is that one-sidedness, not the height alone: the same 0.6 m
    // step run across the full width is climbable at 0.7 throttle, because
    // both wheels of the axle contact together and the chassis pitches up.
    // Nor is it drive: lockers cut the wheel-speed spread from 642 to 7 rad/s
    // and the truck still does not climb it. LEDGE_CONTACT.maxClimbHeight is
    // 0.9 m, so the ledge system is not rejecting the face either.
    //
    // What must not happen is the contact phase resolving that face into a
    // launch or a rollover — the failure mode the volumetric tyre query
    // exists to avoid.
    const run = traverse(0.6);
    expect(run.progress).toBeLessThan(3);
    expect(run.worstUp).toBeGreaterThan(0.8);
    expect(run.highest).toBeLessThan(3);
  }, 20_000);
});

describe('solid axle: portal clearance', () => {
  it('drags the standard axle housing over a centre ridge the portals clear', () => {
    // A narrow sealed ridge running down the drive line, under the diff and
    // between the wheels. Both builds carry the same 37-inch tyre, so wheel
    // radius is not what separates them — the portal axle's 80 mm of housing
    // lift is.
    //
    // 0.35 m is chosen from a sweep: below 0.30 m neither build touches, above
    // 0.40 m both do, and in between the standard housing drags continuously
    // while the portal one is essentially clear. Asserting a near-zero portal
    // count rather than merely "fewer than standard" is what makes the test
    // notice the lift being removed; a smaller probe alone still beats the
    // standard axle, so the weaker assertion passed with the lift deleted.
    const SAME_TYRE = 'outclaw.tire.mt-37';
    const run = (build: VehicleBuild): { contacts: number; progress: number } => {
      const world = makeWorld((x) => (
        Math.abs(x) < 0.45 ? { height: 0.35, surface: Physics.Surface.Road } : null
      ));
      const vehicle = spawn(world, build, { x: 0, y: 2.6, z: -12 });
      settle(world, 180);
      const startZ = vehicle.getState().position.z;
      let contacts = 0;
      for (let tick = 0; tick < 8 * 60; tick++) {
        vehicle.setInput({
          ...EMPTY_INPUT, seq: tick + 2, throttle: 0.6, transferCase: '4l',
        });
        world.step();
        for (const axle of vehicle.debugTelemetry().axles) {
          if (axle.tubeContact || axle.housingContact) contacts++;
        }
      }
      const progress = vehicle.getState().position.z - startZ;
      world.dispose();
      return { contacts, progress };
    };

    const standard = run({
      ...CRAWLER, axleId: 'outclaw.axle.wide-160', tireId: SAME_TYRE,
    });
    const portal = run({ ...CRAWLER, tireId: SAME_TYRE });

    expect(standard.contacts).toBeGreaterThan(200);
    expect(portal.contacts).toBeLessThan(50);
    // Dragging the diff over a ridge costs real ground speed.
    expect(portal.progress).toBeGreaterThan(standard.progress);
  }, 30_000);
});
