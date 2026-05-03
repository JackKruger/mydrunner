// Deterministic procedural terrain. Server seeds it; client receives the
// seed (or the raw arrays) and reconstructs the same terrain bit-for-bit.

import { createNoise2D } from 'simplex-noise';
import { TERRAIN } from '../constants.js';

export const Surface = {
  Road: 0,
  Dirt: 1,
  Mud: 2,
  DeepMud: 3,
  Grass: 4,
  Gravel: 5,
  Concrete: 6,
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
  /** Landmark specs exposed for obstacle placement. */
  mountain: MountainSpec;
  petrolStation: PetrolStationPad;
  bogs: ReadonlyArray<{ x: number; z: number; depth: number; sigma: number }>;
  /** Configurable roads. */
  roads: Road[];
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

export interface MountainSpec {
  x: number;
  z: number;
  peak: number;
  sigma: number;
}

export function mountainFor(size: number): MountainSpec {
  return {
    x: size * TERRAIN.mtnXRatio,
    z: size * TERRAIN.mtnZRatio,
    peak: TERRAIN.mtnPeak,
    sigma: size * TERRAIN.mtnSigmaRatio,
  };
}

export interface PetrolStationPad {
  cx: number;
  cz: number;
  halfW: number;
  halfD: number;
  wingDelta: number;
  fade: number;
  yaw: number;
}

export function petrolStationPadFor(size: number): PetrolStationPad {
  return {
    cx: size * TERRAIN.padCxRatio,
    cz: TERRAIN.padCz,
    halfW: TERRAIN.padHalfW,
    halfD: TERRAIN.padHalfD,
    wingDelta: TERRAIN.padWingDelta,
    fade: TERRAIN.padFade,
    yaw: TERRAIN.padYaw,
  };
}

/** Road definition. A road is a polyline with width and surface type. */
export interface Road {
  /** Path points in world coordinates. */
  points: ReadonlyArray<{ x: number; z: number }>;
  /** Width of the road (full width, not half-width). */
  width: number;
  /** Surface type for this road. */
  surface: Surface;
  /** Shoulder width on each side where terrain eases in. */
  shoulderWidth: number;
}

/** Default straight road along z=0 (horizontal strip).
 *  Segment extends beyond map edges so the perpendicular distance
 *  equals |z| for all points within the map, matching the original
 *  behaviour where the road was infinite in X. */
function defaultRoad(size: number): Road {
  const extended = size * 2; // well beyond map edges
  return {
    points: [{ x: -extended, z: 0 }, { x: extended, z: 0 }],
    width: TERRAIN.roadCore * 2,
    surface: Surface.Road,
    shoulderWidth: TERRAIN.roadShoulder - TERRAIN.roadCore,
  };
}

// --- Height layers ---

export type HeightLayer = (
  ctx: TerrainGenContext,
  x: number,
  z: number,
  currentH: number,
) => number;

export interface TerrainGenContext {
  size: number;
  resolution: number;
  rng: () => number;
  noise: (x: number, y: number) => number;
  noiseDetail: (x: number, y: number) => number;
  mountain: MountainSpec;
  pad: PetrolStationPad;
  bogs: ReadonlyArray<{ x: number; z: number; depth: number; sigma: number }>;
  roads: Road[];
}

/** Base FBM noise with distance-based roughness. */
export const baseNoiseLayer: HeightLayer = (ctx, x, z, currentH) => {
  const az = Math.abs(z);
  const roughness = Math.min(1, Math.max(0, (az - TERRAIN.roadShoulder) / TERRAIN.roughnessDist));
  const baseAmp = TERRAIN.baseAmpMin + roughness * (TERRAIN.baseAmpMax - TERRAIN.baseAmpMin);
  let h = ctx.noise(x * TERRAIN.noiseFreq, z * TERRAIN.noiseFreq) * baseAmp;
  h += ctx.noiseDetail(x * TERRAIN.detailFreq, z * TERRAIN.detailFreq) * 0.8;
  return currentH + h;
};

/** Symmetrical mud valley hugging the road shoulder. */
export const valleyLayer: HeightLayer = (ctx, x, z, currentH) => {
  const az = Math.abs(z);
  if (az <= TERRAIN.roadShoulder) return currentH;
  const valley = Math.exp(-((az - TERRAIN.roadShoulder) ** 2) / (TERRAIN.valleySigma * TERRAIN.valleySigma)) * TERRAIN.valleyAmp;
  return currentH - valley;
};

/** Mountain peak (Gaussian). */
export const mountainLayer: HeightLayer = (ctx, x, z, currentH) => {
  const dx = x - ctx.mountain.x;
  const dz = z - ctx.mountain.z;
  const dist2 = dx * dx + dz * dz;
  const h = ctx.mountain.peak * Math.exp(-dist2 / (2 * ctx.mountain.sigma * ctx.mountain.sigma));
  return currentH + h;
};

/** Hill climb path: a switchback carved into the mountain side.
 *  The path is indented below the natural terrain so it reads as
 *  a purpose-built climb route. */
export const hillClimbLayer: HeightLayer = (ctx, x, z, currentH) => {
  const mtn = ctx.mountain;
  const baseX = mtn.x;
  const baseZ = mtn.z - mtn.sigma * 1.6;
  // Simple straight path from base to summit for now
  // TODO: replace with switchback polyline for more interesting climb
  const dx = mtn.x - baseX;
  const dz = mtn.z - baseZ;
  const len = Math.hypot(dx, dz);
  const nx = dx / len;
  const nz = dz / len;
  // Point on the centre line of the path
  const distAlong = (x - baseX) * nx + (z - baseZ) * nz;
  const distPerp = Math.abs((x - baseX) * (-nz) + (z - baseZ) * nx);
  const pathHalfWidth = 3.5; // wide enough for a truck
  const pathDist = Math.abs(distAlong);
  if (pathDist > len || distPerp > pathHalfWidth + 5) return currentH;
  // Indent: carve into the mountain so the path is below natural height
  const indent = 1.5 * Math.exp(-(distPerp ** 2) / (2 * pathHalfWidth ** 2));
  return currentH - indent;
};

/** Mud bogs (Gaussian dips). */
export const bogLayer: HeightLayer = (ctx, x, z, currentH) => {
  let h = currentH;
  for (const b of ctx.bogs) {
    const dx = x - b.x;
    const dz = z - b.z;
    h -= b.depth * Math.exp(-(dx * dx + dz * dz) / (2 * b.sigma * b.sigma));
  }
  return h;
};

/** Map-edge walls: ramp up height at the edges. */
export const edgeLayer: HeightLayer = (ctx, x, z, currentH) => {
  const half = ctx.size / 2;
  const distEdgeX = half - Math.abs(x);
  const distEdgeZ = half - Math.abs(z);
  const tEdge = (d: number): number => {
    if (d >= TERRAIN.edgeRamp) return 0;
    if (d <= 0) return 1;
    const u = 1 - d / TERRAIN.edgeRamp;
    return u * u * (3 - 2 * u);
  };
  const edgeWeight = Math.max(tEdge(distEdgeX), tEdge(distEdgeZ));
  return currentH + TERRAIN.edgeLift * edgeWeight;
};

/** Distance from a point to a line segment. */
function pointToSegmentDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

/** Road height layer - flattens terrain under roads and eases at shoulders. */
export const roadLayer: HeightLayer = (ctx, x, z, currentH) => {
  let minDist = Infinity;
  let closestRoadCoreDist = TERRAIN.roadCore;
  let closestRoadShoulderDist = TERRAIN.roadShoulder;
  for (const road of ctx.roads) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      const dist = pointToSegmentDist(x, z, a.x, a.z, b.x, b.z);
      if (dist < minDist) {
        minDist = dist;
        closestRoadCoreDist = road.width / 2;
        closestRoadShoulderDist = road.width / 2 + road.shoulderWidth;
      }
    }
  }
  if (minDist <= closestRoadCoreDist) {
    return 0; // Flat at y=0 inside road core
  }
  if (minDist < closestRoadShoulderDist) {
    // Smooth ease from 0 to natural height over shoulder
    const t = (minDist - closestRoadCoreDist) / (closestRoadShoulderDist - closestRoadCoreDist);
    const ease = t * t * (3 - 2 * t);
    return currentH * ease;
  }
  return currentH;
};

/** Petrol station pad layer - flattens pad and adjacent fade zone to y=0. */
export const padLayer: HeightLayer = (ctx, x, z, currentH) => {
  const pad = ctx.pad;
  const cosY = Math.cos(pad.yaw);
  const sinY = Math.sin(pad.yaw);
  const dx = x - pad.cx;
  const dz = z - pad.cz;
  const lx = cosY * dx + sinY * dz;
  const lz = -sinY * dx + cosY * dz;
  const wingT = Math.max(0, -lz / pad.halfD);
  const effHalfW = pad.halfW + wingT * pad.wingDelta;
  const padX = smoothFalloff(Math.abs(lx), effHalfW, pad.fade);
  const padZ = smoothFalloff(Math.abs(lz), pad.halfD, pad.fade);
  const padW = padX * padZ;
  if (padW > 0) {
    return 0; // Flat at y=0 for pad and adjacent fade zone
  }
  return currentH;
};

// --- Surface rules ---

export type SurfaceRule = (
  ctx: TerrainGenContext,
  x: number,
  z: number,
  h: number,
  currentSurf: Surface,
) => Surface;

/** Road surface rule - assigns road surface based on distance to roads. */
export const roadSurfaceRule: SurfaceRule = (ctx, x, z, h, currentSurf) => {
  let minDist = Infinity;
  let roadSurface: Surface | null = null;
  let roadCoreDist = TERRAIN.roadCore;
  let roadShoulderDist = TERRAIN.roadShoulder;
  for (const road of ctx.roads) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      const dist = pointToSegmentDist(x, z, a.x, a.z, b.x, b.z);
      if (dist < minDist) {
        minDist = dist;
        roadSurface = road.surface;
        roadCoreDist = road.width / 2;
        roadShoulderDist = road.width / 2 + road.shoulderWidth;
      }
    }
  }
  if (minDist <= roadCoreDist) {
    return roadSurface ?? Surface.Road;
  }
  if (minDist <= roadShoulderDist) {
    return Surface.Dirt;
  }
  return currentSurf;
};

/** Mountain surface rule - gravel on mountain slopes. */
export const mountainSurfaceRule: SurfaceRule = (ctx, x, z, h, currentSurf) => {
  const mtn = ctx.mountain;
  const distMtn2 = (x - mtn.x) ** 2 + (z - mtn.z) ** 2;
  const onMtn = distMtn2 < (mtn.sigma * 1.2) ** 2;
  if (onMtn && h > 4) {
    return Surface.Gravel;
  }
  return currentSurf;
};

/** Mud surface rule - based on height. */
export const mudSurfaceRule: SurfaceRule = (ctx, x, z, h, currentSurf) => {
  if (h < -0.8) return Surface.DeepMud;
  if (h < -0.2) return Surface.Mud;
  return currentSurf;
};

/** Grass surface rule - rolling mid-elevations. */
export const grassSurfaceRule: SurfaceRule = (ctx, x, z, h, currentSurf) => {
  if (h > 1.5 && h < 5) return Surface.Grass;
  return currentSurf;
};

/** Pad surface rule - concrete on the petrol station pad. */
export const padSurfaceRule: SurfaceRule = (ctx, x, z, h, currentSurf) => {
  const pad = ctx.pad;
  const cosY = Math.cos(pad.yaw);
  const sinY = Math.sin(pad.yaw);
  const dx = x - pad.cx;
  const dz = z - pad.cz;
  const lx = cosY * dx + sinY * dz;
  const lz = -sinY * dx + cosY * dz;
  const wingT = Math.max(0, -lz / pad.halfD);
  const effHalfW = pad.halfW + wingT * pad.wingDelta;
  const padX = smoothFalloff(Math.abs(lx), effHalfW, pad.fade);
  const padZ = smoothFalloff(Math.abs(lz), pad.halfD, pad.fade);
  const padW = padX * padZ;
  if (padW > 0.5) return Surface.Concrete;
  return currentSurf;
};

// --- Terrain generation ---

export interface TerrainOptions {
  size?: number;
  resolution?: number;
  seed?: number;
  /** Additional height layers (appended after defaults). */
  extraHeightLayers?: HeightLayer[];
  /** Additional surface rules (appended after defaults). */
  extraSurfaceRules?: SurfaceRule[];
  /** Custom roads (defaults to single straight road along z=0). */
  roads?: Road[];
}

const DEFAULT_HEIGHT_LAYERS: HeightLayer[] = [
  baseNoiseLayer,
  valleyLayer,
  mountainLayer,
  hillClimbLayer,
  bogLayer,
  edgeLayer,
  roadLayer,
  padLayer,
];

const DEFAULT_SURFACE_RULES: SurfaceRule[] = [
  roadSurfaceRule,
  padSurfaceRule,
  mudSurfaceRule,
  mountainSurfaceRule,
  grassSurfaceRule,
];

/** Returns 1 inside [0, halfExtent], smoothly falling to 0 over the
 *  next `fade` metres past the boundary. */
function smoothFalloff(absCoord: number, halfExtent: number, fade: number): number {
  if (absCoord <= halfExtent) return 1;
  const t = (absCoord - halfExtent) / fade;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
}

export function generateTerrain(opts: TerrainOptions = {}): TerrainData {
  const size = opts.size ?? TERRAIN.defaultSize;
  const resolution = opts.resolution ?? TERRAIN.defaultResolution;
  const seed = opts.seed ?? TERRAIN.defaultSeed;
  const rng = mulberry32(seed);
  const noise = createNoise2D(rng);
  const noiseDetail = createNoise2D(rng);

  const n = resolution;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);

  const mountain = mountainFor(size);
  const pad = petrolStationPadFor(size);
  const bogs = TERRAIN.bogs;
  const roads = opts.roads ?? [defaultRoad(size)];

  const ctx: TerrainGenContext = {
    size,
    resolution,
    rng,
    noise,
    noiseDetail,
    mountain,
    pad,
    bogs,
    roads,
  };

  const heightLayers = [...DEFAULT_HEIGHT_LAYERS, ...(opts.extraHeightLayers ?? [])];
  const surfaceRules = [...DEFAULT_SURFACE_RULES, ...(opts.extraSurfaceRules ?? [])];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c / (n - 1) - 0.5) * size;
      const z = (r / (n - 1) - 0.5) * size;

      // Apply height layers
      let h = 0;
      for (const layer of heightLayers) {
        h = layer(ctx, x, z, h);
      }
      heights[r * n + c] = h;

      // Apply surface rules
      let surf: Surface = Surface.Dirt;
      for (const rule of surfaceRules) {
        surf = rule(ctx, x, z, h, surf);
      }
      surfaces[r * n + c] = surf;
    }
  }

  return { size, resolution, heights, surfaces, seed, mountain, petrolStation: pad, bogs, roads };
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
