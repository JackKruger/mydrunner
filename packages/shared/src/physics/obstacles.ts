// Procedural obstacle placement: rocks and trees scattered across the
// off-road areas (Dirt and Mud surfaces - never on the Road or in the
// deepest mud where vehicles get stuck). Determined entirely by the
// terrain seed so server and client generate identical lists without
// any network sync.
//
// Each obstacle is a static rigid body (rocks = sphere, trees = capsule
// trunk) so vehicles can collide with them, get stuck on them, climb
// over them.

import RAPIER from '@dimforge/rapier3d-compat';
import { Surface, type TerrainData, worldToTerrainIndex, mountainFor } from './terrain.js';

export type ObstacleKind = 'rock' | 'tree' | 'pine';

export interface Obstacle {
  kind: ObstacleKind;
  x: number;
  y: number;
  z: number;
  /** Sphere radius for rocks; trunk radius for trees / pines. */
  size: number;
  /** Tree / pine trunk height (0 for rocks). */
  height: number;
  /** Random rotation around Y for visual variety. */
  yaw: number;
}

// Mulberry32 - same generator used in terrain.ts so obstacle placement
// is deterministic per seed.
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

export interface ObstacleOptions {
  /** Offset from the terrain seed to keep obstacle randomness separate. */
  seedOffset?: number;
  /** Total obstacle count - mix of rocks and trees in roughly 60/40 ratio. */
  count?: number;
}

export function generateObstacles(
  terrain: TerrainData,
  opts: ObstacleOptions = {},
): Obstacle[] {
  const seed = terrain.seed + (opts.seedOffset ?? 7919);
  const count = opts.count ?? 100;
  const rng = mulberry32(seed);
  const out: Obstacle[] = [];
  const half = terrain.size / 2 - 4;

  // Pass 1: medium rocks + trees scattered across all driveable surfaces.
  for (let i = 0; i < count; i++) {
    const x = (rng() - 0.5) * 2 * half;
    const z = (rng() - 0.5) * 2 * half;
    const idx = worldToTerrainIndex(terrain, x, z);
    if (idx < 0) continue;
    const surf = terrain.surfaces[idx];
    // Skip road and deep mud - we don't want trees in the way of spawn
    // or in the swamp where players are already getting stuck.
    if (surf === Surface.Road || surf === Surface.DeepMud) continue;
    const y = terrain.heights[idx] ?? 0;
    const isTree = rng() < 0.4;
    if (isTree) {
      const height = 2.5 + rng() * 2.5;
      const trunkRadius = 0.18 + rng() * 0.12;
      out.push({ kind: 'tree', x, y, z, size: trunkRadius, height, yaw: rng() * Math.PI * 2 });
    } else {
      const radius = 0.5 + rng() * 1.0;
      out.push({ kind: 'rock', x, y, z, size: radius, height: 0, yaw: rng() * Math.PI * 2 });
    }
  }

  // Pass 2: small rocks scattered everywhere off the road. Density-style
  // detail - too small to stop the truck (radius < wheel radius) but
  // adds visual chunk and occasional bumps to drive over.
  const smallCount = Math.floor(count * 1.6);
  for (let i = 0; i < smallCount; i++) {
    const x = (rng() - 0.5) * 2 * half;
    const z = (rng() - 0.5) * 2 * half;
    const idx = worldToTerrainIndex(terrain, x, z);
    if (idx < 0) continue;
    const surf = terrain.surfaces[idx];
    if (surf === Surface.Road) continue;
    const y = terrain.heights[idx] ?? 0;
    const radius = 0.15 + rng() * 0.25;
    out.push({ kind: 'rock', x, y, z, size: radius, height: 0, yaw: rng() * Math.PI * 2 });
  }

  // Pass 3: rocky hill climb. A path of progressively-larger rocks runs
  // from the south side of the mountain up its flank, framing a route
  // a determined truck can climb. Boulders are placed in two parallel
  // tracks (slight zigzag) so there's a corridor between them rather
  // than a wall.
  const mtn = mountainFor(terrain.size);
  // Approach direction: from the road (south) up to the summit. Vector
  // from a base point to the summit.
  const baseX = mtn.x + (rng() - 0.5) * 6;
  const baseZ = mtn.z - mtn.sigma * 1.6; // start ~1.6 sigma south of summit
  const dx = mtn.x - baseX;
  const dz = mtn.z - baseZ;
  const len = Math.hypot(dx, dz);
  const nx = dx / len;
  const nz = dz / len;
  // Perpendicular for the corridor offset.
  const px = -nz;
  const pz = nx;
  const climbSteps = 14;
  for (let i = 0; i < climbSteps; i++) {
    const t = i / (climbSteps - 1);
    const along = t * len;
    // Two parallel tracks ~3.5m apart so a truck (1.7m wide) fits between.
    for (const side of [-1, 1]) {
      const cx = baseX + nx * along + px * side * (3.5 + rng() * 1.2);
      const cz = baseZ + nz * along + pz * side * (3.5 + rng() * 1.2);
      const idx = worldToTerrainIndex(terrain, cx, cz);
      if (idx < 0) continue;
      const cy = terrain.heights[idx] ?? 0;
      // Boulders get larger near the top - more dramatic / harder to climb.
      const radius = 0.55 + t * 0.7 + rng() * 0.4;
      out.push({ kind: 'rock', x: cx, y: cy, z: cz, size: radius, height: 0, yaw: rng() * Math.PI * 2 });
    }
    // Occasional boulder in the corridor itself for chunkier feel.
    if (rng() < 0.25 && i > 1 && i < climbSteps - 1) {
      const cx = baseX + nx * along + px * (rng() - 0.5) * 2;
      const cz = baseZ + nz * along + pz * (rng() - 0.5) * 2;
      const idx = worldToTerrainIndex(terrain, cx, cz);
      if (idx < 0) continue;
      const cy = terrain.heights[idx] ?? 0;
      const radius = 0.3 + rng() * 0.4;
      out.push({ kind: 'rock', x: cx, y: cy, z: cz, size: radius, height: 0, yaw: rng() * Math.PI * 2 });
    }
  }
  // Pass 4: pine forest. A circular cluster of large pines on the
  // opposite side of the map from the mountain, far enough from the
  // road that a player has to deliberately drive into it.
  const worldSize = terrain.size;
  const forestCx = -worldSize * 0.28;
  const forestCz = worldSize * 0.18;
  const forestR = 36;
  const pineCount = 50;
  for (let i = 0; i < pineCount; i++) {
    // Disc-distribute via sqrt(u) for uniform density.
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * forestR;
    const px = forestCx + Math.cos(a) * r;
    const pz = forestCz + Math.sin(a) * r;
    const idx = worldToTerrainIndex(terrain, px, pz);
    if (idx < 0) continue;
    const surf = terrain.surfaces[idx];
    if (surf === Surface.Road) continue;
    if (surf === Surface.DeepMud) continue;
    const py = terrain.heights[idx] ?? 0;
    const trunkRadius = 0.8 + rng() * 0.6; // 0.8..1.4m
    const height = 14 + rng() * 8;          // 14..22m
    out.push({ kind: 'pine', x: px, y: py, z: pz, size: trunkRadius, height, yaw: rng() * Math.PI * 2 });
  }

  // Pass 5: perimeter rocks + pines along the world edges. The
  // heightfield already ramps up at the edges (see terrain.ts) so the
  // wall is impassable; this pass dresses the cliff base with rocks
  // and the occasional pine so the boundary reads as a treeline /
  // rockline rather than an arbitrary world cap. Last pass so it
  // doesn't shift RNG state for earlier passes (test stability).
  // The cliff bump in the heightfield IS the wall; perimeter obstacles
  // are decoration. Sparse spacing keeps the obstacle/collider count
  // reasonable while still reading as a treeline / rockline.
  const perimSpacing = 8;
  const perimInset = 4;
  const perimSize = terrain.size;
  const perimHalf = perimSize / 2;
  for (let side = 0; side < 4; side++) {
    const along = perimSize - 2 * perimInset;
    const steps = Math.floor(along / perimSpacing);
    for (let i = 0; i <= steps; i++) {
      const along_t = (i / steps) * along - along / 2;
      const jitter = (rng() - 0.5) * 3;
      let px: number, pz: number;
      if (side === 0) { px = along_t; pz = perimHalf - perimInset - jitter; }
      else if (side === 1) { px = along_t; pz = -perimHalf + perimInset + jitter; }
      else if (side === 2) { px = perimHalf - perimInset - jitter; pz = along_t; }
      else                 { px = -perimHalf + perimInset + jitter; pz = along_t; }
      const idx = worldToTerrainIndex(terrain, px, pz);
      if (idx < 0) continue;
      const py = terrain.heights[idx] ?? 0;
      if (rng() < 0.20) {
        const trunkRadius = 0.7 + rng() * 0.5;
        const height = 12 + rng() * 6;
        out.push({ kind: 'pine', x: px, y: py, z: pz, size: trunkRadius, height, yaw: rng() * Math.PI * 2 });
      } else {
        const radius = 1.5 + rng() * 1.5;
        out.push({ kind: 'rock', x: px, y: py, z: pz, size: radius, height: 0, yaw: rng() * Math.PI * 2 });
      }
    }
  }
  return out;
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
      // Rocks sit half-buried for a chunkier look.
      body.setTranslation({ x: o.x, y: o.y + o.size * 0.6, z: o.z }, true);
    } else {
      // Tree / pine trunk: capsule. Same collider shape; pines just
      // happen to be larger.
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
