// Deterministic procedural terrain. Server seeds it; client receives the
// seed (or the raw arrays) and reconstructs the same terrain bit-for-bit.

import { createNoise2D } from 'simplex-noise';

export const Surface = {
  Road: 0,
  Dirt: 1,
  Mud: 2,
  DeepMud: 3,
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

export interface TerrainData {
  /** World-space size on each axis (square). */
  size: number;
  /** Samples per side. */
  resolution: number;
  /** Length resolution*resolution, row-major in (col, row). */
  heights: Float32Array;
  /** Same shape as heights, values are Surface ids. */
  surfaces: Uint8Array;
  /** Seed used to generate this terrain. */
  seed: number;
}

// Mulberry32 - tiny, seedable, good enough for procedural terrain.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TerrainOptions {
  size?: number;
  resolution?: number;
  seed?: number;
}

/** Generates a heightmap and matching surface map.
 *
 *  - Heights: FBM simplex noise, gentle hills with a flatter "valley" along z=0.
 *  - Surfaces: mud in the low areas (where water would pool), dirt in mid
 *    elevations, road as a single straight strip across X for variety.
 */
export function generateTerrain(opts: TerrainOptions = {}): TerrainData {
  const size = opts.size ?? 200;
  const resolution = opts.resolution ?? 64;
  const seed = opts.seed ?? 1337;
  const rng = mulberry32(seed);
  const noise = createNoise2D(rng);
  const noiseDetail = createNoise2D(rng);

  const n = resolution;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);

  // Frequency in noise space - smaller = bigger hills.
  const freq = 1 / 40;
  const detailFreq = 1 / 12;

  // Road geometry. The "core" is strictly flat at y=0 so vehicles spawn
  // and drive on a solid plane regardless of orientation. Outside the
  // shoulder we ease back into natural terrain.
  const roadCore = 5;       // |z| < roadCore is exactly flat at y=0
  const roadShoulder = 8;   // roadCore <= |z| < roadShoulder eases into terrain

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c / (n - 1) - 0.5) * size;
      const z = (r / (n - 1) - 0.5) * size;
      const az = Math.abs(z);

      // Base hills.
      let hNat = noise(x * freq, z * freq) * 4;
      hNat += noiseDetail(x * detailFreq, z * detailFreq) * 0.6;
      // Mud valley further from the road.
      const valley = Math.exp(-((az - roadShoulder) ** 2) / (12 * 12)) * 1.4;
      if (az > roadShoulder) hNat -= valley;

      let h: number;
      if (az < roadCore) {
        h = 0;
      } else if (az < roadShoulder) {
        // Smooth ease from 0 to natural over the shoulder band.
        const t = (az - roadCore) / (roadShoulder - roadCore);
        const ease = t * t * (3 - 2 * t); // smoothstep
        h = hNat * ease;
      } else {
        h = hNat;
      }

      const idx = r * n + c;
      heights[idx] = h;

      // Surface assignment.
      let surf: Surface = Surface.Dirt;
      if (az < roadCore) {
        surf = Surface.Road;
      } else if (az < roadShoulder) {
        surf = Surface.Dirt;
      } else if (h < -0.8) {
        surf = Surface.DeepMud;
      } else if (h < -0.2) {
        surf = Surface.Mud;
      }
      surfaces[idx] = surf;
    }
  }

  return { size, resolution, heights, surfaces, seed };
}

/** Map a world-space (x, z) to a flat index into heights/surfaces, or -1 if
 *  out of bounds. Uses nearest-neighbor sampling. */
export function worldToTerrainIndex(t: TerrainData, x: number, z: number): number {
  const n = t.resolution;
  const u = (x / t.size + 0.5) * (n - 1);
  const v = (z / t.size + 0.5) * (n - 1);
  if (u < 0 || u > n - 1 || v < 0 || v > n - 1) return -1;
  const c = Math.round(u);
  const r = Math.round(v);
  return r * n + c;
}

export function sampleSurface(t: TerrainData, x: number, z: number): Surface {
  const idx = worldToTerrainIndex(t, x, z);
  if (idx < 0) return Surface.Dirt;
  return (t.surfaces[idx] ?? Surface.Dirt) as Surface;
}
