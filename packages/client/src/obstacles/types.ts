import type * as THREE from 'three';
import type { Physics as PhysicsNs } from '@mydrunner/shared';
import type { MeshCtx } from './materials.js';

export type Obstacle = PhysicsNs.Obstacle;

/** Builds one object's visuals in its local frame: origin at the ground
 *  point, +X along its facing, no yaw. The dispatcher applies the world
 *  position and rotation.
 *
 *  Local-frame is what makes the editor's placement ghost cheap — aiming
 *  with the mouse wheel is a parent-transform write instead of a rebuild —
 *  and it is why no builder reads o.x, o.y, o.z or o.yaw. */
export type ObjectMeshBuilder = (ctx: MeshCtx, o: Obstacle) => THREE.Object3D[];
