// Visuals for the placed objects. Built from the obstacle list the world
// was actually assembled with; no per-frame state.

import * as THREE from 'three';
import { createMeshCtx } from './materials.js';
import { OBJECT_MESHES } from './registry.js';
import type { Obstacle } from './types.js';

export { OBJECT_MESHES } from './registry.js';
export type { ObjectMeshBuilder } from './types.js';

export class Obstacles {
  readonly group = new THREE.Group();

  /** Takes the composed list rather than a TerrainData it would generate
   *  from. Generating here meant a second, independent call to
   *  generateObstacles — fine while the only obstacles were procedural,
   *  wrong the moment a map adds or removes any, because the visuals and
   *  the colliders would disagree about what exists. */
  constructor(list: readonly Obstacle[]) {
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
    }
  }
}
