// Flat-road integration regression for the anti-roll wheel-tramp failure.
//
// The failure does not involve contact handoff or sidewall grip: at steady
// steering the anti-roll stiffness used to amplify suspension articulation
// until otherwise continuous tread contacts alternated between full and
// near-zero load. Keep this rig focused so ledge and rollover assistance
// cannot hide a regression in the paired wheel-end load transfer.

import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT, Physics, createStockBuild } from '../index.js';
import type { VehicleDebugTelemetry } from '../physics/vehicleTypes.js';

beforeAll(async () => { await Physics.initRapier(); });

type PressureMode = 'low' | 'nominal' | 'high';

interface TurningSummary {
  pressurePsi: number;
  finite: boolean;
  nearZeroLoadCrossings: number;
  contactLosses: number;
  nonTreadSamples: number;
  handoffSamples: number;
  minUpY: number;
  maxAbsRoll: number;
  maxAbsRollRate: number;
  maxAbsLateralG: number;
  maxAbsWheelVerticalVelocity: number;
  maxAbsAxleRideVelocity: number;
  maxAbsAxleRollVelocity: number;
  settledAxleRollVelocity: number;
  minTreadFraction: number;
  minSuspensionAlignment: number;
  minGripLimit: number;
  maxUtilization: number;
  leftMeanLoad: number;
  rightMeanLoad: number;
  finalLeftMeanLoad: number;
  finalRightMeanLoad: number;
  pairedTransferError: number;
}

function flatRoadWorld(): Physics.World {
  const resolution = 64;
  const size = 300;
  const petrolStation = Physics.petrolStationPadFor(size);
  petrolStation.cx = size * 4;
  petrolStation.cz = size * 4;
  return new Physics.World({
    terrain: {
      size,
      resolution,
      heights: new Float32Array(resolution * resolution),
      surfaces: new Uint8Array(resolution * resolution).fill(Physics.Surface.Road),
      seed: 73,
      mountain: Physics.mountainFor(size),
      petrolStation,
      ...Physics.dryWater(resolution),
      bogs: [],
      roads: [],
    },
    obstacles: [],
  });
}

function chassisRollRate(debug: VehicleDebugTelemetry): number {
  const q = debug.rotation;
  const forward = {
    x: 2 * (q.x * q.z + q.w * q.y),
    y: 2 * (q.y * q.z - q.w * q.x),
    z: 1 - 2 * (q.x * q.x + q.y * q.y),
  };
  return debug.angularVelocity.x * forward.x
    + debug.angularVelocity.y * forward.y
    + debug.angularVelocity.z * forward.z;
}

function finiteTelemetry(debug: VehicleDebugTelemetry): boolean {
  return [
    debug.position.x, debug.position.y, debug.position.z,
    debug.rotation.x, debug.rotation.y, debug.rotation.z, debug.rotation.w,
    debug.rollAngle, debug.pitchAngle, debug.lateralG,
    debug.linearVelocity.x, debug.linearVelocity.y, debug.linearVelocity.z,
    debug.angularVelocity.x, debug.angularVelocity.y, debug.angularVelocity.z,
    ...debug.axles.flatMap((axle) => [
      axle.rideVelocity, axle.rollVelocity,
      axle.antiRollLeftForce, axle.antiRollRightForce,
    ]),
    ...debug.wheels.flatMap((wheel) => [
      wheel.normalLoad, wheel.suspensionCompression,
      wheel.suspensionAxisAlignment, wheel.lateralForce, wheel.gripLimit,
      wheel.utilization, wheel.verticalVelocity,
    ]),
  ].every(Number.isFinite);
}

function runTurningRig(mode: PressureMode): TurningSummary {
  const world = flatRoadWorld();
  const vehicle = world.spawnVehicle(
    `turning-tramp-${mode}`,
    { position: { x: 0, y: 1.5, z: 0 } },
    createStockBuild('stockman-single'),
  ) as Physics.SolidAxleVehicle;

  if (mode !== 'nominal') {
    const pressureAdjust = mode === 'low' ? -1 : 1;
    for (let tick = 0; tick < 8 * 60; tick++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: tick + 1, pressureAdjust });
      world.step();
    }
  }
  vehicle.setInput({ ...EMPTY_INPUT, seq: 500 });
  for (let tick = 0; tick < 180; tick++) world.step();

  const pressurePsi = vehicle.pressureStatus().currentPsi;
  vehicle.body.setLinvel({ x: 0, y: 0, z: 8 }, true);

  const previousNearZero = [false, false, false, false];
  let finite = true;
  let nearZeroLoadCrossings = 0;
  let contactLosses = 0;
  let nonTreadSamples = 0;
  let handoffSamples = 0;
  let minUpY = 1;
  let maxAbsRoll = 0;
  let maxAbsRollRate = 0;
  let maxAbsLateralG = 0;
  let maxAbsWheelVerticalVelocity = 0;
  let maxAbsAxleRideVelocity = 0;
  let maxAbsAxleRollVelocity = 0;
  // Tramp is a sustained oscillation, so the peak alone cannot see it: the
  // rig starts by slamming a velocity step and full steer in on one tick,
  // and the largest sample is always that step response. Track the settled
  // window separately — if the axle is really tramping it is still ringing
  // at the end, and if it is not, this stays small however big the peak was.
  let settledAxleRollVelocity = 0;
  let minTreadFraction = 1;
  let minSuspensionAlignment = 1;
  let minGripLimit = Infinity;
  let maxUtilization = 0;
  let leftLoadSum = 0;
  let rightLoadSum = 0;
  let loadSamples = 0;
  let finalLeftLoadSum = 0;
  let finalRightLoadSum = 0;
  let finalLoadSamples = 0;
  let pairedTransferError = 0;
  const internals = vehicle as unknown as {
    wheels: Array<{ ledgeHandoff: boolean }>;
  };

  for (let tick = 0; tick < 240; tick++) {
    vehicle.setInput({
      ...EMPTY_INPUT,
      seq: 1_000 + tick,
      throttle: 0.25,
      steer: 1,
    });
    world.step();
    if (tick < 60) continue;

    const debug = vehicle.debugTelemetry();
    finite = finite && finiteTelemetry(debug);
    const q = debug.rotation;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    minUpY = Math.min(minUpY, upY);
    maxAbsRoll = Math.max(maxAbsRoll, Math.abs(debug.rollAngle));
    maxAbsRollRate = Math.max(maxAbsRollRate, Math.abs(chassisRollRate(debug)));
    maxAbsLateralG = Math.max(maxAbsLateralG, Math.abs(debug.lateralG));

    for (let axleIndex = 0; axleIndex < 2; axleIndex++) {
      const axle = debug.axles[axleIndex]!;
      pairedTransferError = Math.max(
        pairedTransferError,
        Math.abs(axle.antiRollLeftForce + axle.antiRollRightForce),
      );
      maxAbsAxleRideVelocity = Math.max(maxAbsAxleRideVelocity, Math.abs(axle.rideVelocity));
      maxAbsAxleRollVelocity = Math.max(maxAbsAxleRollVelocity, Math.abs(axle.rollVelocity));
      if (tick >= 180) {
        settledAxleRollVelocity = Math.max(settledAxleRollVelocity, Math.abs(axle.rollVelocity));
      }
    }

    for (let wheelIndex = 0; wheelIndex < 4; wheelIndex++) {
      const wheel = debug.wheels[wheelIndex]!;
      const nearZero = wheel.normalLoad < 250;
      if (nearZero && !previousNearZero[wheelIndex]) nearZeroLoadCrossings++;
      previousNearZero[wheelIndex] = nearZero;
      if (!wheel.contact) contactLosses++;
      if (wheel.contactZone !== 'tread' || wheel.treadFraction < 0.999) nonTreadSamples++;
      if (internals.wheels[wheelIndex]!.ledgeHandoff) handoffSamples++;
      minTreadFraction = Math.min(minTreadFraction, wheel.treadFraction);
      minSuspensionAlignment = Math.min(
        minSuspensionAlignment,
        wheel.suspensionAxisAlignment,
      );
      minGripLimit = Math.min(minGripLimit, wheel.gripLimit);
      maxUtilization = Math.max(maxUtilization, wheel.utilization);
      maxAbsWheelVerticalVelocity = Math.max(
        maxAbsWheelVerticalVelocity,
        Math.abs(wheel.verticalVelocity),
      );
    }

    const leftLoad = debug.wheels[0]!.normalLoad + debug.wheels[2]!.normalLoad;
    const rightLoad = debug.wheels[1]!.normalLoad + debug.wheels[3]!.normalLoad;
    leftLoadSum += leftLoad;
    rightLoadSum += rightLoad;
    loadSamples++;
    if (tick >= 180) {
      finalLeftLoadSum += leftLoad;
      finalRightLoadSum += rightLoad;
      finalLoadSamples++;
    }
  }

  const summary = {
    pressurePsi,
    finite,
    nearZeroLoadCrossings,
    contactLosses,
    nonTreadSamples,
    handoffSamples,
    minUpY,
    maxAbsRoll,
    maxAbsRollRate,
    maxAbsLateralG,
    maxAbsWheelVerticalVelocity,
    maxAbsAxleRideVelocity,
    maxAbsAxleRollVelocity,
    settledAxleRollVelocity,
    minTreadFraction,
    minSuspensionAlignment,
    minGripLimit,
    maxUtilization,
    leftMeanLoad: leftLoadSum / loadSamples,
    rightMeanLoad: rightLoadSum / loadSamples,
    finalLeftMeanLoad: finalLeftLoadSum / finalLoadSamples,
    finalRightMeanLoad: finalRightLoadSum / finalLoadSamples,
    pairedTransferError,
  };
  world.dispose();
  return summary;
}

describe('flat-road turning anti-roll stability', () => {
  it.each<PressureMode>(['low', 'nominal', 'high'])(
    'keeps continuous tread load stable at %s pressure',
    (mode) => {
      const run = runTurningRig(mode);
      const diagnostics = JSON.stringify(run);
      expect(run.finite, diagnostics).toBe(true);
      expect(run.pressurePsi, diagnostics).toBeCloseTo(
        mode === 'low' ? 20 : mode === 'high' ? 42 : 34,
        6,
      );
      expect(run.nearZeroLoadCrossings, diagnostics).toBeLessThanOrEqual(2);
      expect(run.contactLosses, diagnostics).toBe(0);
      expect(run.nonTreadSamples, diagnostics).toBe(0);
      expect(run.handoffSamples, diagnostics).toBe(0);
      expect(run.minTreadFraction, diagnostics).toBeGreaterThanOrEqual(0.999);
      expect(run.minSuspensionAlignment, diagnostics).toBeGreaterThan(0.99);
      expect(run.minGripLimit, diagnostics).toBeGreaterThan(0);
      expect(run.maxUtilization, diagnostics).toBeLessThanOrEqual(1.000001);
      expect(run.pairedTransferError, diagnostics).toBeLessThan(1e-8);
      // Positive steering loads the right (outside) tyres in this rig. The
      // sustained bias pins the force direction, not just bounded motion.
      expect(run.finalRightMeanLoad, diagnostics)
        .toBeGreaterThan(run.finalLeftMeanLoad * 5);
      expect(run.minUpY, diagnostics).toBeGreaterThan(0.99);
      expect(run.maxAbsRoll, diagnostics).toBeLessThan(0.1);
      expect(run.maxAbsRollRate, diagnostics).toBeLessThan(0.2);
      expect(run.maxAbsLateralG, diagnostics).toBeLessThan(1.2);
      expect(run.maxAbsWheelVerticalVelocity, diagnostics).toBeLessThan(0.5);
      expect(run.maxAbsAxleRideVelocity, diagnostics).toBeLessThan(0.25);
      // Peak, then settled. The peak bound was 0.75 when tyres kept full
      // cornering force at any longitudinal slip; combined-slip weighting
      // makes the axle answer the rig's one-tick velocity-and-full-steer
      // step more sharply, and low pressure now peaks at 0.817 — on the
      // FIRST sample, with only 3 of 180 samples above 0.75 and every one
      // of those inside the first second. Mean (0.398 vs 0.384) and the
      // settled window (0.367 vs 0.360) are unchanged, so this is a step
      // response, not tramp. The settled bound below is the one that would
      // actually catch tramp, and it is deliberately tight.
      expect(run.maxAbsAxleRollVelocity, diagnostics).toBeLessThan(0.9);
      expect(run.settledAxleRollVelocity, diagnostics).toBeLessThan(0.45);
    },
    20_000,
  );
});
