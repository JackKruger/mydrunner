// One mesh builder per object kind.
//
// The `Record<ObstacleKind, ...>` annotation is the point of this file: it
// turns "someone added a kind to the shared catalog and forgot the client"
// into a compile error. Before it, the client's per-kind chain ended in an
// unlabelled `else` that built a tree, so a new kind rendered as a tree and
// nothing said otherwise.
//
// The table lives here rather than in the shared catalog because shared
// must not import three — the server loads that package and has no business
// pulling in a renderer.

import type { Physics as PhysicsNs } from '@mydrunner/shared';
import { NATURAL_MESHES } from './natural.js';
import { TRAIL_MESHES } from './trail.js';
import { PROP_MESHES } from './props.js';
import { STRUCTURE_MESHES } from './structures.js';
import type { ObjectMeshBuilder } from './types.js';

export const OBJECT_MESHES: Record<PhysicsNs.ObstacleKind, ObjectMeshBuilder> = {
  ...NATURAL_MESHES,
  ...TRAIL_MESHES,
  ...PROP_MESHES,
  ...STRUCTURE_MESHES,
};
