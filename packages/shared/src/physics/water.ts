// Water queries against the terrain's authored water grids.
//
// Water is three arrays laid over the heightfield (see TerrainData):
// an absolute surface height per cell with a dry sentinel, and a velocity
// field split into components. There is no water collider — buoyancy,
// drag and current are forces computed from these samples, so the only
// thing the simulation needs from water is "how deep, and moving which
// way, at this point".

import { GRAVITY_Y, WATER } from '../constants.js';
import { TUNING } from '../tuning.js';
import { WATER_NONE, isWet, type TerrainData } from './terrain.js';
import { sampleHeightBilinear } from './terrain.js';
import { rotateVecByQuat } from './util.js';
import type { VehicleGeom } from './vehicleGeom.js';

export interface Vec2 {
  x: number;
  z: number;
}

/** Grid coordinates of a world point, or null out of bounds. */
function gridCoords(t: TerrainData, x: number, z: number): { u: number; v: number } | null {
  const n = t.resolution;
  const u = (x / t.size + 0.5) * (n - 1);
  const v = (z / t.size + 0.5) * (n - 1);
  if (u < 0 || u > n - 1 || v < 0 || v > n - 1) return null;
  return { u, v };
}

/**
 * Water-surface height at a world point, or WATER_NONE if dry.
 *
 * Bilinear over the wet neighbours only. Averaging in a dry cell's
 * sentinel would drag the surface to -1e9 within one cell of every
 * shoreline; averaging in a *plausible* dry value would be worse still,
 * because it would silently invent water where the author painted none.
 * Skipping dry corners and renormalising gives a surface that stays flat
 * right up to the edge, which is what a real waterline looks like.
 */
export function sampleWaterLevel(t: TerrainData, x: number, z: number): number {
  const g = gridCoords(t, x, z);
  if (!g) return WATER_NONE;
  const n = t.resolution;
  const c0 = Math.floor(g.u);
  const r0 = Math.floor(g.v);
  const c1 = Math.min(c0 + 1, n - 1);
  const r1 = Math.min(r0 + 1, n - 1);
  const fu = g.u - c0;
  const fv = g.v - r0;

  let acc = 0;
  let wsum = 0;
  const w = t.waterLevel;
  const corners: Array<[number, number]> = [
    [r0 * n + c0, (1 - fu) * (1 - fv)],
    [r0 * n + c1, fu * (1 - fv)],
    [r1 * n + c0, (1 - fu) * fv],
    [r1 * n + c1, fu * fv],
  ];
  for (const [idx, weight] of corners) {
    const lvl = w[idx] ?? WATER_NONE;
    if (!isWet(lvl)) continue;
    acc += lvl * weight;
    wsum += weight;
  }
  if (wsum <= 0) return WATER_NONE;
  return acc / wsum;
}

/**
 * Depth of water at a world point in metres, 0 where dry or where the bed
 * pokes above the surface.
 *
 * The bed is sampled bilinearly to match the collider the wheels actually
 * ride on — a nearest-neighbour bed against a bilinear surface would make
 * depth jump by a step at every cell boundary, and depth drives grip.
 */
export function sampleWaterDepth(t: TerrainData, x: number, z: number): number {
  const level = sampleWaterLevel(t, x, z);
  if (!isWet(level)) return 0;
  return Math.max(0, level - sampleHeightBilinear(t, x, z));
}

/** Water velocity in m/s at a world point. Writes into `out` to keep the
 *  per-tick physics path allocation-free. Zero where dry or still. */
export function sampleWaterFlow(t: TerrainData, x: number, z: number, out: Vec2): Vec2 {
  out.x = 0;
  out.z = 0;
  const g = gridCoords(t, x, z);
  if (!g) return out;
  const n = t.resolution;
  const c0 = Math.floor(g.u);
  const r0 = Math.floor(g.v);
  const c1 = Math.min(c0 + 1, n - 1);
  const r1 = Math.min(r0 + 1, n - 1);
  const fu = g.u - c0;
  const fv = g.v - r0;

  const i00 = r0 * n + c0;
  const i10 = r0 * n + c1;
  const i01 = r1 * n + c0;
  const i11 = r1 * n + c1;
  const w00 = (1 - fu) * (1 - fv);
  const w10 = fu * (1 - fv);
  const w01 = (1 - fu) * fv;
  const w11 = fu * fv;

  const fx = t.waterFlowX;
  const fz = t.waterFlowZ;
  out.x = (fx[i00] ?? 0) * w00 + (fx[i10] ?? 0) * w10 + (fx[i01] ?? 0) * w01 + (fx[i11] ?? 0) * w11;
  out.z = (fz[i00] ?? 0) * w00 + (fz[i10] ?? 0) * w10 + (fz[i01] ?? 0) * w01 + (fz[i11] ?? 0) * w11;
  return out;
}

/** Whether this terrain has any water at all. Lets the renderer skip
 *  building a water mesh, and the physics skip the whole force path, on
 *  the maps that have none. */
export function hasWater(t: TerrainData): boolean {
  for (let i = 0; i < t.waterLevel.length; i++) {
    if (isWet(t.waterLevel[i]!)) return true;
  }
  return false;
}

// --- Force model -----------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Per-vehicle water state that survives between ticks. Owned by the
 *  vehicle, reset by resetTo. */
export interface WaterState {
  /** 0..1, how much of the hull's displacement has been lost to flooding.
   *  Ramps up while the intake is under, drains when it is clear. */
  floodFrac: number;
  /** Consecutive ticks the air intake has been submerged. */
  intakeTicks: number;
}

export function createWaterState(): WaterState {
  return { floodFrac: 0, intakeTicks: 0 };
}

export function resetWaterState(s: WaterState): void {
  s.floodFrac = 0;
  s.intakeTicks = 0;
}

/** One buoyancy force and the world point it acts at. */
export interface WaterSample {
  point: Vec3;
  force: Vec3;
}

export interface WaterLoad {
  /** Four corner buoyancy forces. Applying them at their own points is
   *  what produces the righting moment — there is no separate torque
   *  term for roll or pitch because unequal corner lift already is one. */
  samples: WaterSample[];
  /** Whole-body drag, which is also the current: it is computed against
   *  the velocity of the vehicle *relative to the water*. */
  drag: Vec3;
  /** Centre of pressure for whole-body drag. In shallow water this sits
   *  below the chassis centre, so a cross-current loads the suspension
   *  and rolls the body instead of sliding it sideways without reaction. */
  dragPoint: Vec3;
  /** Angular drag, chassis-independent (world frame). */
  dragTorque: Vec3;
  /** 0..1 mean submersion across the hull samples. Drives the drag
   *  scaling and is what the HUD and effects read. */
  submergedFrac: number;
  /** True while the air intake is below the water surface. */
  intakeSubmerged: boolean;
  /** True once the intake has been under for WATER.drownTicks. */
  drowned: boolean;
}

/** Reusable output, so the per-tick physics path allocates nothing. */
export function createWaterLoad(): WaterLoad {
  return {
    samples: [
      { point: { x: 0, y: 0, z: 0 }, force: { x: 0, y: 0, z: 0 } },
      { point: { x: 0, y: 0, z: 0 }, force: { x: 0, y: 0, z: 0 } },
      { point: { x: 0, y: 0, z: 0 }, force: { x: 0, y: 0, z: 0 } },
      { point: { x: 0, y: 0, z: 0 }, force: { x: 0, y: 0, z: 0 } },
    ],
    drag: { x: 0, y: 0, z: 0 },
    dragPoint: { x: 0, y: 0, z: 0 },
    dragTorque: { x: 0, y: 0, z: 0 },
    submergedFrac: 0,
    intakeSubmerged: false,
    drowned: false,
  };
}

const _flow: Vec2 = { x: 0, z: 0 };
const _corner: Vec3 = { x: 0, y: 0, z: 0 };

/** Hull corner offsets in chassis-local space, as fractions of the
 *  chassis half-extents. The four bottom corners: sampling the bottom
 *  face rather than the centroid is what makes a nose-down truck feel
 *  its nose lift first. */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, 1], [1, 1], [-1, -1], [1, -1],
];

/**
 * Buoyancy, drag and current for one vehicle, for one tick.
 *
 * Pure apart from the WaterState it advances: takes the pose the caller
 * already read (the vehicle reads its body once per preStep and this
 * must not read it again) and writes into a reusable WaterLoad.
 */
export function computeWaterLoad(
  terrain: TerrainData,
  geom: VehicleGeom,
  state: WaterState,
  pose: { t: Vec3; r: Quat; lv: Vec3; av: Vec3 },
  dt: number,
  out: WaterLoad,
): WaterLoad {
  const ext = geom.chassisHalfExtents;
  const span = WATER.sampleDepthSpan;

  // --- Buoyancy, one force per hull corner ---------------------------
  let fracSum = 0;
  // Displacement lost to flooding. A swamped hull displaces less, so it
  // sits lower, so it swamps no faster — the ramp is in floodFrac, not
  // in a runaway feedback loop.
  const volume = WATER.hullVolume * TUNING.waterBuoyancy * (1 - state.floodFrac * WATER.swampLoss);
  const perCorner = WATER.density * -GRAVITY_Y * (volume / CORNERS.length);

  for (let i = 0; i < CORNERS.length; i++) {
    const [sx, sz] = CORNERS[i]!;
    _corner.x = sx * ext.x;
    _corner.y = -ext.y;
    _corner.z = sz * ext.z;
    const w = rotateVecByQuat(_corner, pose.r);
    const px = pose.t.x + w.x;
    const py = pose.t.y + w.y;
    const pz = pose.t.z + w.z;

    const level = sampleWaterLevel(terrain, px, pz);
    // Fraction of this corner's share that is under water: 0 at the
    // surface, 1 once it is a full span below.
    const frac = isWet(level) ? clamp01((level - py) / span) : 0;
    fracSum += frac;

    const s = out.samples[i]!;
    s.point.x = px;
    s.point.y = py;
    s.point.z = pz;
    s.force.x = 0;
    s.force.y = perCorner * frac;
    s.force.z = 0;
  }
  const submerged = fracSum / CORNERS.length;
  out.submergedFrac = submerged;

  // --- Drag, which is also the current -------------------------------
  //
  // One term against the relative velocity. A truck sitting still in a
  // river is pushed downstream; a truck already drifting at the flow
  // speed feels nothing; a truck driving upstream fights the full
  // relative speed. Modelling the current as a separate additive force
  // would get the first case right and the other two wrong.
  out.drag.x = 0;
  out.drag.y = 0;
  out.drag.z = 0;
  out.dragPoint.x = pose.t.x;
  out.dragPoint.y = pose.t.y;
  out.dragPoint.z = pose.t.z;
  out.dragTorque.x = 0;
  out.dragTorque.y = 0;
  out.dragTorque.z = 0;

  if (submerged > 0) {
    sampleWaterFlow(terrain, pose.t.x, pose.t.z, _flow);
    const flowScale = TUNING.waterFlowScale;
    const relX = pose.lv.x - _flow.x * flowScale;
    const relY = pose.lv.y;
    const relZ = pose.lv.z - _flow.z * flowScale;

    // Split the horizontal relative velocity into the chassis's own
    // forward and right axes so the flank can drag harder than the nose.
    const fwd = rotateVecByQuat({ x: 0, y: 0, z: 1 }, pose.r);
    const right = rotateVecByQuat({ x: 1, y: 0, z: 0 }, pose.r);
    // Flatten to horizontal: a pitched-up chassis should not turn
    // longitudinal drag into lift.
    const fLen = Math.hypot(fwd.x, fwd.z) || 1;
    const rLen = Math.hypot(right.x, right.z) || 1;
    const fx = fwd.x / fLen, fz = fwd.z / fLen;
    const rx = right.x / rLen, rz = right.z / rLen;

    const vLong = relX * fx + relZ * fz;
    const vLat = relX * rx + relZ * rz;

    const k = submerged * TUNING.waterDrag;
    const fLong = -WATER.dragLong * k * Math.abs(vLong) * vLong;
    const fLat = -WATER.dragLat * k * Math.abs(vLat) * vLat;
    const fVert = -WATER.dragVert * k * Math.abs(relY) * relY;

    out.drag.x = fLong * fx + fLat * rx;
    out.drag.z = fLong * fz + fLat * rz;
    out.drag.y = fVert;

    // Pressure acts around the centre of the wetted hull, not magically
    // through its centre of mass. As the water rises, that point moves
    // from the floor toward the hull centre. Applying a shallow
    // cross-current down low produces the small, important body lean a
    // driver expects to feel before the tyres begin to slide.
    _corner.x = 0;
    _corner.y = Math.min(ext.y, -ext.y + span * submerged * 0.5);
    _corner.z = 0;
    const cp = rotateVecByQuat(_corner, pose.r);
    out.dragPoint.x = pose.t.x + cp.x;
    out.dragPoint.y = pose.t.y + cp.y;
    out.dragPoint.z = pose.t.z + cp.z;

    const ka = WATER.dragAngular * k;
    out.dragTorque.x = -ka * pose.av.x;
    out.dragTorque.y = -ka * pose.av.y;
    out.dragTorque.z = -ka * pose.av.z;
  }

  // --- Air intake ----------------------------------------------------
  _corner.x = 0;
  _corner.y = geom.airIntakeY;
  _corner.z = 0;
  const iw = rotateVecByQuat(_corner, pose.r);
  const ix = pose.t.x + iw.x;
  const iy = pose.t.y + iw.y;
  const iz = pose.t.z + iw.z;
  const intakeLevel = sampleWaterLevel(terrain, ix, iz);
  const intakeSubmerged = isWet(intakeLevel) && intakeLevel > iy;
  out.intakeSubmerged = intakeSubmerged;

  state.intakeTicks = intakeSubmerged ? state.intakeTicks + 1 : 0;
  out.drowned = state.intakeTicks >= WATER.drownTicks;

  // --- Swamping ------------------------------------------------------
  //
  // Flooding is driven by hull submersion, NOT by the air intake. They
  // are different holes: water enters the body through the floor pan,
  // doors and vents, while the intake is only what drowns the engine.
  // Gating both on the intake meant a floating Patrol - whose snorkel
  // sits well clear of the waterline exactly as intended - could never
  // take on water and would drift downstream forever.
  //
  // Scaling by submergedFrac is what keeps an ordinary ford harmless: a
  // truck 30% in the water for eight seconds gains ~0.13 of flood, worth
  // a few per cent of displacement, while one floating fully takes on
  // water in WATER.swampSeconds and settles onto the bed.
  if (submerged > 0) {
    if (WATER.swampSeconds > 0) {
      state.floodFrac = Math.min(1, state.floodFrac + (submerged * dt) / WATER.swampSeconds);
    }
  } else if (WATER.drainSeconds > 0) {
    state.floodFrac = Math.max(0, state.floodFrac - dt / WATER.drainSeconds);
  }

  return out;
}

/** Grip multiplier for a wheel sitting in `depth` metres of water.
 *  1 on dry ground, falling to WATER.wheelGripFloor once the water is
 *  well over the hub. */
export function wetGripMult(depth: number, wheelRadius: number): number {
  if (depth <= 0) return 1;
  const full = wheelRadius * WATER.wheelGripDepthRatio;
  const t = clamp01(depth / full);
  return 1 + (WATER.wheelGripFloor - 1) * t;
}

/** How submerged a wheel is, 0..1, for scaling rolling resistance. */
export function wheelSubmersion(depth: number, wheelRadius: number): number {
  if (depth <= 0) return 0;
  return clamp01(depth / (wheelRadius * WATER.wheelGripDepthRatio));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
