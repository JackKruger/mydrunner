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

// ---------------------------------------------------------------------------
// Suspension scenarios.

/** Flat ground except a Gaussian bump centered at (bumpX, 0). */
function bumpTerrain(bumpHeight: number, bumpX = 5, sigma = 1.2): Physics.TerrainData {
  const heights = new Float32Array(RES * RES);
  const surfaces = new Uint8Array(RES * RES);
  surfaces.fill(Physics.Surface.Road);
  for (let row = 0; row < RES; row++) {
    for (let col = 0; col < RES; col++) {
      const x = -SIZE / 2 + (col * SIZE) / (RES - 1);
      const z = -SIZE / 2 + (row * SIZE) / (RES - 1);
      const d2 = (x - bumpX) * (x - bumpX) + z * z;
      heights[row * RES + col] = bumpHeight * Math.exp(-d2 / (2 * sigma * sigma));
    }
  }
  return {
    size: SIZE, resolution: RES, heights, surfaces, seed: 0,
    mountain: mountainFor(SIZE), petrolStation: petrolStationPadFor(SIZE),
    bogs: [], roads: [],
  };
}

/** Flat ground with one quadrant (x > stepX, z < 0) raised by stepHeight. */
function articulationTerrain(stepHeight: number, stepX = 0): Physics.TerrainData {
  const heights = new Float32Array(RES * RES);
  const surfaces = new Uint8Array(RES * RES);
  surfaces.fill(Physics.Surface.Road);
  for (let row = 0; row < RES; row++) {
    for (let col = 0; col < RES; col++) {
      const x = -SIZE / 2 + (col * SIZE) / (RES - 1);
      const z = -SIZE / 2 + (row * SIZE) / (RES - 1);
      // Smooth (cosine) ramp 0.5 m wide so the wheel doesn't catch on
      // a vertical wall - we want pure axle articulation, not a bump
      // collision response.
      const t = Math.max(0, Math.min(1, (x - stepX) / 0.5));
      const onStep = t * (z < 0 ? 1 : 0);
      heights[row * RES + col] = stepHeight * onStep;
    }
  }
  return {
    size: SIZE, resolution: RES, heights, surfaces, seed: 0,
    mountain: mountainFor(SIZE), petrolStation: petrolStationPadFor(SIZE),
    bogs: [], roads: [],
  };
}

/** Run a bump traversal: spawn at -25, accelerate to ~targetSpeed before
 *  the bump, coast over. Reports peak axle compression delta vs rest,
 *  peak chassis pitch, and how long until the chassis settles back. */
interface BumpResult {
  bumpHeight: number;
  approachSpeed: number;
  peakFrontComp: number;
  peakRearComp: number;
  peakPitchDeg: number;
  peakAirS: number;     // longest unbroken interval with all wheels off ground
  settleS: number;      // s after bump until pitch < 1° steady
}

function runBump(bumpHeight: number, targetSpeed = 12): BumpResult {
  const terrain = bumpTerrain(bumpHeight);
  const { world, vehicle } = makeWorld(terrain);
  // Settle, then accelerate.
  settle(world, 60);
  const restRideY = vehicle.axleSnaps?.()[0]?.rideY ?? 0;

  const input: PlayerInput = { ...EMPTY_INPUT, throttle: 1, seq: 1 };
  let peakFrontComp = 0;
  let peakRearComp = 0;
  let peakPitchDeg = 0;
  let airStart = -1, peakAirS = 0;
  let settleStartT = -1;
  let lastPitch = 0;
  const totalTicks = Math.round(8 / FIXED_DT);
  for (let i = 0; i < totalTicks; i++) {
    input.seq = i + 2;
    const s = vehicle.getState();
    const speed = Math.hypot(s.linVel.x, s.linVel.z);
    // Cut throttle once we hit target speed so the run is comparable.
    input.throttle = speed < targetSpeed ? 1 : 0;
    vehicle.setInput(input);
    world.step();
    const post = vehicle.getState();
    if (post.axles) {
      const fc = restRideY - post.axles[0].rideY; // compression delta from rest
      const rc = restRideY - post.axles[1].rideY;
      if (fc > peakFrontComp) peakFrontComp = fc;
      if (rc > peakRearComp) peakRearComp = rc;
    }
    const q = post.rotation;
    const fY = 2 * (q.y * q.z - q.w * q.x);
    const pitchDeg = Math.abs(Math.asin(Math.max(-1, Math.min(1, fY)))) * 180 / Math.PI;
    // Only count peak pitch once we're past the bump (x > 5 + 1 m
    // approach margin). Throttle-up squat before the bump produces
    // ~4° of front-up pitch that has nothing to do with the bump and
    // would otherwise dominate the table for small bumps.
    if (post.position.x > 6 && pitchDeg > peakPitchDeg) peakPitchDeg = pitchDeg;
    // Air = no wheel in contact this tick. wheels[].contact isn't on
    // the snapshot State; approximate with linVel.y > +1 and chassis
    // pitch oscillating (i.e., rapid pitch change).
    const allOffApprox = post.linVel.y > 1.5;
    if (allOffApprox && airStart < 0) airStart = i * FIXED_DT;
    else if (!allOffApprox && airStart >= 0) {
      const dur = i * FIXED_DT - airStart;
      if (dur > peakAirS) peakAirS = dur;
      airStart = -1;
    }
    // Settle: track when pitch first STAYS small after the bump.
    const tNow = i * FIXED_DT;
    if (tNow > 1.5 && pitchDeg < 1.0 && Math.abs(pitchDeg - lastPitch) < 0.05) {
      if (settleStartT < 0) settleStartT = tNow;
    } else if (pitchDeg >= 1.0 || Math.abs(pitchDeg - lastPitch) >= 0.05) {
      settleStartT = -1;
    }
    lastPitch = pitchDeg;
  }
  const result: BumpResult = {
    bumpHeight,
    approachSpeed: targetSpeed,
    peakFrontComp,
    peakRearComp,
    peakPitchDeg,
    peakAirS,
    settleS: settleStartT >= 0 ? settleStartT : -1,
  };
  world.dispose();
  return result;
}

/** Drop test: spawn at given height above flat ground, no input. */
interface DropResult {
  dropHeight: number;
  peakDownVel: number;
  peakComp: number;
  peakBounceY: number;
  settleS: number;
}

function runDrop(dropHeight: number): DropResult {
  const heights = new Float32Array(RES * RES);
  const surfaces = new Uint8Array(RES * RES);
  surfaces.fill(Physics.Surface.Road);
  const terrain: Physics.TerrainData = {
    size: SIZE, resolution: RES, heights, surfaces, seed: 0,
    mountain: mountainFor(SIZE), petrolStation: petrolStationPadFor(SIZE),
    bogs: [], roads: [],
  };
  const world = new Physics.World({ terrain });
  // Spawn dropHeight ABOVE the natural rest position (1.5 m, which is
  // what every other test uses). Spawning at y=dropHeight directly
  // would put the truck intersecting the ground for small heights.
  const NATURAL_REST_Y = 1.5;
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: 0, y: NATURAL_REST_Y + dropHeight, z: 0 }, yaw: Math.PI / 2 },
    'patrol',
  );
  world.vehicles.set(vehicle.id, vehicle);
  let peakDownVel = 0;
  let peakComp = 0;
  let peakBounceY = -Infinity;
  let restingY = -Infinity;
  let touchedDown = false;
  let firstSteadyT = -1;
  let lastY = 0;
  const totalTicks = Math.round(4 / FIXED_DT);
  for (let i = 0; i < totalTicks; i++) {
    world.step();
    const s = vehicle.getState();
    if (-s.linVel.y > peakDownVel) peakDownVel = -s.linVel.y;
    if (s.axles) {
      const fc = -s.axles[0].rideY;
      const rc = -s.axles[1].rideY;
      const c = Math.max(fc, rc);
      if (c > peakComp) peakComp = c;
    }
    if (!touchedDown && s.linVel.y > -0.5 && i > 5) {
      touchedDown = true;
      restingY = s.position.y;
    }
    if (touchedDown && s.position.y > peakBounceY) peakBounceY = s.position.y;
    const tNow = i * FIXED_DT;
    if (touchedDown && Math.abs(s.position.y - lastY) < 0.001 && Math.abs(s.linVel.y) < 0.05) {
      if (firstSteadyT < 0) firstSteadyT = tNow;
    } else {
      firstSteadyT = -1;
    }
    lastY = s.position.y;
  }
  const result: DropResult = {
    dropHeight,
    peakDownVel,
    peakComp,
    peakBounceY: peakBounceY > -Infinity && restingY > -Infinity ? peakBounceY - restingY : 0,
    settleS: firstSteadyT >= 0 ? firstSteadyT : -1,
  };
  world.dispose();
  return result;
}

interface ArticulationResult {
  stepHeight: number;
  rollDeg: number;
  frontFlexDeg: number;
  rearFlexDeg: number;
}

function runArticulation(stepHeight: number): ArticulationResult {
  const terrain = articulationTerrain(stepHeight, 0);
  const world = new Physics.World({ terrain });
  // Spawn straddling the step: x=0 is the step edge, truck centered
  // there with z=0 also on the boundary. The right-side wheels (z<0)
  // sit on the step; the left-side wheels (z>0) sit on the flat.
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: 0, y: stepHeight + 1.5, z: 0 }, yaw: Math.PI / 2 },
    'patrol',
  );
  world.vehicles.set(vehicle.id, vehicle);
  // 3 s settle so the suspension fully articulates.
  for (let i = 0; i < 180; i++) world.step();
  const s = vehicle.getState();
  const q = s.rotation;
  const rightY = 2 * (q.x * q.y + q.w * q.z);
  const rollDeg = Math.abs(Math.asin(Math.max(-1, Math.min(1, rightY)))) * 180 / Math.PI;
  const frontFlex = Math.abs(s.axles?.[0].rollAngle ?? 0) * 180 / Math.PI;
  const rearFlex = Math.abs(s.axles?.[1].rollAngle ?? 0) * 180 / Math.PI;
  world.dispose();
  return { stepHeight, rollDeg, frontFlexDeg: frontFlex, rearFlexDeg: rearFlex };
}

describe('arena: suspension', () => {
  it('reports bump traversal: chassis pitch + peak compression + settling', () => {
    const heights = [0.1, 0.2, 0.3, 0.4, 0.6];
    const rows: BumpResult[] = heights.map((h) => runBump(h));
    console.log(`\n[arena/bump] flat road with a single Gaussian bump, accel to 12 m/s, coast over`);
    console.log(`  ${'bumpH'.padStart(6)}  ${'frontC'.padStart(6)} ${'rearC'.padStart(6)} ${'pitch'.padStart(6)} ${'air'.padStart(5)} ${'settle'.padStart(6)}`);
    for (const r of rows) {
      console.log(
        `  ${fmt(r.bumpHeight, 6, 2)}m` +
        ` ${fmt(r.peakFrontComp, 6, 3)}` +
        ` ${fmt(r.peakRearComp, 6, 3)}` +
        ` ${fmt(r.peakPitchDeg, 6, 1)}°` +
        ` ${fmt(r.peakAirS, 5, 2)}s` +
        ` ${r.settleS >= 0 ? fmt(r.settleS, 6, 2) : '   n/a'}s`,
      );
    }
    // Tiny bumps shouldn't make the truck airborne.
    expect(rows[0]!.peakAirS).toBeLessThan(0.05);
  });

  it('reports drop test: peak compression + bounce + settle time', () => {
    const heights = [0.5, 1.0, 2.0, 3.0];
    const rows: DropResult[] = heights.map((h) => runDrop(h));
    console.log(`\n[arena/drop] spawn at height H above flat road, no input`);
    console.log(`  ${'dropH'.padStart(5)}  ${'peakDV'.padStart(7)} ${'peakComp'.padStart(8)} ${'bounce'.padStart(7)} ${'settle'.padStart(6)}`);
    for (const r of rows) {
      console.log(
        `  ${fmt(r.dropHeight, 5, 2)}m` +
        ` ${fmt(r.peakDownVel, 7, 2)}m/s` +
        ` ${fmt(r.peakComp, 8, 3)}m` +
        ` ${fmt(r.peakBounceY, 7, 3)}m` +
        ` ${r.settleS >= 0 ? fmt(r.settleS, 6, 2) : '   n/a'}s`,
      );
    }
    // A 1m drop should settle within 4 s.
    expect(rows[1]!.settleS).toBeGreaterThan(0);
  });

  it('reports cross-axle articulation (one side on a step)', () => {
    const heights = [0.1, 0.2, 0.3, 0.4];
    const rows: ArticulationResult[] = heights.map((h) => runArticulation(h));
    console.log(`\n[arena/articulation] truck straddles a step of height H, 3 s settle`);
    console.log(`  ${'stepH'.padStart(5)}  ${'chassisRoll'.padStart(11)} ${'frontAxleFlex'.padStart(13)} ${'rearAxleFlex'.padStart(12)}`);
    for (const r of rows) {
      console.log(
        `  ${fmt(r.stepHeight, 5, 2)}m` +
        ` ${fmt(r.rollDeg, 11, 1)}°` +
        ` ${fmt(r.frontFlexDeg, 13, 1)}°` +
        ` ${fmt(r.rearFlexDeg, 12, 1)}°`,
      );
    }
    // On a 0.2m step the AXLE should flex (>3°) instead of the
    // chassis swallowing it - that's why solid axles exist.
    const r02 = rows.find((r) => r.stepHeight === 0.2)!;
    expect(r02.frontFlexDeg + r02.rearFlexDeg).toBeGreaterThan(3);
  });
});
