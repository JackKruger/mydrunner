// Real-vehicle regression for the low-range front sway-bar disconnect.
//
// Two deterministic copies of the same one-sided articulation fixture pin
// both the immediate paired load transfer and the sustained suspension result.
// This stays at rest so low range cannot affect the result through gearing or
// driven-wheel behaviour.

import { beforeAll, describe, expect, it } from 'vitest';
import { ANTI_ROLL, EMPTY_INPUT, GRAVITY_Y, Physics, createStockBuild } from '../index.js';
import type { TransferCaseMode } from '../types.js';
import type { VehicleDebugTelemetry } from '../physics/vehicleTypes.js';

beforeAll(async () => { await Physics.initRapier(); });

function articulationWorld(): Physics.World {
  const resolution = 128;
  const size = 60;
  const heights = new Float32Array(resolution * resolution);
  const surfaces = new Uint8Array(resolution * resolution).fill(Physics.Surface.Road);
  const petrolStation = Physics.petrolStationPadFor(size);
  petrolStation.cx = size * 4;
  petrolStation.cz = size * 4;
  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      const x = (column / (resolution - 1) - 0.5) * size;
      const z = (row / (resolution - 1) - 0.5) * size;
      if (x > -1.7 && x < -0.2 && z > 0.4 && z < 2.2) {
        heights[row * resolution + column] = 0.3;
      }
    }
  }
  return new Physics.World({
    terrain: {
      size,
      resolution,
      heights,
      surfaces,
      seed: 83,
      mountain: Physics.mountainFor(size),
      petrolStation,
      ...Physics.dryWater(resolution),
      bogs: [],
      roads: [],
    },
    obstacles: [],
  });
}

function spawn(world: Physics.World, id: string): Physics.SolidAxleVehicle {
  return world.spawnVehicle(
    id,
    { position: { x: 0, y: 2.2, z: 0 } },
    createStockBuild('ridgeback'),
  ) as Physics.SolidAxleVehicle;
}

function finiteTelemetry(debug: VehicleDebugTelemetry): boolean {
  return [
    debug.position.x, debug.position.y, debug.position.z,
    debug.rotation.x, debug.rotation.y, debug.rotation.z, debug.rotation.w,
    debug.linearVelocity.x, debug.linearVelocity.y, debug.linearVelocity.z,
    debug.angularVelocity.x, debug.angularVelocity.y, debug.angularVelocity.z,
    ...debug.axles.flatMap((axle) => [
      axle.rideVelocity, axle.rollVelocity,
      axle.antiRollLeftForce, axle.antiRollRightForce,
    ]),
    ...debug.wheels.flatMap((wheel) => [
      wheel.normalLoad, wheel.suspensionCompression, wheel.suspensionForce,
      wheel.verticalVelocity,
    ]),
  ].every(Number.isFinite);
}

interface SustainedSummary {
  finite: boolean;
  forceBounded: boolean;
  contacts: number;
  droopedTravelMean: number;
  droopedLoadMean: number;
  minUpY: number;
  maxAbsFrontRoll: number;
  maxAbsAxleRideVelocity: number;
  maxAbsAxleRollVelocity: number;
  maxChassisSpeed: number;
  maxChassisSpin: number;
  maxAbsAntiRollForce: number;
}

function sustained(mode: TransferCaseMode): SustainedSummary {
  const world = articulationWorld();
  const vehicle = spawn(world, `sustained-${mode}`);
  vehicle.setInput({ ...EMPTY_INPUT, seq: 1, brake: 1, transferCase: mode });
  for (let tick = 0; tick < 360; tick++) world.step();

  let finite = true;
  let forceBounded = true;
  let contacts = 0;
  let droopedTravel = 0;
  let droopedLoad = 0;
  let minUpY = 1;
  let maxAbsFrontRoll = 0;
  let maxAbsAxleRideVelocity = 0;
  let maxAbsAxleRollVelocity = 0;
  let maxChassisSpeed = 0;
  let maxChassisSpin = 0;
  let maxAbsAntiRollForce = 0;
  const sampleTicks = 180;
  for (let tick = 0; tick < sampleTicks; tick++) {
    vehicle.setInput({ ...EMPTY_INPUT, seq: tick + 2, brake: 1 });
    world.step();
    const state = vehicle.getState();
    const debug = vehicle.debugTelemetry();
    finite = finite && finiteTelemetry(debug);
    contacts += state.wheels.filter((wheel) => wheel.contact).length;
    // The front-left pad is raised, so front-right is the drooped end.
    droopedTravel += state.wheels[1]!.suspensionLength;
    droopedLoad += debug.wheels[1]!.normalLoad;
    const upY = 1 - 2 * (state.rotation.x ** 2 + state.rotation.z ** 2);
    minUpY = Math.min(minUpY, upY);
    maxAbsFrontRoll = Math.max(maxAbsFrontRoll, Math.abs(state.axles![0].rollAngle));
    for (let axleIndex = 0; axleIndex < debug.axles.length; axleIndex++) {
      const axle = debug.axles[axleIndex]!;
      const axleForceCap = vehicle.geom.spec.massKg * Math.abs(GRAVITY_Y)
        * (axleIndex === 0 ? 0.52 : 0.48) * ANTI_ROLL.maxStaticLoadTransfer;
      maxAbsAxleRideVelocity = Math.max(maxAbsAxleRideVelocity, Math.abs(axle.rideVelocity));
      maxAbsAxleRollVelocity = Math.max(maxAbsAxleRollVelocity, Math.abs(axle.rollVelocity));
      forceBounded = forceBounded
        && Math.abs(axle.antiRollLeftForce) <= axleForceCap + 1e-6
        && Math.abs(axle.antiRollRightForce) <= axleForceCap + 1e-6;
      maxAbsAntiRollForce = Math.max(
        maxAbsAntiRollForce,
        Math.abs(axle.antiRollLeftForce),
        Math.abs(axle.antiRollRightForce),
      );
    }
    maxChassisSpeed = Math.max(
      maxChassisSpeed,
      Math.hypot(state.linVel.x, state.linVel.y, state.linVel.z),
    );
    maxChassisSpin = Math.max(
      maxChassisSpin,
      Math.hypot(state.angVel.x, state.angVel.y, state.angVel.z),
    );
  }
  const summary = {
    finite,
    forceBounded,
    contacts,
    droopedTravelMean: droopedTravel / sampleTicks,
    droopedLoadMean: droopedLoad / sampleTicks,
    minUpY,
    maxAbsFrontRoll,
    maxAbsAxleRideVelocity,
    maxAbsAxleRollVelocity,
    maxChassisSpeed,
    maxChassisSpin,
    maxAbsAntiRollForce,
  };
  world.dispose();
  return summary;
}

describe('low-range front sway-bar disconnect', () => {
  it('scales only the front paired anti-roll response in an identical articulated state', () => {
    const highWorld = articulationWorld();
    const lowWorld = articulationWorld();
    const high = spawn(highWorld, 'high-range');
    const low = spawn(lowWorld, 'low-range');
    high.setInput({ ...EMPTY_INPUT, seq: 1, brake: 1 });
    low.setInput({ ...EMPTY_INPUT, seq: 1, brake: 1 });
    for (let tick = 0; tick < 360; tick++) {
      highWorld.step();
      lowWorld.step();
    }

    high.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1, transferCase: '4h' });
    low.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1, transferCase: '4l' });
    highWorld.step();
    lowWorld.step();
    const highDebug = high.debugTelemetry();
    const lowDebug = low.debugTelemetry();
    const diagnostics = JSON.stringify({ high: highDebug.axles, low: lowDebug.axles });

    expect(Math.abs(highDebug.axles[0].antiRollLeftForce), diagnostics).toBeGreaterThan(100);
    expect(highDebug.axles[0].antiRollLeftForce, diagnostics)
      .toBeCloseTo(-highDebug.axles[0].antiRollRightForce, 10);
    expect(lowDebug.axles[0].antiRollLeftForce, diagnostics)
      .toBeCloseTo(highDebug.axles[0].antiRollLeftForce * ANTI_ROLL.lowRangeFrontDisconnect, 10);
    expect(lowDebug.axles[0].antiRollRightForce, diagnostics)
      .toBeCloseTo(highDebug.axles[0].antiRollRightForce * ANTI_ROLL.lowRangeFrontDisconnect, 10);
    expect(lowDebug.axles[1].antiRollLeftForce, diagnostics)
      .toBeCloseTo(highDebug.axles[1].antiRollLeftForce, 10);
    expect(lowDebug.axles[1].antiRollRightForce, diagnostics)
      .toBeCloseTo(highDebug.axles[1].antiRollRightForce, 10);

    highWorld.dispose();
    lowWorld.dispose();
  });

  it('preserves drooped-end front travel and load through sustained articulation', () => {
    const high = sustained('4h');
    const low = sustained('4l');
    const diagnostics = JSON.stringify({ high, low });

    expect(low.droopedTravelMean, diagnostics).toBeGreaterThan(high.droopedTravelMean);
    expect(low.droopedLoadMean, diagnostics).toBeGreaterThan(high.droopedLoadMean);
    for (const run of [high, low]) {
      expect(run.finite, diagnostics).toBe(true);
      expect(run.forceBounded, diagnostics).toBe(true);
      expect(run.contacts, diagnostics).toBe(4 * 180);
      expect(run.minUpY, diagnostics).toBeGreaterThan(0.95);
      expect(run.maxAbsFrontRoll, diagnostics).toBeLessThanOrEqual(0.45 + 1e-6);
      expect(run.maxAbsAxleRideVelocity, diagnostics).toBeLessThan(0.05);
      expect(run.maxAbsAxleRollVelocity, diagnostics).toBeLessThan(0.2);
      expect(run.maxChassisSpeed, diagnostics).toBeLessThan(0.05);
      expect(run.maxChassisSpin, diagnostics).toBeLessThan(0.05);
    }
  }, 20_000);
});
