// Water queries against the terrain's authored water grids.
//
// Water is three arrays laid over the heightfield (see TerrainData):
// an absolute surface height per cell with a dry sentinel, and a velocity
// field split into components. There is no water collider — buoyancy,
// drag and current are forces computed from these samples, so the only
// thing the simulation needs from water is "how deep, and moving which
// way, at this point".

import { WATER_NONE, isWet, type TerrainData } from './terrain.js';
import { sampleHeightBilinear } from './terrain.js';

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
