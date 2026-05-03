// Rut accumulator. Server tracks per-cell depth deltas as vehicles drive
// over mud surfaces; periodically the deltas are applied to the heightmap,
// the Rapier collider is rebuilt, and the changes are broadcast to clients.
//
// Only cells whose surface is Mud or DeepMud erode. Roads and dirt stay put.

import { Surface, type TerrainData, worldToTerrainIndex } from './terrain.js';
import { RUT_RATE, RUT_MAX_DEPTH } from '../constants.js';

export interface RutCellDelta {
  /** Index into terrain.heights / .surfaces. */
  i: number;
  /** Amount the height was lowered this batch (positive number). */
  dy: number;
}

export class RutBuffer {
  /** Per-cell pending delta (not yet applied to heightmap). */
  private pending: Float32Array;
  /** Per-cell total depth already applied since terrain creation. Used to
   *  cap erosion at RUT_MAX_DEPTH per cell. */
  private applied: Float32Array;
  private terrain: TerrainData;

  constructor(terrain: TerrainData) {
    this.terrain = terrain;
    this.pending = new Float32Array(terrain.heights.length);
    this.applied = new Float32Array(terrain.heights.length);
  }

  /** Record a wheel pass at world position (x, z) with the given slip
   *  factor in [0, 1]. No-op on non-mud cells. */
  recordWheel(x: number, z: number, slip: number, contact: boolean): void {
    if (!contact || slip <= 0) return;
    const idx = worldToTerrainIndex(this.terrain, x, z);
    if (idx < 0) return;
    const surf = this.terrain.surfaces[idx];
    if (surf !== Surface.Mud && surf !== Surface.DeepMud) return;
    const mult = surf === Surface.DeepMud ? 1.6 : 1.0;
    this.pending[idx]! += RUT_RATE * slip * mult;
  }

  /** Drain pending into the actual heightmap, capped by RUT_MAX_DEPTH per
   *  cell. Returns the list of changed cells for broadcast. */
  flush(): RutCellDelta[] {
    const out: RutCellDelta[] = [];
    for (let i = 0; i < this.pending.length; i++) {
      const want = this.pending[i] ?? 0;
      if (want < 1e-4) continue;
      const already = this.applied[i] ?? 0;
      const headroom = RUT_MAX_DEPTH - already;
      const dy = Math.min(want, Math.max(0, headroom));
      if (dy <= 0) {
        this.pending[i] = 0;
        continue;
      }
      this.terrain.heights[i] = (this.terrain.heights[i] ?? 0) - dy;
      this.applied[i] = already + dy;
      this.pending[i] = 0;
      out.push({ i, dy });
    }
    return out;
  }
}
