// Visuals for the placed objects. Built from the obstacle list the world
// was actually assembled with; no per-frame state.

import * as THREE from 'three';
import { createMeshCtx } from './materials.js';
import { OBJECT_MESHES } from './registry.js';
import type { Obstacle } from './types.js';
import { cullRadius, shouldShow } from './cull.js';
import { activeQuality, type QualitySettings } from '../quality.js';

export { OBJECT_MESHES } from './registry.js';
export type { ObjectMeshBuilder } from './types.js';

/** How far the camera must move before the visibility sweep re-runs. The
 *  sweep is ~1000 distance comparisons, which is cheap, but a parked truck
 *  should not pay for it at all. */
const SWEEP_MOVE_M = 2;

interface CullEntry {
  root: THREE.Group;
  x: number;
  z: number;
  radius: number;
}

export class Obstacles {
  readonly group = new THREE.Group();

  /** Empty unless the tier asks for culling, which keeps updateVisibility a
   *  single length check on the high tier and in the editor. */
  private readonly cullable: CullEntry[] = [];
  private lastSweepX = Number.NaN;
  private lastSweepZ = Number.NaN;

  /** Takes the composed list rather than a TerrainData it would generate
   *  from. Generating here meant a second, independent call to
   *  generateObstacles — fine while the only obstacles were procedural,
   *  wrong the moment a map adds or removes any, because the visuals and
   *  the colliders would disagree about what exists. */
  constructor(list: readonly Obstacle[], quality: QualitySettings = activeQuality()) {
    const ctx = createMeshCtx();
    for (const o of list) {
      const build = OBJECT_MESHES[o.kind];
      if (!build) continue;

      // Every object is a group placed at its ground point and turned to
      // face its yaw; the builder works purely in that local frame. The
      // whole object is one tagged node, so the editor's raycast resolves a
      // click anywhere on it — clicking a tree's canopy used to miss,
      // because only the trunk carried the id.
      const root = new THREE.Group();
      root.position.set(o.x, o.y, o.z);
      // Yaw lives here, on the root, for every kind — including the ramp,
      // whose builder applies only the tilt underneath it. Composed, that
      // is exactly rampTransform's q_yaw * q_tilt, so the plank you see
      // stays on the collider you hit.
      root.rotation.y = o.yaw;
      root.userData.obstacleId = o.id;
      root.add(...build(ctx, o));
      this.group.add(root);

      if (quality.obstacleCull) {
        const radius = cullRadius(o, quality.obstacleCullFloorM);
        // Objects that can never be hidden are not tracked at all, so the
        // sweep only walks the population it can actually act on.
        if (radius !== Infinity) this.cullable.push({ root, x: o.x, z: o.z, radius });
      }
    }
  }

  /** Hide small scenery the camera has left behind.
   *
   *  Driven from WorldView.render because that is the one place per frame
   *  with both the camera and the obstacle set. Gated on the camera actually
   *  having moved, the same way the editor gates its gizmo re-raycast.
   *
   *  Culling is visual only — colliders live in the physics world — so a
   *  hidden rock is still a rock you hit. See cull.ts for why nothing inside
   *  the winch floor is ever touched. */
  updateVisibility(camX: number, camZ: number): void {
    if (this.cullable.length === 0) return;
    const moved = (camX - this.lastSweepX) ** 2 + (camZ - this.lastSweepZ) ** 2;
    if (moved < SWEEP_MOVE_M * SWEEP_MOVE_M) return;
    this.lastSweepX = camX;
    this.lastSweepZ = camZ;

    for (const entry of this.cullable) {
      const distSq = (camX - entry.x) ** 2 + (camZ - entry.z) ** 2;
      entry.root.visible = shouldShow(distSq, entry.radius, entry.root.visible);
    }
  }
}
