// Procedural truck silhouettes built from Three.js primitives. Physics
// is shared across kinds (chassis extents, wheel positions); the visual
// is the only thing that varies. Each per-kind body builder lives in its
// own file; this module dispatches and supplies the shared scaffolding
// (materials, axles + wheels, lower body + flares).

import * as THREE from 'three';
import { VEHICLE, type CarKind } from '@mydrunner/shared';
import { buildAxles, buildLowerBodyAndFlares, makeMaterials, pickColor } from './shared.js';
import { PATROL_COLORS, buildPatrolBody } from './patrol.js';
import { HILUX_COLORS, buildHiluxBody } from './hilux.js';
import { UTE_COLORS, buildUteBody } from './ute.js';
import { MOTORBIKE_COLORS, buildMotorbikeBody } from './motorbike.js';

export interface CarMesh {
  group: THREE.Group;
  /** [FL, FR, RL, RR]. Spin + steer apply here. Each wheel is a child
   *  of its axle group (axles[0] for FL/FR, axles[1] for RL/RR), so
   *  posing the axle moves both wheels together - that's the solid-axle
   *  rigid-beam coupling. */
  wheels: THREE.Object3D[];
  /** [front, rear] axle groups. Each is positioned at chassis-local
   *  (0, centerLocalY + rideY, centerLocalZ) and rotated by rollAngle
   *  about chassis-forward (local +Z). Wheel meshes are children at
   *  (+/- trackHalf, 0, 0). */
  axles: [THREE.Group, THREE.Group];
}

function paletteFor(kind: CarKind): readonly number[] {
  switch (kind) {
    case 'hilux': return HILUX_COLORS;
    case 'ute': return UTE_COLORS;
    case 'motorbike': return MOTORBIKE_COLORS;
    default: return PATROL_COLORS;
  }
}

export function buildCarMesh(kind: CarKind, isLocal: boolean, idHash: number): CarMesh {
  const group = new THREE.Group();
  const ext = VEHICLE.chassisHalfExtents;
  const mats = makeMaterials(pickColor(paletteFor(kind), isLocal, idHash));

  if (kind === 'motorbike') {
    buildMotorbikeBody(group, ext, mats);
  } else {
    buildLowerBodyAndFlares(group, ext, mats, kind);
    if (kind === 'hilux') {
      buildHiluxBody(group, ext, mats);
    } else if (kind === 'ute') {
      buildUteBody(group, ext, mats);
    } else {
      buildPatrolBody(group, ext, mats);
    }
  }
  const { axles, wheels } = buildAxles(group, kind);
  return { group, wheels, axles };
}

/** Hash a player id string to a stable small int for color selection. */
export function colorHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}
