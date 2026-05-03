// Hand-placed obstacles. The map is fixed: every rock, tree, and pine
// has explicit world coordinates so we know exactly what's where, no
// surprise spawn-into-rock bugs and no rocks landing inside the petrol
// station pad. Y values are sampled from the heightfield so obstacles
// sit on the terrain regardless of which seed the heights came from.
//
// Coordinates are in world space (the map is 320 m square, centred on
// the origin). Avoid placing obstacles inside the pad rectangle
// roughly x = -78..-50, z = -2..32, or in the road core z = -8..8.

import RAPIER from '@dimforge/rapier3d-compat';
import {
  Surface, type TerrainData, worldToTerrainIndex,
  getHillClimbSegments, pointToSegmentDist, HILL_CLIMB_PATH_HALF_WIDTH,
} from './terrain.js';

// Simple seeded RNG for deterministic obstacle placement
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ObstacleKind = 'rock' | 'tree' | 'pine' | 'ramp' | 'flagpole';

export interface Obstacle {
  kind: ObstacleKind;
  x: number;
  y: number;
  z: number;
  // Per-kind meaning: rock = radius; tree/pine = trunk radius;
  //                   ramp = half-width (perpendicular to driving dir).
  size: number;
  // Per-kind meaning: tree/pine = total height; ramp = rise of the
  //                   high edge above the low edge; rocks ignore.
  height: number;
  yaw: number;
  // Ramp only: full length along the driving direction (pre-yaw, local X).
  length?: number;
}

// Compact tuple format to keep the data tables readable.
type RockSpec = readonly [x: number, z: number, size: number];
type TreeSpec = readonly [x: number, z: number, size: number, height: number];

// Medium rocks scattered through the open zones. Avoid road, pad,
// mountain summit, perimeter band.
const ROCKS_MEDIUM: readonly RockSpec[] = [
  [-130, 30, 1.2], [-118, 48, 0.8], [-95, 38, 1.5], [-110, -28, 1.0],
  [-50, -50, 1.1], [-30, -65, 0.9], [-15, -30, 1.3], [25, -55, 1.0],
  [55, -25, 0.7], [80, -55, 1.3], [110, -50, 1.4], [140, -20, 1.0],
  [130, 30, 0.9], [105, 65, 1.2], [40, 55, 0.8], [-10, 60, 1.0],
  [-30, 80, 1.0], [-50, 110, 1.2], [60, -85, 1.5], [115, 100, 0.9],
  [50, 120, 1.1], [-20, 130, 1.3], [-90, 100, 1.0], [-130, 100, 0.8],
  [-130, -50, 1.1], [-65, -100, 1.2], [10, -95, 0.9], [85, -110, 1.3],
  [125, -90, 0.8], [55, 90, 1.0], [80, 130, 1.2], [-95, -130, 1.0],
];

// Smaller decorative rocks. Same constraints; denser.
const ROCKS_SMALL: readonly RockSpec[] = [
  [-128, 22, 0.3], [-122, 36, 0.25], [-105, 26, 0.35], [-100, 50, 0.28],
  [-86, 46, 0.32], [-78, 60, 0.25], [-60, 35, 0.3], [-44, 55, 0.28],
  [-22, 38, 0.25], [-10, 50, 0.3], [8, 35, 0.32], [22, 50, 0.28],
  [40, 38, 0.25], [62, 55, 0.3], [78, 38, 0.25], [95, 55, 0.32],
  [110, 38, 0.28], [125, 55, 0.25], [140, 30, 0.3],
  [-128, -22, 0.28], [-110, -36, 0.3], [-95, -22, 0.25], [-80, -45, 0.32],
  [-65, -25, 0.3], [-48, -42, 0.28], [-30, -25, 0.25], [-12, -42, 0.3],
  [5, -25, 0.32], [22, -42, 0.28], [40, -25, 0.3], [55, -42, 0.25],
  [72, -25, 0.32], [88, -42, 0.3], [105, -25, 0.28], [120, -42, 0.25],
  [-130, 70, 0.3], [-100, 80, 0.28], [-60, 90, 0.25], [-20, 100, 0.3],
  [25, 95, 0.32], [60, 105, 0.28], [100, 110, 0.3], [130, 95, 0.25],
  [-130, -75, 0.3], [-90, -90, 0.28], [-50, -85, 0.25], [-10, -100, 0.3],
  [30, -95, 0.32], [70, -105, 0.28], [110, -85, 0.3], [135, -100, 0.25],
];

// Standalone trees - smaller than the forest pines, scattered.
const TREES: readonly TreeSpec[] = [
  [-120, 38, 0.22, 4.2], [-100, 60, 0.20, 3.6], [-58, 48, 0.24, 4.5],
  [-25, 45, 0.18, 3.4], [12, 52, 0.22, 4.1], [45, 40, 0.20, 3.8],
  [85, 50, 0.24, 4.4], [120, 42, 0.21, 3.9], [-115, -60, 0.22, 4.0],
  [-75, -55, 0.20, 3.6], [-30, -75, 0.22, 4.2], [20, -65, 0.20, 3.8],
  [60, -75, 0.24, 4.4], [105, -65, 0.21, 4.0], [135, 65, 0.22, 4.2],
];

// Wheel-articulation test fixtures: short tilted planks the truck
// drives over to flex the suspension. The plank is rotated around its
// own length axis so one long edge sits on the ground and the other
// rises by `rise` metres - driving onto it puts the left wheels at one
// height and the right wheels at another, twisting the chassis.
//
// Placed just east of the spawn cluster (spawn x ranges from -136 to
// -101), one truck-length north of the road, on natural ground so it's
// reachable in a couple of seconds without driving on the pad.
interface RampSpec {
  x: number;
  z: number;
  length: number; // along the truck's driving direction (local X pre-yaw)
  width: number;  // perpendicular (local Z pre-yaw)
  rise: number;   // high edge sits this far above the low edge
  yaw: number;    // 0 = length along world +X
}
const FLEX_RAMPS: readonly RampSpec[] = [
  // Close to the spawn lanes (spawn x: -136..-101, lanes z = +/-1.2)
  // so it's the first off-road thing the player sees driving forward.
  { x: -90, z: 9, length: 4.0, width: 3.0, rise: 1.0, yaw: 0 },
];

// Pine forest centred around (-90, 60). Hand-placed cluster in a
// rough disc of radius ~32m, denser at the centre.
const FOREST_PINES: readonly TreeSpec[] = [
  [-90, 60, 1.0, 18], [-86, 64, 0.9, 16], [-94, 56, 1.1, 19],
  [-82, 58, 1.0, 17], [-98, 64, 0.95, 18], [-88, 70, 0.9, 16],
  [-92, 50, 1.0, 17], [-78, 64, 1.05, 19], [-102, 58, 0.9, 16],
  [-84, 50, 1.0, 18], [-100, 70, 1.0, 17], [-76, 56, 0.9, 16],
  [-106, 52, 0.95, 17], [-72, 70, 1.0, 18], [-110, 64, 0.9, 16],
  [-68, 50, 1.0, 17], [-110, 76, 0.95, 18], [-96, 78, 1.0, 17],
  [-82, 78, 0.9, 16], [-66, 62, 1.0, 18], [-80, 44, 1.0, 17],
  [-100, 44, 0.9, 16], [-114, 44, 1.0, 18], [-114, 88, 0.95, 17],
  [-90, 84, 1.0, 18], [-66, 76, 0.9, 16], [-118, 56, 1.0, 17],
  [-118, 70, 0.95, 18], [-72, 84, 0.9, 16], [-60, 56, 1.0, 17],
  [-58, 70, 1.0, 18], [-100, 90, 0.9, 16], [-86, 88, 1.0, 17],
  [-122, 60, 0.95, 18], [-104, 80, 1.0, 17],
];

// Hill-climb boulders: corridor walls flanking each switchback segment +
// dense off-trail scatter across the mountain face.  Fully deterministic —
// no Math.random() used anywhere in here.
function hillClimbBoulders(terrain: TerrainData): Obstacle[] {
  const out: Obstacle[] = [];
  const mtn = terrain.mountain;
  const rng = mulberry32(Math.round(mtn.x) * 1000 + Math.round(mtn.z) * 7 + 42);
  const segments = getHillClimbSegments(mtn);

  const minDistToTrail = (x: number, z: number): number => {
    let d = Infinity;
    for (const seg of segments) d = Math.min(d, pointToSegmentDist(x, z, seg.ax, seg.az, seg.bx, seg.bz));
    return d;
  };

  const tryRock = (cx: number, cz: number, size: number, trailClear: number): boolean => {
    const idx = worldToTerrainIndex(terrain, cx, cz);
    if (idx < 0) return false;
    const surf = terrain.surfaces[idx];
    if (surf === Surface.Road || surf === Surface.Concrete) return false;
    if (minDistToTrail(cx, cz) < trailClear) return false;
    const cy = terrain.heights[idx] ?? 0;
    out.push({ kind: 'rock', x: cx, y: cy, z: cz, size, height: 0, yaw: rng() * Math.PI });
    return true;
  };

  // (a) Trail-edge corridor: denser anchors (~5 m spacing), closer to the trail
  //     (4–7 m vs the old 5.5–9 m), bimodal sizes so large boulders mix with
  //     small pebbles instead of everything being a uniform medium rock.
  //     Large anchors scatter 2–5 satellite pebbles around them.
  for (const seg of segments) {
    const dx = seg.bx - seg.ax;
    const dz = seg.bz - seg.az;
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    const steps = Math.max(1, Math.floor(len / 5)); // was /9
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx0 = seg.ax + t * dx;
      const cz0 = seg.az + t * dz;
      for (const side of [-1, 1] as const) {
        const offset = 4.0 + rng() * 3.0; // 4–7 m (was 5.5–9)
        const jx = (rng() - 0.5) * 3.0;
        const jz = (rng() - 0.5) * 3.0;
        const cx = cx0 + px * side * offset + jx;
        const cz = cz0 + pz * side * offset + jz;
        const isLarge = rng() > 0.45;
        const size = isLarge ? 1.6 + rng() * 2.0 : 0.25 + rng() * 0.65;
        const placed = tryRock(cx, cz, size, HILL_CLIMB_PATH_HALF_WIDTH);
        if (!placed) continue;
        if (isLarge && rng() > 0.3) {
          const numSat = 2 + Math.floor(rng() * 4);
          for (let s = 0; s < numSat; s++) {
            const angle = rng() * Math.PI * 2;
            const dist = 0.8 + rng() * 2.5;
            tryRock(cx + Math.cos(angle) * dist, cz + Math.sin(angle) * dist, 0.15 + rng() * 0.55, HILL_CLIMB_PATH_HALF_WIDTH);
          }
        }
      }
    }
  }

  // (b) Dense scatter across the mountain face — denser grid (22×22 vs 16×16),
  //     rocky down to 3 m elevation (was 8 m) so the lower slopes look broken up,
  //     three-band size distribution: pebbles / mid rocks / large boulders.
  //     Large boulders anchor a rockfall cluster of small debris.
  const gridN = 22;
  const span = mtn.sigma * 2.2;
  const cell = span / gridN;
  for (let gi = 0; gi < gridN; gi++) {
    for (let gj = 0; gj < gridN; gj++) {
      const cx0 = mtn.x - span / 2 + gi * cell;
      const cz0 = mtn.z - span / 2 + gj * cell;
      const cx = cx0 + (rng() - 0.5) * cell * 0.85;
      const cz = cz0 + (rng() - 0.5) * cell * 0.85;
      if (Math.hypot(cx - mtn.x, cz - mtn.z) > mtn.sigma * 1.1) continue;
      const idx = worldToTerrainIndex(terrain, cx, cz);
      if (idx < 0) continue;
      const cy = terrain.heights[idx] ?? 0;
      if (cy < 3) continue; // was 8
      const surf = terrain.surfaces[idx];
      if (surf === Surface.Road || surf === Surface.Concrete) continue;
      if (minDistToTrail(cx, cz) < HILL_CLIMB_PATH_HALF_WIDTH + 4) continue;
      const roll = rng();
      const size = roll < 0.35 ? 0.15 + rng() * 0.5   // pebbles
                 : roll < 0.75 ? 0.65 + rng() * 1.4    // mid rocks
                 :               2.2 + rng() * 1.6;    // large boulders
      out.push({ kind: 'rock', x: cx, y: cy, z: cz, size, height: 0, yaw: rng() * Math.PI });
      if (size > 2.5 && rng() > 0.45) {
        const numSat = 3 + Math.floor(rng() * 5);
        for (let s = 0; s < numSat; s++) {
          const angle = rng() * Math.PI * 2;
          const dist = 1.2 + rng() * 3.5;
          const sx = cx + Math.cos(angle) * dist;
          const sz = cz + Math.sin(angle) * dist;
          const sidx = worldToTerrainIndex(terrain, sx, sz);
          if (sidx < 0) continue;
          const ssurf = terrain.surfaces[sidx];
          if (ssurf === Surface.Road || ssurf === Surface.Concrete) continue;
          if (minDistToTrail(sx, sz) < HILL_CLIMB_PATH_HALF_WIDTH + 2) continue;
          out.push({ kind: 'rock', x: sx, y: terrain.heights[sidx] ?? 0, z: sz, size: 0.15 + rng() * 0.55, height: 0, yaw: rng() * Math.PI });
        }
      }
    }
  }

  return out;
}

// Scatter rocks around the mountain base to make it look like a rocky hill.
function mountainRocks(terrain: TerrainData): Obstacle[] {
  const out: Obstacle[] = [];
  const mtn = terrain.mountain;
  const rng = mulberry32(mtn.x * 1000 + mtn.z);
  const count = 60;
  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = mtn.sigma * 0.5 + rng() * mtn.sigma * 1.2;
    const cx = mtn.x + Math.cos(angle) * dist;
    const cz = mtn.z + Math.sin(angle) * dist;
    const idx = worldToTerrainIndex(terrain, cx, cz);
    if (idx < 0) continue;
    const surf = terrain.surfaces[idx];
    if (surf === Surface.Road || surf === Surface.Concrete) continue;
    const cy = terrain.heights[idx] ?? 0;
    const radius = 0.4 + rng() * 1.8;
    out.push({ kind: 'rock', x: cx, y: cy, z: cz, size: radius, height: 0, yaw: rng() * Math.PI });
  }
  return out;
}

// Scatter pines on the lower mountain slopes.  Trees never appear on the
// trail — explicit pointToSegmentDist check keeps an 8 m buffer.
function mountainTrees(terrain: TerrainData): Obstacle[] {
  const out: Obstacle[] = [];
  const mtn = terrain.mountain;
  const rng = mulberry32(Math.round(mtn.x) * 2000 + Math.round(mtn.z) * 3 + 13);
  const segments = getHillClimbSegments(mtn);
  const count = 45;
  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = mtn.sigma * (1.2 + rng() * 1.3); // sigma*1.2 → sigma*2.5
    const cx = mtn.x + Math.cos(angle) * dist;
    const cz = mtn.z + Math.sin(angle) * dist;
    const idx = worldToTerrainIndex(terrain, cx, cz);
    if (idx < 0) continue;
    const cy = terrain.heights[idx] ?? 0;
    if (cy < 3 || cy > 20) continue; // lower slopes only
    const surf = terrain.surfaces[idx];
    if (surf === Surface.Road || surf === Surface.Concrete || surf === Surface.DeepMud) continue;
    // Keep trees off the trail
    let minTrail = Infinity;
    for (const seg of segments) {
      minTrail = Math.min(minTrail, pointToSegmentDist(cx, cz, seg.ax, seg.az, seg.bx, seg.bz));
    }
    if (minTrail < 8) continue;
    const height = 9 + rng() * 8;
    out.push({ kind: 'pine', x: cx, y: cy, z: cz, size: 0.6 + rng() * 0.5, height, yaw: rng() * Math.PI });
  }
  return out;
}

// Perimeter wall dressing. The cliff (terrain heightfield ramp) is the
// real wall; this scatters rocks and pines along the cliff base on
// each edge so the boundary reads as a treeline / rockline. Fixed
// spacing, no jitter.
function perimeterObstacles(terrain: TerrainData): Obstacle[] {
  const out: Obstacle[] = [];
  const half = terrain.size / 2;
  const inset = 4;
  const spacing = 8;
  const along = terrain.size - 2 * inset;
  const steps = Math.floor(along / spacing);
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i <= steps; i++) {
      const tAlong = (i / steps) * along - along / 2;
      let px: number, pz: number;
      if (side === 0)      { px = tAlong; pz = half - inset; }
      else if (side === 1) { px = tAlong; pz = -half + inset; }
      else if (side === 2) { px = half - inset; pz = tAlong; }
      else                 { px = -half + inset; pz = tAlong; }
      const idx = worldToTerrainIndex(terrain, px, pz);
      if (idx < 0) continue;
      const surf = terrain.surfaces[idx];
      // Skip the cells where the road meets the world edge - players
      // need a clear path to the boundary so they can trigger the
      // off-map ejector. Same goes for the concrete pad just in case.
      if (surf === Surface.Road || surf === Surface.Concrete) continue;
      const py = terrain.heights[idx] ?? 0;
      // Every 5th obstacle along the perimeter is a pine; rest are big
      // boulders. Yaw cycles for visual variety without RNG.
      if (i % 5 === 2) {
        out.push({
          kind: 'pine',
          x: px, y: py, z: pz,
          size: 0.95,
          height: 16,
          yaw: (i + side) * 0.31,
        });
      } else {
        out.push({
          kind: 'rock',
          x: px, y: py, z: pz,
          size: 1.8 + (i % 3) * 0.5,
          height: 0,
          yaw: (i + side) * 0.41,
        });
      }
    }
  }
  return out;
}

export function generateObstacles(terrain: TerrainData): Obstacle[] {
  const out: Obstacle[] = [];

  const sampleY = (x: number, z: number): number | null => {
    const idx = worldToTerrainIndex(terrain, x, z);
    if (idx < 0) return null;
    const surf = terrain.surfaces[idx];
    // Skip placements on road / concrete pad / deep mud so obstacles
    // never block spawn or land in the petrol station forecourt.
    if (surf === Surface.Road || surf === Surface.Concrete || surf === Surface.DeepMud) return null;
    return terrain.heights[idx] ?? 0;
  };

  // Scatter rocks (medium + small).
  for (let i = 0; i < ROCKS_MEDIUM.length; i++) {
    const [x, z, size] = ROCKS_MEDIUM[i]!;
    const y = sampleY(x, z);
    if (y === null) continue;
    out.push({ kind: 'rock', x, y, z, size, height: 0, yaw: i * 0.37 });
  }
  for (let i = 0; i < ROCKS_SMALL.length; i++) {
    const [x, z, size] = ROCKS_SMALL[i]!;
    const y = sampleY(x, z);
    if (y === null) continue;
    out.push({ kind: 'rock', x, y, z, size, height: 0, yaw: i * 0.43 });
  }
  for (let i = 0; i < TREES.length; i++) {
    const [x, z, size, height] = TREES[i]!;
    const y = sampleY(x, z);
    if (y === null) continue;
    out.push({ kind: 'tree', x, y, z, size, height, yaw: i * 0.51 });
  }
  for (let i = 0; i < FOREST_PINES.length; i++) {
    const [x, z, size, height] = FOREST_PINES[i]!;
    const y = sampleY(x, z);
    if (y === null) continue;
    out.push({ kind: 'pine', x, y, z, size, height, yaw: i * 0.29 });
  }

  // Flex ramps. Placed unconditionally on the terrain height at their
  // anchor (no surface filter): they're test fixtures, not scatter, so
  // they should always spawn even if the cell happens to be mud or grass.
  for (const r of FLEX_RAMPS) {
    const idx = worldToTerrainIndex(terrain, r.x, r.z);
    if (idx < 0) continue;
    const y = terrain.heights[idx] ?? 0;
    out.push({
      kind: 'ramp',
      x: r.x, y, z: r.z,
      size: r.width / 2,
      height: r.rise,
      length: r.length,
      yaw: r.yaw,
    });
  }

  // Programmatic-but-fixed passes that depend on terrain layout.
  out.push(...hillClimbBoulders(terrain));
  out.push(...mountainRocks(terrain));
  out.push(...mountainTrees(terrain));
  out.push(...perimeterObstacles(terrain));

  // Summit lookout marker — one flagpole at the peak as a climb destination.
  const summitIdx = worldToTerrainIndex(terrain, terrain.mountain.x, terrain.mountain.z);
  const summitY = summitIdx >= 0 ? (terrain.heights[summitIdx] ?? 0) : terrain.mountain.peak;
  out.push({
    kind: 'flagpole',
    x: terrain.mountain.x,
    y: summitY,
    z: terrain.mountain.z,
    size: 0.07,   // pole radius — used by capsule collider half-radius
    height: 6.0,  // total pole height
    yaw: 0,
  });

  return out;
}

// Geometry for a flex ramp: tilted cuboid placed so the low long edge
// rests on the ground at `groundY` and the opposite long edge sits
// `rise` metres above. Returns the centroid + orientation quaternion
// the renderer also needs, so client visuals stay aligned with the
// collider without re-deriving the math.
const RAMP_HALF_THICK = 0.06;
export function rampTransform(o: Obstacle): {
  cx: number; cy: number; cz: number;
  qx: number; qy: number; qz: number; qw: number;
  halfLength: number; halfWidth: number; halfThick: number;
  tilt: number;
} {
  const halfLength = (o.length ?? 3) / 2;
  const halfWidth = o.size;
  const halfThick = RAMP_HALF_THICK;
  const tilt = Math.atan2(o.height, halfWidth * 2);
  // Lift centroid so the low edge rests on the ground after tilt:
  // bottom-most corner Y = cy - halfWidth*sin(tilt) - halfThick*cos(tilt).
  const cy = o.y + halfWidth * Math.sin(tilt) + halfThick * Math.cos(tilt);
  // Composite quat: yaw (around world Y) then tilt (around local X).
  // Pre-multiplied form: q = q_yaw * q_tilt.
  const sty = Math.sin(o.yaw / 2), cty = Math.cos(o.yaw / 2);
  const sta = Math.sin(tilt / 2), cta = Math.cos(tilt / 2);
  return {
    cx: o.x, cy, cz: o.z,
    qx: cty * sta,
    qy: sty * cta,
    qz: -sty * sta,
    qw: cty * cta,
    halfLength, halfWidth, halfThick, tilt,
  };
}

/** Spawn the obstacles into a Rapier world as static colliders. Returns
 *  the bodies so they can be cleaned up later. */
export function spawnObstacleColliders(
  world: RAPIER.World,
  obstacles: Obstacle[],
): RAPIER.RigidBody[] {
  const bodies: RAPIER.RigidBody[] = [];
  for (const o of obstacles) {
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(o.x, o.y, o.z);
    const body = world.createRigidBody(bodyDesc);
    let colDesc: RAPIER.ColliderDesc;
    if (o.kind === 'rock') {
      colDesc = RAPIER.ColliderDesc.ball(o.size).setFriction(0.9);
      body.setTranslation({ x: o.x, y: o.y + o.size * 0.6, z: o.z }, true);
    } else if (o.kind === 'ramp') {
      const t = rampTransform(o);
      body.setTranslation({ x: t.cx, y: t.cy, z: t.cz }, true);
      body.setRotation({ x: t.qx, y: t.qy, z: t.qz, w: t.qw }, true);
      colDesc = RAPIER.ColliderDesc.cuboid(t.halfLength, t.halfThick, t.halfWidth).setFriction(1.0);
    } else {
      const halfHeight = Math.max(0.1, (o.height - 2 * o.size) / 2);
      colDesc = RAPIER.ColliderDesc.capsule(halfHeight, o.size).setFriction(0.6);
      body.setTranslation(
        { x: o.x, y: o.y + halfHeight + o.size, z: o.z },
        true,
      );
    }
    world.createCollider(colDesc, body);
    bodies.push(body);
  }
  return bodies;
}
