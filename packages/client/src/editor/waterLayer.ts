// The authored water of the map being edited.
//
// Split out of EditSession rather than added to it: that file was already
// 367 lines and carries the delta/base composition rules, and water
// shares none of them. Water is ABSOLUTE, not a delta over a generated
// base — nothing in the generator makes any — so there is no rebase, no
// checksum and no drift, and mixing it into recomposeAll would have
// implied all three.
//
// Water lives on the shared TerrainData arrays, like heights and
// surfaces, so the mesh, the physics preview and the minimap all read
// the same copy the brush writes.

import { Maps, Physics } from '@mydrunner/shared';
import { forEachBrushCell, type GridSpec } from './brush.js';

const { WATER_LEVEL_SCALE, WATER_FLOW_SCALE, WATER_NONE_CM } = Maps;

export interface WaterSnapshot {
  level: Float32Array;
  flowX: Float32Array;
  flowZ: Float32Array;
}

export class WaterLayer {
  constructor(private readonly terrain: Physics.TerrainData, private readonly grid: GridSpec) {}

  /** Any water at all. Drives whether the renderer builds a mesh. */
  get hasWater(): boolean {
    return Physics.hasWater(this.terrain);
  }

  /**
   * Flood a disc to `depth` metres above the ground **at the stroke
   * centre**.
   *
   * Taking the height once at the centre rather than per cell is what
   * makes a pond flat. Per-cell would give every cell its own level and
   * produce a sheet that follows the bumps underneath — which is not a
   * body of water, it is wet ground. Dragging along a slope still grades
   * a river, because each pointer position is its own stroke centre.
   */
  paint(x: number, z: number, opts: { radius: number; depth: number }): Physics.GridRect | null {
    const level = Physics.sampleHeightBilinear(this.terrain, x, z) + opts.depth;
    const rect = forEachBrushCell(this.grid, x, z, opts.radius, 1, ({ index }) => {
      // Never lower existing water: overlapping strokes along a river
      // would otherwise cut notches out of the surface they just laid.
      const cur = this.terrain.waterLevel[index]!;
      this.terrain.waterLevel[index] = Physics.isWet(cur) ? Math.max(cur, level) : level;
    });
    return rect.rows > 0 ? rect : null;
  }

  erase(x: number, z: number, opts: { radius: number }): Physics.GridRect | null {
    const rect = forEachBrushCell(this.grid, x, z, opts.radius, 1, ({ index }) => {
      this.terrain.waterLevel[index] = Physics.WATER_NONE;
      this.terrain.waterFlowX[index] = 0;
      this.terrain.waterFlowZ[index] = 0;
    });
    return rect.rows > 0 ? rect : null;
  }

  /** Stamp a flow direction over the wet cells under the brush.
   *
   *  Dry cells are skipped: flow with no water is invisible, unsimulated
   *  and would silently become a current the moment someone flooded the
   *  cell later. */
  flow(
    x: number,
    z: number,
    opts: { radius: number; dirX: number; dirZ: number; speed: number },
  ): Physics.GridRect | null {
    const len = Math.hypot(opts.dirX, opts.dirZ);
    if (len < 1e-6) return null;
    const fx = (opts.dirX / len) * opts.speed;
    const fz = (opts.dirZ / len) * opts.speed;
    const rect = forEachBrushCell(this.grid, x, z, opts.radius, 1, ({ index }) => {
      if (!Physics.isWet(this.terrain.waterLevel[index]!)) return;
      this.terrain.waterFlowX[index] = fx;
      this.terrain.waterFlowZ[index] = fz;
    });
    return rect.rows > 0 ? rect : null;
  }

  /**
   * Fill the whole flow field from the slope of the water surface.
   *
   * The water surface, not the bed. A river painted down a hillside has
   * a surface that descends downstream, so its gradient is the flow
   * direction — and a pond, whose surface is flat by construction, comes
   * out still. Using the bed instead would give a pond a current wherever
   * its bottom happened to slope, which is exactly wrong.
   *
   * One click for a whole mountain stream; the flow brush is for fixing
   * up the places where the authored grade is too gentle to read.
   */
  autoFlowFromSlope(speed: number): Physics.GridRect | null {
    const n = this.terrain.resolution;
    const cell = this.terrain.size / (n - 1);
    const level = this.terrain.waterLevel;
    let any = false;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        if (!Physics.isWet(level[i]!)) continue;
        any = true;
        // Central difference over wet neighbours; a dry neighbour falls
        // back to this cell so the shoreline does not read as a cliff.
        const here = level[i]!;
        const wetAt = (rr: number, cc: number): number => {
          if (rr < 0 || rr >= n || cc < 0 || cc >= n) return here;
          const v = level[rr * n + cc]!;
          return Physics.isWet(v) ? v : here;
        };
        const gx = (wetAt(r, c + 1) - wetAt(r, c - 1)) / (2 * cell);
        const gz = (wetAt(r + 1, c) - wetAt(r - 1, c)) / (2 * cell);
        // Downhill is the negative gradient.
        const mag = Math.hypot(gx, gz);
        if (mag < 1e-5) {
          this.terrain.waterFlowX[i] = 0;
          this.terrain.waterFlowZ[i] = 0;
          continue;
        }
        // Steeper water runs faster, capped at the requested speed so one
        // slider still means "how fast is this river".
        const scale = Math.min(1, mag / 0.02) * speed;
        this.terrain.waterFlowX[i] = (-gx / mag) * scale;
        this.terrain.waterFlowZ[i] = (-gz / mag) * scale;
      }
    }
    return any ? Physics.fullGridRect(this.terrain) : null;
  }

  snapshot(): WaterSnapshot {
    return {
      level: Float32Array.from(this.terrain.waterLevel),
      flowX: Float32Array.from(this.terrain.waterFlowX),
      flowZ: Float32Array.from(this.terrain.waterFlowZ),
    };
  }

  restore(s: WaterSnapshot): void {
    this.terrain.waterLevel.set(s.level);
    this.terrain.waterFlowX.set(s.flowX);
    this.terrain.waterFlowZ.set(s.flowZ);
  }

  /** Encode for the document, quantised exactly as applyMapDoc decodes. */
  toDoc(): Maps.MapDoc['water'] {
    const n = this.terrain.resolution;
    const level = new Int16Array(n * n);
    const flowX = new Int16Array(n * n);
    const flowZ = new Int16Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const lv = this.terrain.waterLevel[i]!;
      level[i] = Physics.isWet(lv)
        ? clampInt16(Math.round(lv * WATER_LEVEL_SCALE))
        : WATER_NONE_CM;
      flowX[i] = clampInt16(Math.round((this.terrain.waterFlowX[i] ?? 0) * WATER_FLOW_SCALE));
      flowZ[i] = clampInt16(Math.round((this.terrain.waterFlowZ[i] ?? 0) * WATER_FLOW_SCALE));
    }
    return {
      level: Maps.encodeInt16Grid(level, n, WATER_NONE_CM),
      flowX: Maps.encodeInt16Grid(flowX, n),
      flowZ: Maps.encodeInt16Grid(flowZ, n),
    };
  }
}

/** WATER_NONE_CM is int16's most-negative value, so a real level must
 *  stay strictly above it or a deep pond would decode as dry ground. */
function clampInt16(v: number): number {
  return v < -32767 ? -32767 : v > 32767 ? 32767 : v;
}
