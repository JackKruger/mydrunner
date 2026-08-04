// Brush geometry: which cells a circular brush covers, and how strongly.
//
// Pure functions over the grid, with no Three, no document and no DOM —
// the arithmetic that decides whether a stroke lands where the cursor is
// belongs somewhere a test can reach it without a WebGL context.
//
// Rows index Z and columns index X, matching heights[r * n + c] and the
// GridRect contract in shared/physics/terrain.ts.

import { Physics } from '@mydrunner/shared';

export interface GridSpec {
  size: number;
  resolution: number;
}

/** World X of a column / world Z of a row.
 *
 *  Inverse of the mapping in worldToTerrainIndex: cell (n-1) sits on the
 *  +size/2 edge, not one cell short of it, so the divisor is n-1. Getting
 *  this wrong shifts every stroke by half a cell at the centre and a full
 *  cell at the rim, which reads as "the brush paints off to one side". */
export function cellCenter(g: GridSpec, index: number): number {
  return (index / (g.resolution - 1) - 0.5) * g.size;
}

/** Metres between adjacent cells. */
export function cellPitch(g: GridSpec): number {
  return g.size / (g.resolution - 1);
}

/** The rect a brush of `radius` metres at (x, z) touches, clamped to the
 *  grid. Empty (rows or cols 0) when the brush is entirely off-map. */
export function brushRect(g: GridSpec, x: number, z: number, radius: number): Physics.GridRect {
  const n = g.resolution;
  const pitch = cellPitch(g);
  const cCenter = (x / g.size + 0.5) * (n - 1);
  const rCenter = (z / g.size + 0.5) * (n - 1);
  const span = radius / pitch;
  const c0 = Math.max(0, Math.floor(cCenter - span));
  const r0 = Math.max(0, Math.floor(rCenter - span));
  const c1 = Math.min(n - 1, Math.ceil(cCenter + span));
  const r1 = Math.min(n - 1, Math.ceil(rCenter + span));
  if (c1 < c0 || r1 < r0) return { r0: 0, c0: 0, rows: 0, cols: 0 };
  return { r0, c0, rows: r1 - r0 + 1, cols: c1 - c0 + 1 };
}

/** Falloff from the brush centre. 1 at the centre, 0 at the rim.
 *
 *  Smoothstep rather than linear: a linear falloff leaves a visible
 *  crease at the rim where the gradient jumps, and sculpted terrain shows
 *  every crease as a shading edge. `hardness` (0..1) is the fraction of
 *  the radius that stays at full strength before the falloff starts, so
 *  1 is a cylinder and 0 is a full-width dome. */
export function brushWeight(dist: number, radius: number, hardness: number): number {
  if (radius <= 0) return 0;
  if (dist >= radius) return 0;
  const inner = radius * Math.min(1, Math.max(0, hardness));
  if (dist <= inner) return 1;
  if (radius - inner <= 0) return 1;
  const t = 1 - (dist - inner) / (radius - inner); // 1 at inner edge, 0 at rim
  return t * t * (3 - 2 * t);
}

export interface BrushCell {
  index: number;
  r: number;
  c: number;
  weight: number;
}

/** Visit every cell the brush covers with a non-zero weight.
 *
 *  Returns the rect visited so the caller can hand it straight to
 *  TerrainMesh.updateHeights — the brush is the only thing that knows
 *  which block moved, and recomputing it downstream would be a second
 *  copy of this arithmetic to keep in step. */
export function forEachBrushCell(
  g: GridSpec,
  x: number,
  z: number,
  radius: number,
  hardness: number,
  fn: (cell: BrushCell) => void,
): Physics.GridRect {
  const rect = brushRect(g, x, z, radius);
  const n = g.resolution;
  for (let r = rect.r0; r < rect.r0 + rect.rows; r++) {
    const cz = cellCenter(g, r);
    for (let c = rect.c0; c < rect.c0 + rect.cols; c++) {
      const cx = cellCenter(g, c);
      const w = brushWeight(Math.hypot(cx - x, cz - z), radius, hardness);
      if (w > 0) fn({ index: r * n + c, r, c, weight: w });
    }
  }
  return rect;
}
