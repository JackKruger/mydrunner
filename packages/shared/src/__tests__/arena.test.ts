// Physics arena tests.
//
// Vitest scenarios that build custom terrains (slopes, cross-slopes,
// bumps), drive a scripted truck through them, and print measured
// outcomes. Used as a tuning loop: edit a value in constants.ts, run
// this suite, read the table, decide if the change helped.
//
// Not a pass/fail assertion suite. The hard expectations are loose
// (e.g. "the truck makes some forward progress on a 10° road") so the
// suite stays green across normal tuning. The numbers are the value.
//
// Run alone:
//   pnpm --filter @mydrunner/shared exec vitest run src/__tests__/arena.test.ts

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT, FIXED_DT, type PlayerInput } from '../index.js';
import { mountainFor, petrolStationPadFor } from '../physics/terrain.js';

beforeAll(async () => {
  await Physics.initRapier();
});

const SIZE = 200;
const RES = 96;

/** Terrain: flat for x < flatEnd, then a constant-gradient slope rising
 *  in +x. The slope rises along world +x so the vehicle's spawn yaw of
 *  pi/2 (chassis-forward = +x) drives it INTO the slope. */
function rampTerrain(slopeDeg: number, surface: Physics.Surface, flatEnd = -20): Physics.TerrainData {
  const heights = new Float32Array(RES * RES);
  const surfaces = new Uint8Array(RES * RES);
  const slope = Math.tan((slopeDeg * Math.PI) / 180);
  for (let row = 0; row < RES; row++) {
    for (let col = 0; col < RES; col++) {
      // World coords for the (col, row) cell. Heights array is
      // row-major in (col, row) per TerrainData docs.
      const x = -SIZE / 2 + (col * SIZE) / (RES - 1);
      const h = x > flatEnd ? (x - flatEnd) * slope : 0;
      heights[row * RES + col] = h;
      surfaces[row * RES + col] = surface;
    }
  }
  return {
    size: SIZE, resolution: RES, heights, surfaces, seed: 0,
    mountain: mountainFor(SIZE), petrolStation: petrolStationPadFor(SIZE),
    bogs: [], roads: [],
  };
}

/** Cross-slope: the slope rises in +z (perpendicular to forward), so a
 *  truck driving in +x crosses it at constant elevation but with a roll. */
function crossSlopeTerrain(slopeDeg: number, surface: Physics.Surface): Physics.TerrainData {
  const heights = new Float32Array(RES * RES);
  const surfaces = new Uint8Array(RES * RES);
  const slope = Math.tan((slopeDeg * Math.PI) / 180);
  for (let row = 0; row < RES; row++) {
    for (let col = 0; col < RES; col++) {
      const z = -SIZE / 2 + (row * SIZE) / (RES - 1);
      heights[row * RES + col] = z * slope;
      surfaces[row * RES + col] = surface;
    }
  }
  return {
    size: SIZE, resolution: RES, heights, surfaces, seed: 0,
    mountain: mountainFor(SIZE), petrolStation: petrolStationPadFor(SIZE),
    bogs: [], roads: [],
  };
}

function makeWorld(terrain: Physics.TerrainData): { world: Physics.World; vehicle: Physics.VehicleLike } {
  const world = new Physics.World({ terrain });
  // Spawn yaw pi/2 = chassis-forward along +x. The terrain is built so
  // +x is the direction of interest (uphill for ramps, lateral for cross).
  const spawnY = Physics.sampleHeightBilinear(terrain, -30, 0) + 1.5;
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: -30, y: spawnY, z: 0 }, yaw: Math.PI / 2 },
    'patrol',
  );
  world.vehicles.set(vehicle.id, vehicle);
  return { world, vehicle };
}

function settle(world: Physics.World, ticks = 60): void {
  for (let i = 0; i < ticks; i++) world.step();
}

function fmt(n: number, w: number, d = 1): string {
  return n.toFixed(d).padStart(w);
}

const SURFACE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Physics.Surface).map(([k, v]) => [v as number, k]),
);
function surfName(s: Physics.Surface): string {
  return SURFACE_NAMES[s] ?? '?';
}

interface ClimbResult {
  surface: string;
  slopeDeg: number;
  finalX: number;
  maxX: number;
  finalY: number;
  topSpeed: number;
  rolledOver: boolean;
}

function runClimb(slopeDeg: number, surface: Physics.Surface, durationS = 8): ClimbResult {
  const terrain = rampTerrain(slopeDeg, surface);
  const { world, vehicle } = makeWorld(terrain);
  settle(world, 60); // 1 s to settle suspension before gas
  const input: PlayerInput = { ...EMPTY_INPUT, throttle: 1, seq: 1 };
  const ticks = Math.round(durationS / FIXED_DT);
  let maxX = -Infinity;
  let topSpeed = 0;
  let rolledOver = false;
  for (let i = 0; i < ticks; i++) {
    input.seq = i + 2;
    vehicle.setInput(input);
    world.step();
    const s = vehicle.getState();
    if (s.position.x > maxX) maxX = s.position.x;
    const speed = Math.hypot(s.linVel.x, s.linVel.z);
    if (speed > topSpeed) topSpeed = speed;
    // Detect rollover: chassis-up Y component went negative.
    const q = s.rotation;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    if (upY < 0.5) rolledOver = true;
  }
  const finalState = vehicle.getState();
  const result: ClimbResult = {
    surface: surfName(surface),
    slopeDeg,
    finalX: finalState.position.x,
    maxX,
    finalY: finalState.position.y,
    topSpeed,
    rolledOver,
  };
  world.dispose();
  return result;
}

interface CrossResult {
  surface: string;
  slopeDeg: number;
  finalX: number;
  driftZ: number; // sideways drift from baseline z=0
  maxRollDeg: number;
  rolledOver: boolean;
}

function runCross(slopeDeg: number, surface: Physics.Surface, durationS = 6): CrossResult {
  const terrain = crossSlopeTerrain(slopeDeg, surface);
  const { world, vehicle } = makeWorld(terrain);
  settle(world, 60);
  const input: PlayerInput = { ...EMPTY_INPUT, throttle: 1, seq: 1 };
  const ticks = Math.round(durationS / FIXED_DT);
  let maxRollDeg = 0;
  let rolledOver = false;
  for (let i = 0; i < ticks; i++) {
    input.seq = i + 2;
    vehicle.setInput(input);
    world.step();
    const s = vehicle.getState();
    const q = s.rotation;
    // Roll about chassis-forward axis (chassis-right.y component).
    // Right vector world Y component for a rotation by quat:
    // right = (1 - 2(yy + zz), 2(xy + wz), 2(xz - wy)) -> y = 2(xy + wz).
    const rightY = 2 * (q.x * q.y + q.w * q.z);
    const rollDeg = Math.abs(Math.asin(Math.max(-1, Math.min(1, rightY)))) * 180 / Math.PI;
    if (rollDeg > maxRollDeg) maxRollDeg = rollDeg;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    if (upY < 0.5) rolledOver = true;
  }
  const finalState = vehicle.getState();
  const result: CrossResult = {
    surface: surfName(surface),
    slopeDeg,
    finalX: finalState.position.x,
    driftZ: finalState.position.z,
    maxRollDeg,
    rolledOver,
  };
  world.dispose();
  return result;
}

describe('arena: hill climb', () => {
  it('reports throttle-up climb on slopes x surfaces', () => {
    const surfaces = [Physics.Surface.Road, Physics.Surface.Dirt, Physics.Surface.Mud];
    const slopes = [0, 10, 20, 25, 30, 35];
    const rows: ClimbResult[] = [];
    for (const surf of surfaces) {
      for (const slope of slopes) rows.push(runClimb(slope, surf));
    }
    // Print a table.
    console.log(`\n[arena/climb] flat run-up + sloped section, throttle=1, 8 s`);
    console.log(`  ${'surf'.padEnd(8)} ${'slope'.padStart(5)}° ${'finalX'.padStart(7)} ${'maxX'.padStart(7)} ${'finalY'.padStart(7)} ${'topSpd'.padStart(6)}  rolled`);
    for (const r of rows) {
      console.log(
        `  ${r.surface.padEnd(8)}` +
        ` ${fmt(r.slopeDeg, 5, 0)}°` +
        ` ${fmt(r.finalX, 7)}` +
        ` ${fmt(r.maxX, 7)}` +
        ` ${fmt(r.finalY, 7)}` +
        ` ${fmt(r.topSpeed, 6)}` +
        `   ${r.rolledOver ? 'YES' : 'no'}`,
      );
    }
    // Loose sanity: on flat road the truck should make at least 20 m
    // forward progress in 8 s of throttle.
    const flatRoad = rows.find((r) => r.surface === 'Road' && r.slopeDeg === 0)!;
    expect(flatRoad.maxX).toBeGreaterThan(-10); // started at -30, gained > 20 m
  });
});

describe('arena: cross-slope body roll', () => {
  it('reports body roll while driving across slopes', () => {
    const surfaces = [Physics.Surface.Road, Physics.Surface.Dirt];
    const slopes = [0, 10, 20, 25, 30];
    const rows: CrossResult[] = [];
    for (const surf of surfaces) {
      for (const slope of slopes) rows.push(runCross(slope, surf));
    }
    console.log(`\n[arena/cross] flat ground rising in +z, drive in +x, throttle=1, 6 s`);
    console.log(`  ${'surf'.padEnd(8)} ${'slope'.padStart(5)}° ${'finalX'.padStart(7)} ${'driftZ'.padStart(7)} ${'maxRoll'.padStart(7)}  rolled`);
    for (const r of rows) {
      console.log(
        `  ${r.surface.padEnd(8)}` +
        ` ${fmt(r.slopeDeg, 5, 0)}°` +
        ` ${fmt(r.finalX, 7)}` +
        ` ${fmt(r.driftZ, 7)}` +
        ` ${fmt(r.maxRollDeg, 7)}°` +
        `   ${r.rolledOver ? 'YES' : 'no'}`,
      );
    }
    // Sanity: on a 30° cross-slope, the chassis should visibly roll
    // at least 10° (the new contact-normal force model fixes the
    // "stays flat" bug; this guards against regressing to the
    // world-up formulation).
    const r30 = rows.find((r) => r.surface === 'Road' && r.slopeDeg === 30)!;
    expect(r30.maxRollDeg).toBeGreaterThan(10);
  });
});
