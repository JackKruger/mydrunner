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
  /** When true, the road core does NOT flatten to h=0 — instead it sits
   *  as a worn track ~1 m below natural terrain. Use this for dirt
   *  trails that climb elevated ground (e.g. up the mountain base) so
   *  the trail follows the slope rather than cutting a flat plane and
   *  leaving slot-canyon walls on either side. Defaults to false: the
   *  main asphalt road still carves perfectly flat. */
  gradeIntoTerrain?: boolean;
}

/** Default straight road along z = TERRAIN.roadZ (horizontal strip).
 *  Segment extends beyond map edges so the perpendicular distance
 *  equals |z - roadZ| for all points within the map, matching the
 *  original behaviour where the road was infinite in X. */
function defaultRoad(size: number): Road {
  const extended = size * 2; // well beyond map edges
  const z = TERRAIN.roadZ;
  return {
    points: [{ x: -extended, z }, { x: extended, z }],
    width: TERRAIN.roadCore * 2,
    surface: Surface.Road,
    shoulderWidth: TERRAIN.roadShoulder - TERRAIN.roadCore,
  };
}

/** Dirt connector from the main road up to the start of traverse 1.
 *  gradeIntoTerrain=true keeps the trail surface following the natural
 *  rise of the mountain base instead of cutting a slot canyon into it. */
function mountainTrail(size: number): Road {
  const mtn = mountainFor(size);
  const baseX = mtn.x - 15; // aligns with traverse-1 start x
  const baseZ = mtn.z - mtn.sigma * 1.6; // trail base z
  return {
    points: [{ x: baseX, z: TERRAIN.roadZ }, { x: baseX, z: baseZ }],
    width: 6,
    surface: Surface.Dirt,
    shoulderWidth: 2,
    gradeIntoTerrain: true,
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

/** Base FBM noise with distance-based roughness (measured from the main road). */
export const baseNoiseLayer: HeightLayer = (ctx, x, z, currentH) => {
  const az = Math.abs(z - TERRAIN.roadZ);
  const roughness = Math.min(1, Math.max(0, (az - TERRAIN.roadShoulder) / TERRAIN.roughnessDist));
  const baseAmp = TERRAIN.baseAmpMin + roughness * (TERRAIN.baseAmpMax - TERRAIN.baseAmpMin);
  let h = ctx.noise(x * TERRAIN.noiseFreq, z * TERRAIN.noiseFreq) * baseAmp;
  h += ctx.noiseDetail(x * TERRAIN.detailFreq, z * TERRAIN.detailFreq) * 0.8;
  return currentH + h;
};

/** Symmetrical mud valley hugging the main road shoulder. */
export const valleyLayer: HeightLayer = (ctx, x, z, currentH) => {
  const az = Math.abs(z - TERRAIN.roadZ);
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

export const HILL_CLIMB_PATH_HALF_WIDTH = 3.5;

/** Returns the switchback segments for the hill-climb trail.
 *  Exported so the ASCII map visualiser and obstacle placer can use them.
 *
 *  Design: 4 long traverses + 1 final approach.  Each traverse grade was
 *  verified ≤ 30 % (≈ 17°) against a Gaussian mountain with the constants
 *  in TERRAIN.mtnPeak / mtnSigmaRatio / mtnZRatio.  Traverses alternate
 *  east and west so the trail zigzags up the southern face like a real
 *  mountain road.  The switchback turn-arounds are implicit — the vehicle
 *  just brakes and reverses direction at each segment endpoint. */
export function getHillClimbSegments(mtn: MountainSpec): Array<{ ax: number; az: number; bx: number; bz: number }> {
  return [
    // Traverse 1 — east across the lower face (~18 % grade)
    { ax: mtn.x - 15, az: mtn.z - mtn.sigma * 1.6, bx: mtn.x + 38, bz: mtn.z - mtn.sigma * 1.2 },
    // Traverse 2 — west across the mid-lower face (~27 % grade)
    { ax: mtn.x + 38, az: mtn.z - mtn.sigma * 1.2, bx: mtn.x - 30, bz: mtn.z - mtn.sigma * 0.8 },
    // Traverse 3 — east across the mid-upper face (~20 % grade)
    { ax: mtn.x - 30, az: mtn.z - mtn.sigma * 0.8, bx: mtn.x + 30, bz: mtn.z - mtn.sigma * 0.45 },
    // Traverse 4 — west toward the near-summit ledge (~32 % grade, acceptable)
    { ax: mtn.x + 30, az: mtn.z - mtn.sigma * 0.45, bx: mtn.x - 10, bz: mtn.z - mtn.sigma * 0.12 },
    // Final approach — short diagonal to summit (~13 % grade over lookout)
    { ax: mtn.x - 10, az: mtn.z - mtn.sigma * 0.12, bx: mtn.x, bz: mtn.z },
  ];
}

/** Hill climb path: switchback carved into the mountain side.
 *  The path is indented below natural terrain. */
export const hillClimbLayer: HeightLayer = (ctx, x, z, currentH) => {
  const segments = getHillClimbSegments(ctx.mountain);
  let minDist = Infinity;
  for (const seg of segments) {
    const dist = pointToSegmentDist(x, z, seg.ax, seg.az, seg.bx, seg.bz);
    minDist = Math.min(minDist, dist);
  }
  if (minDist > HILL_CLIMB_PATH_HALF_WIDTH + 5) return currentH;
  const indent = 2.0 * Math.exp(-(minDist ** 2) / (2 * HILL_CLIMB_PATH_HALF_WIDTH ** 2));
  return currentH - indent;
};

/** Summit lookout plateau: flattens a small disc at the peak so there is
 *  a clear destination for the climb rather than a knife-edge. */
export const lookoutLayer: HeightLayer = (ctx, x, z, currentH) => {
  const mtn = ctx.mountain;
  const dist = Math.hypot(x - mtn.x, z - mtn.z);
  const r = TERRAIN.lookoutRadius;
  if (dist > r) return currentH;
  const plateau = mtn.peak - 3;
  const t = dist / r;
  const blend = t * t * (3 - 2 * t); // smoothstep: flat at centre, natural at edge
  return plateau + (currentH - plateau) * blend;
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
export function pointToSegmentDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
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

/** Road height layer - flattens terrain under roads and eases at shoulders.
 *
 *  Core check is done independently per road: a point in the core of any
 *  road is flat regardless of whether a narrower road is geometrically
 *  closer. Without this, the mountain trail's narrow shoulder can shadow
 *  the main road's wider core for points near the trail but well inside
 *  the main road's flat zone (e.g. spawn corridor at |z| < roadCore). */
// gradeIntoTerrain road semantics:
//   currentH ≤ GRADED_FLAT_BELOW: trail core flattens to h=0 (dirt road on
//     low ground, no rut walls, smooth blend with surrounding terrain).
//   GRADED_FLAT_BELOW < currentH ≤ GRADED_FLAT_BELOW + GRADED_BLEND_RANGE:
//     trail core blends from 0 toward natural terrain. This is the
//     transition zone where the trail starts climbing the mountain base.
//   currentH > GRADED_FLAT_BELOW + GRADED_BLEND_RANGE: trail core is the
//     natural terrain (no flatten, no rut) — surface stays painted Dirt
//     by roadSurfaceRule, so visually it's a worn dirt path on the slope
//     rather than a carved-flat shelf.
const GRADED_FLAT_BELOW = 4.0;
const GRADED_BLEND_RANGE = 8.0;

export const roadLayer: HeightLayer = (ctx, x, z, currentH) => {
  // First pass: any flat-carving road (gradeIntoTerrain=false) wins outright
  // when the point is in its core, regardless of whether a graded trail is
  // geometrically closer. Without this, the dirt connector's narrow core
  // can shadow the asphalt road's wider core for points just inside the
  // trail's flat zone.
  for (const road of ctx.roads) {
    if (road.gradeIntoTerrain) continue;
    const halfCore = road.width / 2;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      const dist = pointToSegmentDist(x, z, a.x, a.z, b.x, b.z);
      if (dist <= halfCore) return 0;
    }
  }

  // Second pass: shoulders + graded trails. Track the lowest blended height
  // across all roads.
  let best = currentH;
  for (const road of ctx.roads) {
    const halfCore = road.width / 2;
    const halfShoulder = halfCore + road.shoulderWidth;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      const dist = pointToSegmentDist(x, z, a.x, a.z, b.x, b.z);
      if (road.gradeIntoTerrain) {
        // Compute the trail's target height at currentH. Below the flat
        // threshold we force h=0 (smooth dirt road); above, we blend
        // smoothly toward natural h so the trail follows the slope without
        // a step or rut wall.
        let trailH: number;
        if (currentH <= GRADED_FLAT_BELOW) {
          trailH = 0;
        } else if (currentH <= GRADED_FLAT_BELOW + GRADED_BLEND_RANGE) {
          const t = (currentH - GRADED_FLAT_BELOW) / GRADED_BLEND_RANGE;
          const ease = t * t * (3 - 2 * t);
          trailH = currentH * ease;
        } else {
          trailH = currentH;
        }
        if (dist <= halfCore) {
          if (trailH < best) best = trailH;
        } else if (dist < halfShoulder) {
          // Shoulder fades from trailH at the core edge back to natural
          // currentH at the outer edge — no fresh cliff at core boundary.
          const t = (dist - halfCore) / (halfShoulder - halfCore);
          const ease = t * t * (3 - 2 * t);
          const blended = trailH + (currentH - trailH) * ease;
          if (blended < best) best = blended;
        }
      } else {
        // Asphalt-style: shoulder eases natural terrain down toward 0.
        // (Core handled in the first pass.)
        if (dist > halfCore && dist < halfShoulder) {
          const t = (dist - halfCore) / (halfShoulder - halfCore);
          const ease = t * t * (3 - 2 * t);
          const blended = currentH * ease;
          if (blended < best) best = blended;
        }
      }
    }
  }
  return best;
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

/** Lookout surface rule - gravel on the summit plateau. */
export const lookoutSurfaceRule: SurfaceRule = (ctx, x, z, h, currentSurf) => {
  const mtn = ctx.mountain;
  if (Math.hypot(x - mtn.x, z - mtn.z) < TERRAIN.lookoutRadius) return Surface.Gravel;
  return currentSurf;
};

/** Mud surface rule - based on height. Skips man-made surfaces so the
 *  graded dirt trail (which sits ~1m below natural terrain by design)
 *  doesn't suddenly turn to mud when natural h dips below the threshold. */
export const mudSurfaceRule: SurfaceRule = (ctx, x, z, h, currentSurf) => {
  if (
    currentSurf === Surface.Road ||
    currentSurf === Surface.Dirt ||
    currentSurf === Surface.Concrete
  ) {
    return currentSurf;
  }
  if (h < -0.8) return Surface.DeepMud;
  if (h < -0.2) return Surface.Mud;
  return currentSurf;
};

/** Grass surface rule - rolling mid-elevations. */
export const grassSurfaceRule: SurfaceRule = (ctx, x, z, h, currentSurf) => {
  // Don't repaint man-made surfaces (the graded trail in particular).
  if (
    currentSurf === Surface.Road ||
    currentSurf === Surface.Dirt ||
    currentSurf === Surface.Concrete
  ) {
    return currentSurf;
  }
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
  /** Custom roads (defaults to a single straight road along z = TERRAIN.roadZ
   *  plus a short dirt connector to the mountain trail). */
  roads?: Road[];
}

const DEFAULT_HEIGHT_LAYERS: HeightLayer[] = [
  baseNoiseLayer,
  valleyLayer,
  mountainLayer,
  hillClimbLayer,
  lookoutLayer,
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
  lookoutSurfaceRule,
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
  const roads = opts.roads ?? [defaultRoad(size), mountainTrail(size)];

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

/** Bilinearly interpolated terrain height at an arbitrary world-space point.
 *  More accurate than nearest-neighbour on slopes — avoids floating rocks. */
export function sampleHeightBilinear(t: TerrainData, x: number, z: number): number {
  const n = t.resolution;
  const u = (x / t.size + 0.5) * (n - 1);
  const v = (z / t.size + 0.5) * (n - 1);
  if (u < 0 || u > n - 1 || v < 0 || v > n - 1) return 0;
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const c1 = Math.min(c0 + 1, n - 1);
  const r1 = Math.min(r0 + 1, n - 1);
  const fu = u - c0;
  const fv = v - r0;
  const h00 = t.heights[r0 * n + c0] ?? 0;
  const h10 = t.heights[r0 * n + c1] ?? 0;
  const h01 = t.heights[r1 * n + c0] ?? 0;
  const h11 = t.heights[r1 * n + c1] ?? 0;
  return h00 * (1 - fu) * (1 - fv) + h10 * fu * (1 - fv) + h01 * (1 - fu) * fv + h11 * fu * fv;
}

export function sampleSurface(t: TerrainData, x: number, z: number): Surface {
  const idx = worldToTerrainIndex(t, x, z);
  if (idx < 0) return Surface.Dirt;
  return (t.surfaces[idx] ?? Surface.Dirt) as Surface;
}

const SURFACE_MAP_LEGEND = [
  'SURFACE MAP  (north = top)',
  '  R = Road (tarmac)         D = Dirt road / shoulder',
  '  M = Mud                   m = Deep mud',
  '  G = Grass                 g = Gravel (mountain)',
  '  C = Concrete (petrol pad) B = Mud bog',
  '  ~ = Hill-climb trail      S = Spawn zone (west road end)',
  '  X = Petrol station        A = Mountain summit',
  '  . = Open terrain',
  '',
].join('\n');

/** Generate ASCII surface map for debugging/visualization.
 *  Step defaults to 2 m giving ~size/2 chars per axis on a 320 m world.
 *  @param step - sample spacing in world units */
export function asciiSurfaceMap(t: TerrainData, step = 2): string {
  const half = t.size / 2;
  const trailSegs = getHillClimbSegments(t.mountain);

  // Spawn zone: first 8 slots × 5 m from west edge inset 24 m (matches room.ts).
  const spawnXStart = -t.size / 2 + 24;
  const spawnXEnd = spawnXStart + 40;

  const lines: string[] = [];
  for (let z = half; z >= -half; z -= step) {
    let line = '';
    for (let x = -half; x <= half; x += step) {
      const surf = sampleSurface(t, x, z);
      const idx = worldToTerrainIndex(t, x, z);
      let ch = '.';

      if (idx >= 0) {
        // Base surface glyph.
        switch (surf) {
          case Surface.Road:    ch = 'R'; break;
          case Surface.Dirt:    ch = 'D'; break;
          case Surface.Mud:     ch = 'M'; break;
          case Surface.DeepMud: ch = 'm'; break;
          case Surface.Grass:   ch = 'G'; break;
          case Surface.Gravel:  ch = 'g'; break;
          case Surface.Concrete: ch = 'C'; break;
          default:              ch = '.'; break;
        }

        // Bog centres (full sigma radius).
        for (const b of t.bogs) {
          if (Math.hypot(x - b.x, z - b.z) < b.sigma) { ch = 'B'; break; }
        }

        // Hill-climb trail (explicit polyline rasterisation).
        let minTrail = Infinity;
        for (const seg of trailSegs) {
          minTrail = Math.min(minTrail, pointToSegmentDist(x, z, seg.ax, seg.az, seg.bx, seg.bz));
        }
        if (minTrail < HILL_CLIMB_PATH_HALF_WIDTH) ch = '~';

        // Spawn zone (on road, west end).
        if (x >= spawnXStart && x <= spawnXEnd && Math.abs(z - TERRAIN.roadZ) < 3) ch = 'S';

        // Petrol station pad.
        const pad = t.petrolStation;
        if (Math.hypot(x - pad.cx, z - pad.cz) < pad.halfW + pad.fade) ch = 'X';

        // Mountain summit — tight dot so only the peak reads as A.
        const mtn = t.mountain;
        if (Math.hypot(x - mtn.x, z - mtn.z) < mtn.sigma * 0.18) ch = 'A';
      }

      line += ch;
    }
    lines.push(line);
  }
  return SURFACE_MAP_LEGEND + lines.join('\n');
}

const HEIGHT_MAP_LEGEND = [
  'HEIGHT MAP  (north = top)',
  '  Elevation low → high:  " " . - = + * # % @ ~',
  '',
].join('\n');

/** Generate ASCII height map (showing relative elevation).
 *  @param step - sample spacing in world units */
export function asciiHeightMap(t: TerrainData, step = 2): string {
  const half = t.size / 2;
  const n = t.resolution;
  // Find min/max height
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < n * n; i++) {
    const h = t.heights[i]!;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const range = maxH - minH || 1;
  const chars = ' .-=+*#%@~';
  const lines: string[] = [];
  for (let z = half; z >= -half; z -= step) {
    let line = '';
    for (let x = -half; x <= half; x += step) {
      const idx = worldToTerrainIndex(t, x, z);
      if (idx < 0) { line += ' '; continue; }
      const h = t.heights[idx]!;
      const norm = (h - minH) / range;
      const ci = Math.min(chars.length - 1, Math.floor(norm * chars.length));
      line += chars[ci]!;
    }
    lines.push(line);
  }
  return HEIGHT_MAP_LEGEND + lines.join('\n');
}
