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
import { Surface, type TerrainData, worldToTerrainIndex } from './terrain.js';

export type ObstacleKind = 'rock' | 'tree';

export interface Obstacle {
  kind: ObstacleKind;
  x: number;
  y: number;
  z: number;
  /** Sphere radius for rocks; trunk radius for trees. */
  size: number;
  /** Tree trunk height (0 for rocks). */
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
  const count = opts.count ?? 60;
  const rng = mulberry32(seed);
  const out: Obstacle[] = [];
  const half = terrain.size / 2 - 4;

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
      // Tree trunk: capsule slightly above ground, half-height = (height - 2*radius) / 2.
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
