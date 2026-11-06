// The rigid-body-wheel prototype (physics/jointedWheelVehicle.ts) against
// the six-log course that SolidAxleVehicle's contact path is still red on.
//
// What the prototype is testing is whether handing wheel contact to the
// solver makes the obstacle defects go away. Measured, stock Ridgeback, 4L,
// open diffs, the logCrawl.test.ts speed controller, six logs at a pitch of
// two diameters (cleared tick / peak chassis y / peak drift / yaw / roll):
//
//   r       SolidAxleVehicle                  JointedWheelVehicle
//   0.0975  561  1.53  0.02 m  0.7  0.1 deg   503  1.35  0.05 m  0.5  0.4 deg
//   0.13    1549 1.74  0.01 m  0.1  1.3 deg   549  1.51  0.08 m  0.9  0.7 deg
//   0.195   914  1.85  0.13 m  1.0  2.1 deg   stalls at the first log
//   0.25    1711 1.81  0.05 m  0.7  0.6 deg   774  1.74  0.11 m  0.9  1.0 deg
//
// Symmetric without a single special case, and it clears two to three times
// sooner — but not the hub-height log logCrawl specifies. A rigid cylinder
// meets a log whose crest is at hub height with a contact normal ~19 deg
// above horizontal, so climbing it unassisted needs mu ~2.8, and a tyre on
// the catalog's 0.7 wood gets 1.15 x 0.7 = 0.8. Real tyres wrap the log;
// SolidAxleVehicle approximates that with edge advance and tread-wrap
// traction. At 1.3x tread grip (mu ~1.05 on wood) the prototype clears that
// course in 669 ticks with 0.04 m drift and 0.3 deg yaw and roll — inside
// every logCrawl bound except chassis vertical speed (1.18 m/s) and the
// 5 km/h limit, which SolidAxleVehicle meets only because its low-range
// governor clamps both after the solve.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BUTTON_RANGE, EMPTY_INPUT, type PlayerInput } from '../types.js';
import { createStockBuild } from '../vehicleBuild.js';
import type { Obstacle } from '../physics/objectCatalog.js';
import { Surface, dryWater, mountainFor, petrolStationPadFor, type TerrainData } from '../physics/terrain.js';
import { spawnYAboveGround } from '../physics/vehicleGeom.js';
import { JointedWheelVehicle } from '../physics/jointedWheelVehicle.js';
import { World, initRapier } from '../physics/world.js';
import { TUNING } from '../tuning.js';

beforeAll(async () => {
  await initRapier();
});

const SHIPPED_GRIP = TUNING.tireLongGripMult;
afterEach(() => {
  TUNING.tireLongGripMult = SHIPPED_GRIP;
});

function flatRoad(size: number, resolution: number): TerrainData {
  const petrolStation = petrolStationPadFor(size);
  petrolStation.cx = size * 4;
  petrolStation.cz = size * 4;
  return {
    size, resolution, seed: 0,
    heights: new Float32Array(resolution * resolution),
    surfaces: new Uint8Array(resolution * resolution).fill(Surface.Road),
    mountain: mountainFor(size),
    petrolStation,
    ...dryWater(resolution),
    bogs: [],
    roads: [],
  };
}

function spawn(world: World): JointedWheelVehicle {
  const build = createStockBuild();
  return world.spawnVehicle('jointed', {
    position: { x: 0, y: spawnYAboveGround(build), z: 0 },
  }, build) as JointedWheelVehicle;
}

function yawOf(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

function rollOf(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.z * q.z + q.x * q.x));
}

interface LogRun {
  clearedTick: number;
  maxChassisY: number;
  maxDriftX: number;
  maxYawDeg: number;
  maxRollDeg: number;
}

function crawlLogs(radius: number): LogRun {
  const logs: Obstacle[] = [];
  for (let i = 0; i < 6; i++) {
    logs.push({
      id: `log-${i}`, kind: 'log', x: 0, y: 0, z: 5 + i * radius * 4,
      size: radius, height: 0.7, yaw: 0, length: 6,
    });
  }
  const world = new World({ terrain: flatRoad(40, 16), obstacles: logs, vehicleModel: 'jointed' });
  const vehicle = spawn(world);
  vehicle.setInput({ ...EMPTY_INPUT, seq: 1 });
  for (let i = 0; i < 180; i++) world.step();
  vehicle.setInput({ ...EMPTY_INPUT, seq: 2, buttons: BUTTON_RANGE });
  world.step();
  expect(vehicle.drivetrainStatus().transferCase).toBe('4l');

  const finish = 5 + 5 * radius * 4 + 2.5;
  const input: PlayerInput = { ...EMPTY_INPUT, seq: 3 };
  const run: LogRun = { clearedTick: -1, maxChassisY: 0, maxDriftX: 0, maxYawDeg: 0, maxRollDeg: 0 };
  for (let tick = 0; tick < 2400; tick++) {
    const pre = vehicle.getState();
    input.throttle = Math.max(0, Math.min(0.5, 1.25 - Math.hypot(pre.linVel.x, pre.linVel.z)));
    input.seq = tick + 4;
    vehicle.setInput(input);
    world.step();
    const state = vehicle.getState();
    if (state.position.z > 0.4) {
      run.maxChassisY = Math.max(run.maxChassisY, state.position.y);
      run.maxDriftX = Math.max(run.maxDriftX, Math.abs(state.position.x));
      run.maxYawDeg = Math.max(run.maxYawDeg, Math.abs(yawOf(state.rotation)) * 180 / Math.PI);
      run.maxRollDeg = Math.max(run.maxRollDeg, Math.abs(rollOf(state.rotation)) * 180 / Math.PI);
    }
    if (state.position.z > finish) {
      run.clearedTick = tick;
      break;
    }
  }
  world.dispose();
  return run;
}

describe('rigid-body-wheel prototype', () => {
  it('settles, drives straight and stops on a flat road', () => {
    const world = new World({ terrain: flatRoad(400, 32), obstacles: [], vehicleModel: 'jointed' });
    const vehicle = spawn(world);
    for (let i = 0; i < 180; i++) world.step();
    expect(vehicle.wheelContacts()).toEqual([true, true, true, true]);
    const settled = vehicle.getState();
    expect(Math.abs(yawOf(settled.rotation))).toBeLessThan(0.01);

    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    let contactLosses = 0;
    let maxVerticalSpeed = 0;
    for (let i = 0; i < 300; i++) {
      world.step();
      contactLosses += vehicle.wheelContacts().filter((contact) => !contact).length;
      if (i > 60) maxVerticalSpeed = Math.max(maxVerticalSpeed, Math.abs(vehicle.getState().linVel.y));
    }
    const fast = vehicle.getState();
    const speed = Math.hypot(fast.linVel.x, fast.linVel.z);
    expect(speed).toBeGreaterThan(15);
    expect(fast.position.z).toBeGreaterThan(40);
    // Heightfield internal edges are fixed in a jointed world; without that
    // the round tyres hop at every triangle seam at speed.
    expect(contactLosses).toBe(0);
    expect(maxVerticalSpeed).toBeLessThan(0.1);
    // No tie rod and no caster: the residual is knuckle compliance.
    expect(Math.abs(yawOf(fast.rotation))).toBeLessThan(0.06);

    vehicle.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    for (let i = 0; i < 300; i++) world.step();
    const stopped = vehicle.getState();
    expect(Math.hypot(stopped.linVel.x, stopped.linVel.z)).toBeLessThan(0.2);
    world.dispose();
  }, 20_000);

  it('is deterministic: two worlds, same inputs, same state', () => {
    const states = [0, 1].map(() => {
      const world = new World({ terrain: flatRoad(400, 32), obstacles: [], vehicleModel: 'jointed' });
      const vehicle = spawn(world);
      for (let i = 0; i < 240; i++) {
        vehicle.setInput({ ...EMPTY_INPUT, seq: i + 1, throttle: i > 60 ? 0.8 : 0, steer: i > 150 ? 0.5 : 0 });
        world.step();
      }
      const state = JSON.stringify(vehicle.getState());
      world.dispose();
      return state;
    });
    expect(states[1]).toBe(states[0]);
  }, 20_000);

  it.each([0.0975, 0.13])('crawls six %s m logs symmetrically and without the body rising', (radius) => {
    const run = crawlLogs(radius);
    const report = JSON.stringify(run);
    expect(run.clearedTick, report).toBeGreaterThanOrEqual(0);
    expect(run.maxDriftX, report).toBeLessThan(0.15);
    expect(run.maxYawDeg, report).toBeLessThan(3);
    expect(run.maxRollDeg, report).toBeLessThan(3);
    // logCrawl's chassis-height bound, which SolidAxleVehicle misses at 0.13.
    expect(run.maxChassisY, report).toBeLessThan(1.265 + 0.3);
  }, 20_000);

  it('crawls six 0.25 m logs symmetrically', () => {
    const run = crawlLogs(0.25);
    const report = JSON.stringify(run);
    expect(run.clearedTick, report).toBeGreaterThanOrEqual(0);
    expect(run.maxDriftX, report).toBeLessThan(0.15);
    expect(run.maxYawDeg, report).toBeLessThan(3);
    expect(run.maxRollDeg, report).toBeLessThan(3);
  }, 20_000);

  it('clears the hub-height course symmetrically once the tread grips wood like a wrapped tyre', () => {
    TUNING.tireLongGripMult = 1.3;
    const run = crawlLogs(0.195);
    const report = JSON.stringify(run);
    expect(run.clearedTick, report).toBeGreaterThanOrEqual(0);
    expect(run.maxDriftX, report).toBeLessThan(0.15);
    expect(run.maxYawDeg, report).toBeLessThan(3);
    expect(run.maxRollDeg, report).toBeLessThan(3);
  }, 20_000);

  // KNOWN FAILURE, quarantined: a rigid cylinder cannot climb a hub-height
  // log at the shipped tyre-on-wood friction (see the header). it.fails
  // inverts the result; when tyre wrap is modelled this starts failing and
  // should become it().
  it.fails('clears the hub-height course at shipped grip', () => {
    const run = crawlLogs(0.195);
    expect(run.clearedTick, JSON.stringify(run)).toBeGreaterThanOrEqual(0);
  }, 20_000);
});
