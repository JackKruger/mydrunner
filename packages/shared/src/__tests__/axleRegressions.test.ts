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
import { FIXED_DT, GRAVITY_Y, LEDGE_CONTACT } from '../constants.js';
import { EMPTY_INPUT, Physics, TUNING, createStockBuild } from '../index.js';
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
  const petrolStation = Physics.petrolStationPadFor(size);
  // These are terrain/axle fixtures, not production-map courses. Keep every
  // station collider well outside the heightfield so a landmark can never be
  // mistaken for the first step or alter the vehicle acceptance result.
  petrolStation.cx = size * 4;
  petrolStation.cz = size * 4;
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
      petrolStation,
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

  function isolatedLedge(height: number): Physics.World {
    return makeWorld((x, z) => (
      z >= -8 && x > 0 ? { height } : null
    ), 256, 120);
  }

  function traverse(
    height: number,
    isolated = false,
    pressureMode?: 'low' | 'nominal' | 'high',
    edgeWrapMult = 1,
  ): {
    progress: number; worstUp: number; highest: number;
    minRoll: number; maxRoll: number; maxArticulation: number;
    ledgeTicks: number; finite: boolean; pressurePsi: number; clearTick: number;
    ledgeAdvance: number; ledgeLongImpulse: number;
  } {
    const savedEdgeWrapMult = TUNING.tireEdgeWrapMult;
    TUNING.tireEdgeWrapMult = edgeWrapMult;
    const world = isolated ? isolatedLedge(height) : alternatingSteps(height);
    const vehicle = spawn(world, CRAWLER, { x: 0, y: 2.4, z: -12 });
    settle(world, 120);
    if (pressureMode) {
      const pressureAdjust = pressureMode === 'low' ? -1 : pressureMode === 'high' ? 1 : 0;
      vehicle.setInput({ ...EMPTY_INPUT, seq: 2, pressureAdjust });
      settle(world, 10 * 60);
      vehicle.setInput({ ...EMPTY_INPUT, seq: 3 });
      world.step();
    }
    const startZ = vehicle.getState().position.z;
    let worstUp = 1;
    let highest = -Infinity;
    let minRoll = 0;
    let maxRoll = 0;
    let ledgeTicks = 0;
    let finite = true;
    let clearTick = 10 * 60;
    let firstLedgeZ: number | null = null;
    let lastLedgeZ: number | null = null;
    let ledgeLongImpulse = 0;
    const internals = vehicle as unknown as {
      wheels: Array<{ ledgeContact: boolean; ledgeLongForce: number }>;
    };
    for (let tick = 0; tick < 10 * 60; tick++) {
      vehicle.setInput({
        ...EMPTY_INPUT, seq: tick + 2, throttle: 0.45, transferCase: '4l',
      });
      world.step();
      const state = vehicle.getState();
      if (clearTick === 10 * 60 && state.position.z > -5.5) clearTick = tick;
      finite = finite && [
        state.position.x, state.position.y, state.position.z,
        state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w,
        state.linVel.x, state.linVel.y, state.linVel.z,
        state.angVel.x, state.angVel.y, state.angVel.z,
        state.rpm, state.gear, state.throttle,
        ...state.axles.flatMap((axle) => [axle.rideY, axle.rollAngle]),
        ...state.wheels.flatMap((wheel) => [
          wheel.steer, wheel.spin, wheel.suspensionLength, wheel.angVel,
          wheel.tireDeflection,
          wheel.tireContactNormal.x, wheel.tireContactNormal.y, wheel.tireContactNormal.z,
        ]),
      ].every(Number.isFinite);
      worstUp = Math.min(worstUp, upY(vehicle));
      highest = Math.max(highest, state.position.y);
      for (const axle of state.axles!) {
        minRoll = Math.min(minRoll, axle.rollAngle);
        maxRoll = Math.max(maxRoll, axle.rollAngle);
      }
      for (let wheelIndex = 0; wheelIndex < internals.wheels.length; wheelIndex++) {
        const wheel = internals.wheels[wheelIndex]!;
        if (!wheel.ledgeContact) continue;
        ledgeTicks++;
        firstLedgeZ ??= state.position.z;
        lastLedgeZ = state.position.z;
        ledgeLongImpulse += Math.abs(wheel.ledgeLongForce) * FIXED_DT;
      }
    }
    const result = {
      progress: vehicle.getState().position.z - startZ,
      worstUp,
      highest,
      minRoll,
      maxRoll,
      maxArticulation: vehicle.geom.front.maxArticulation,
      ledgeTicks,
      finite,
      pressurePsi: vehicle.pressureStatus().currentPsi,
      clearTick,
      ledgeAdvance: firstLedgeZ === null || lastLedgeZ === null ? 0 : lastLedgeZ - firstLedgeZ,
      ledgeLongImpulse,
    };
    world.dispose();
    TUNING.tireEdgeWrapMult = savedEdgeWrapMult;
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

  it('climbs an isolated one-sided 0.6 m heightfield ledge safely', () => {
    // This is deliberately one ledge with a sustained upper surface. The old
    // alternating course mixed repeated climb/drop launches into this gate,
    // and its production-derived station metadata put a sign pole directly
    // in the approach. The 0.35 m whoops regression above retains that
    // repeated-articulation coverage; this fixture isolates steep-heightfield
    // climb geometry and the prepared Outclaw's safety envelope.
    const run = traverse(0.6, true);
    expect(run.progress).toBeGreaterThan(8);
    expect(run.ledgeTicks).toBeGreaterThan(0);
    expect(run.minRoll).toBeLessThan(-0.03);
    expect(run.maxRoll).toBeGreaterThan(0.03);
    expect(Math.abs(run.minRoll)).toBeLessThanOrEqual(run.maxArticulation);
    expect(run.maxRoll).toBeLessThanOrEqual(run.maxArticulation);
    expect(run.worstUp).toBeGreaterThan(0.8);
    expect(run.highest).toBeLessThan(3);
    expect(run.finite).toBe(true);
  }, 20_000);

  it('stalls at the wheels and front axle before the chassis belly reaches a 0.9 m ledge', () => {
    // Stage 4 is diagnosis-first: this is deliberately taller than the 0.6 m
    // acceptance ledge above, so the same real prepared Outclaw reaches a
    // stable stall instead of driving away before its belly can be observed.
    // Chassis manifolds are sampled through the same Rapier path postStep uses
    // for collision damage; no production telemetry or contact behavior is
    // added for this diagnostic.
    const world = isolatedLedge(0.9);
    const vehicle = spawn(world, CRAWLER, { x: 0, y: 2.4, z: -12 });
    settle(world, 120);
    const startZ = vehicle.getState().position.z;
    const drivenTicks = 10 * 60;
    const finalWindowTicks = 60;
    let finalWindowStartZ = startZ;
    let chassisManifoldTicks = 0;
    let chassisContactPoints = 0;
    let chassisImpulse = 0;
    let maxChassisImpulse = 0;
    type ChassisContactSample = {
      tick: number; localX: number; localY: number; localZ: number; impulse: number;
    };
    let firstChassisContact: ChassisContactSample | null = null;
    let lastChassisContact: ChassisContactSample | null = null;
    const wheelSupportTicks = [0, 0, 0, 0];
    const wheelLedgeTicks = [0, 0, 0, 0];
    const axleTubeTicks = [0, 0];
    const axleHousingTicks = [0, 0];
    const minAxleRide = [Infinity, Infinity];
    const maxAxleRide = [-Infinity, -Infinity];
    const maxAbsAxleRoll = [0, 0];
    const maxAbsAxleRideVelocity = [0, 0];
    const maxAbsAxleRollVelocity = [0, 0];
    let finite = true;
    let minUpY = 1;
    let maxChassisSpeed = 0;
    let maxChassisSpin = 0;
    let maxSuspensionForce = 0;
    let maxLedgeNormalForce = 0;
    let maxLedgeLongForce = 0;
    let maxTireUtilization = 0;
    const internals = vehicle as unknown as {
      wheels: Array<{
        ledgeContact: boolean;
        ledgeNormalForce: number;
        ledgeLongForce: number;
      }>;
    };

    for (let tick = 0; tick < drivenTicks; tick++) {
      vehicle.setInput({
        ...EMPTY_INPUT, seq: tick + 2, throttle: 0.45, transferCase: '4l',
      });
      world.step();
      const state = vehicle.getState();
      const debug = vehicle.debugTelemetry();
      if (tick === drivenTicks - finalWindowTicks - 1) finalWindowStartZ = state.position.z;

      finite = finite && [
        state.position.x, state.position.y, state.position.z,
        state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w,
        state.linVel.x, state.linVel.y, state.linVel.z,
        state.angVel.x, state.angVel.y, state.angVel.z,
      ].every(Number.isFinite);
      minUpY = Math.min(minUpY, 1 - 2 * (state.rotation.x ** 2 + state.rotation.z ** 2));
      maxChassisSpeed = Math.max(
        maxChassisSpeed,
        Math.hypot(state.linVel.x, state.linVel.y, state.linVel.z),
      );
      maxChassisSpin = Math.max(
        maxChassisSpin,
        Math.hypot(state.angVel.x, state.angVel.y, state.angVel.z),
      );

      for (let axleIndex = 0; axleIndex < 2; axleIndex++) {
        const axle = state.axles![axleIndex]!;
        const axleDebug = debug.axles[axleIndex]!;
        minAxleRide[axleIndex] = Math.min(minAxleRide[axleIndex]!, axle.rideY);
        maxAxleRide[axleIndex] = Math.max(maxAxleRide[axleIndex]!, axle.rideY);
        maxAbsAxleRoll[axleIndex] = Math.max(
          maxAbsAxleRoll[axleIndex]!, Math.abs(axle.rollAngle),
        );
        maxAbsAxleRideVelocity[axleIndex] = Math.max(
          maxAbsAxleRideVelocity[axleIndex]!, Math.abs(axleDebug.rideVelocity),
        );
        maxAbsAxleRollVelocity[axleIndex] = Math.max(
          maxAbsAxleRollVelocity[axleIndex]!, Math.abs(axleDebug.rollVelocity),
        );
        if (axleDebug.tubeContact) axleTubeTicks[axleIndex]!++;
        if (axleDebug.housingContact) axleHousingTicks[axleIndex]!++;
      }

      for (let wheelIndex = 0; wheelIndex < 4; wheelIndex++) {
        const wheel = internals.wheels[wheelIndex]!;
        const wheelDebug = debug.wheels[wheelIndex]!;
        if (state.wheels[wheelIndex]!.contact) wheelSupportTicks[wheelIndex]!++;
        if (wheel.ledgeContact) wheelLedgeTicks[wheelIndex]!++;
        maxSuspensionForce = Math.max(maxSuspensionForce, Math.abs(wheelDebug.suspensionForce));
        maxLedgeNormalForce = Math.max(maxLedgeNormalForce, Math.abs(wheel.ledgeNormalForce));
        maxLedgeLongForce = Math.max(maxLedgeLongForce, Math.abs(wheel.ledgeLongForce));
        maxTireUtilization = Math.max(maxTireUtilization, wheelDebug.utilization);
      }

      let chassisContactThisTick = false;
      world.world.contactPairsWith(vehicle.chassis, (other) => {
        world.world.contactPair(vehicle.chassis, other, (manifold, flipped) => {
          for (let contactIndex = 0; contactIndex < manifold.numContacts(); contactIndex++) {
            const point = flipped
              ? manifold.localContactPoint2(contactIndex)
              : manifold.localContactPoint1(contactIndex);
            if (!point) continue;
            const impulse = Math.abs(manifold.contactImpulse(contactIndex));
            const contact = {
              tick,
              localX: point.x,
              localY: point.y,
              localZ: point.z,
              impulse,
            };
            chassisContactThisTick = true;
            chassisContactPoints++;
            chassisImpulse += impulse;
            maxChassisImpulse = Math.max(maxChassisImpulse, impulse);
            firstChassisContact ??= contact;
            lastChassisContact = contact;
          }
        });
      });
      if (chassisContactThisTick) chassisManifoldTicks++;
    }

    const final = vehicle.getState();
    const summary = {
      progress: final.position.z - startZ,
      finalWindowProgress: final.position.z - finalWindowStartZ,
      chassisManifoldTicks,
      chassisContactPoints,
      chassisImpulse,
      maxChassisImpulse,
      firstChassisContact,
      lastChassisContact,
      wheelSupportTicks,
      wheelLedgeTicks,
      axleTubeTicks,
      axleHousingTicks,
      minAxleRide,
      maxAxleRide,
      maxAbsAxleRoll,
      maxAbsAxleRideVelocity,
      maxAbsAxleRollVelocity,
      finite,
      minUpY,
      maxChassisSpeed,
      maxChassisSpin,
      maxSuspensionForce,
      maxLedgeNormalForce,
      maxLedgeLongForce,
      maxTireUtilization,
      finalPose: { position: final.position, rotation: final.rotation },
      finalVelocity: { linear: final.linVel, angular: final.angVel },
    };
    const diagnostics = JSON.stringify(summary);

    // No chassis manifold means there is no belly contact to slide, pivot, or
    // snag. All chassis-contact location and impulse diagnostics remain empty.
    expect(summary.chassisManifoldTicks, diagnostics).toBe(0);
    expect(summary.chassisContactPoints, diagnostics).toBe(0);
    expect(summary.chassisImpulse, diagnostics).toBe(0);
    expect(summary.maxChassisImpulse, diagnostics).toBe(0);
    expect(summary.firstChassisContact, diagnostics).toBeNull();
    expect(summary.lastChassisContact, diagnostics).toBeNull();

    // It reaches the face, then makes effectively no progress in the final
    // second. Continuous wheel support plus sustained front-only ledge and
    // axle-probe contacts establish what is holding it before the belly.
    expect(summary.progress, diagnostics).toBeGreaterThan(2.5);
    expect(summary.progress, diagnostics).toBeLessThan(4);
    expect(summary.finalWindowProgress, diagnostics).toBeLessThan(0.05);
    expect(summary.wheelSupportTicks, diagnostics).toEqual([600, 600, 600, 600]);
    expect(summary.wheelLedgeTicks[0], diagnostics).toBeGreaterThan(300);
    expect(summary.wheelLedgeTicks[1], diagnostics).toBeGreaterThan(300);
    expect(summary.wheelLedgeTicks[2], diagnostics).toBe(0);
    expect(summary.wheelLedgeTicks[3], diagnostics).toBe(0);
    expect(summary.axleTubeTicks[0], diagnostics).toBeGreaterThan(300);
    expect(summary.axleHousingTicks[0], diagnostics).toBeGreaterThan(300);
    expect(summary.axleTubeTicks[1], diagnostics).toBe(0);
    expect(summary.axleHousingTicks[1], diagnostics).toBe(0);

    expect(summary.finite, diagnostics).toBe(true);
    expect(summary.minUpY, diagnostics).toBeGreaterThan(0.9);
    expect(summary.maxChassisSpeed, diagnostics).toBeLessThan(3);
    expect(summary.maxChassisSpin, diagnostics).toBeLessThan(1);
    for (let axleIndex = 0; axleIndex < 2; axleIndex++) {
      const geom = axleIndex === 0 ? vehicle.geom.front : vehicle.geom.rear;
      expect(summary.minAxleRide[axleIndex], diagnostics).toBeGreaterThanOrEqual(-geom.droopMax);
      expect(summary.maxAxleRide[axleIndex], diagnostics)
        .toBeLessThanOrEqual(geom.suspensionRestLength * 0.85 + 1e-6);
      expect(summary.maxAbsAxleRoll[axleIndex], diagnostics)
        .toBeLessThanOrEqual(geom.maxArticulation + 1e-6);
      expect(summary.maxAbsAxleRideVelocity[axleIndex], diagnostics).toBeLessThan(1.7);
      expect(summary.maxAbsAxleRollVelocity[axleIndex], diagnostics).toBeLessThan(4.5);
    }
    expect(summary.maxSuspensionForce, diagnostics).toBeLessThanOrEqual(LEDGE_CONTACT.maxForce);
    expect(summary.maxLedgeNormalForce, diagnostics).toBeLessThanOrEqual(LEDGE_CONTACT.maxForce);
    expect(summary.maxLedgeLongForce, diagnostics).toBeLessThanOrEqual(LEDGE_CONTACT.maxDriveForce);
    expect(summary.maxTireUtilization, diagnostics).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.hypot(final.linVel.x, final.linVel.y, final.linVel.z), diagnostics)
      .toBeLessThan(0.05);
    expect(Math.hypot(final.angVel.x, final.angVel.y, final.angVel.z), diagnostics)
      .toBeLessThan(0.05);
    world.dispose();
  }, 20_000);

  it('rewards airing down the prepared Outclaw while it wraps an isolated ledge', () => {
    const low = traverse(0.7, true, 'low');
    const nominal = traverse(0.7, true, 'nominal');
    const high = traverse(0.7, true, 'high');
    const diagnostics = JSON.stringify({ low, nominal, high });

    expect(low.pressurePsi, diagnostics).toBeLessThan(nominal.pressurePsi);
    expect(nominal.pressurePsi, diagnostics).toBeLessThan(high.pressurePsi);
    // The corrected bar direction changes the crawler's body path over the
    // edge, so contact distance is a secondary margin; transmitted tread
    // impulse below remains the stronger pressure-wrap signal.
    expect(low.ledgeAdvance, diagnostics).toBeGreaterThan(nominal.ledgeAdvance + 0.025);
    expect(low.ledgeAdvance, diagnostics).toBeGreaterThan(high.ledgeAdvance + 0.07);
    expect(low.ledgeLongImpulse, diagnostics).toBeGreaterThan(nominal.ledgeLongImpulse + 50);
    expect(low.ledgeLongImpulse, diagnostics).toBeGreaterThan(high.ledgeLongImpulse + 150);
    for (const run of [low, nominal, high]) {
      expect(run.progress).toBeGreaterThan(8);
      expect(run.ledgeTicks).toBeGreaterThan(0);
      expect(run.worstUp).toBeGreaterThan(0.8);
      expect(run.highest).toBeLessThan(3);
      expect(run.finite).toBe(true);
    }
  }, 30_000);

  it('reads the live edge-wrap multiplier in ledge physics', () => {
    const weak = traverse(0.6, true, 'nominal', 0.6);
    const strong = traverse(0.6, true, 'nominal', 1.4);
    expect(strong.clearTick).toBeLessThan(weak.clearTick);
    expect(strong.ledgeLongImpulse).toBeGreaterThan(weak.ledgeLongImpulse * 1.4);
    expect(weak.finite).toBe(true);
    expect(strong.finite).toBe(true);
  }, 30_000);
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
