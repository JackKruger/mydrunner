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

/** The single landmark mountain. Exposed so the obstacle generator can
 *  place rocks on its slope without duplicating the placement formula. */
export interface MountainSpec {
  x: number;
  z: number;
  peak: number;
  sigma: number;
}

export function mountainFor(size: number): MountainSpec {
  return { x: size * 0.22, z: size * 0.28, peak: 32, sigma: size * 0.11 };
}

/** Generates a heightmap and matching surface map.
 *
 *  Layout:
 *    - Road: flat strip along z=0, easing into terrain across the shoulder.
 *    - Hills: FBM simplex noise. Amplitude grows the further off-road
 *      you go so the area near the road is gentle and the wilds get rough.
 *    - Mountain: one prominent Gaussian peak in the upper quadrant -
 *      something to drive towards / try to climb.
 *    - Mud bogs: a handful of Gaussian dips scattered off-road, so mud
 *      isn't only the symmetrical valleys hugging the road.
 *    - Surfaces: road inside the core; dirt elsewhere except low spots
 *      (h < -0.2 = mud, h < -0.8 = deep mud) and the mountain summit
 *      (h > 9 = bare dirt regardless of mud thresholds).
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

  // Mountain: single big landmark. Centered off-road in the upper quadrant
  // so it reads as a destination from the road.
  const mtn = mountainFor(size);
  const mtnCx = mtn.x;
  const mtnCz = mtn.z;
  const mtnPeak = mtn.peak;
  const mtnSigma = mtn.sigma;

  // Mud bogs: a few Gaussian dips so mud isn't just the radial valleys.
  // Positions are deterministic from the seed so client + server agree.
  const bogs: { x: number; z: number; depth: number; sigma: number }[] = [];
  const bogCount = 5;
  for (let i = 0; i < bogCount; i++) {
    // Place between 25m and (size/2 - 25m) of the centerline, on one side
    // or the other, with x spread across the world.
    const side = rng() < 0.5 ? -1 : 1;
    const z = side * (25 + rng() * (size / 2 - 50));
    const x = (rng() - 0.5) * (size - 50);
    // Skip if too close to mountain.
    const dxMtn = x - mtnCx;
    const dzMtn = z - mtnCz;
    if (Math.hypot(dxMtn, dzMtn) < mtnSigma * 1.5) continue;
    bogs.push({ x, z, depth: 1.3 + rng() * 1.0, sigma: 6 + rng() * 5 });
  }

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c / (n - 1) - 0.5) * size;
      const z = (r / (n - 1) - 0.5) * size;
      const az = Math.abs(z);

      // Distance-from-road amplitude scaling: gentle near the shoulder,
      // rougher further out. Saturates around 1.0 past 60m off-road.
      const roughness = Math.min(1, Math.max(0, (az - roadShoulder) / 60));
      const baseAmp = 3 + roughness * 5; // 3..8m hills
      let hNat = noise(x * freq, z * freq) * baseAmp;
      hNat += noiseDetail(x * detailFreq, z * detailFreq) * 0.8;

      // Symmetrical mud valley hugging the road shoulder.
      const valley = Math.exp(-((az - roadShoulder) ** 2) / (12 * 12)) * 1.4;
      if (az > roadShoulder) hNat -= valley;

      // Mountain peak.
      const dxM = x - mtnCx;
      const dzM = z - mtnCz;
      const distM2 = dxM * dxM + dzM * dzM;
      hNat += mtnPeak * Math.exp(-distM2 / (2 * mtnSigma * mtnSigma));

      // Mud bogs (subtract).
      for (const b of bogs) {
        const dx = x - b.x;
        const dz = z - b.z;
        hNat -= b.depth * Math.exp(-(dx * dx + dz * dz) / (2 * b.sigma * b.sigma));
      }

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

      // Surface assignment. Mountain summit stays dirt even at depths the
      // mud thresholds would normally claim (heightfield is what it is,
      // but a mountain peak shouldn't be mud).
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
