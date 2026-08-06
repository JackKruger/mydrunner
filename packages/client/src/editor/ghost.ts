// The object about to be placed, drawn translucent under the cursor.
//
// Built by the *same* mesh path as the real thing — `new Obstacles([...])`
// — rather than an approximation. A lookalike preview is the failure mode
// WorldView's header already warns about one layer up: a ghost that is
// merely rock-shaped tells you nothing about the rock you are going to get,
// and the discrepancy would only ever surface as "why does the map look
// different from the editor".
//
// Not part of gizmos.ts. Those are authoring furniture — a ring and a
// marker, pure geometry with no dependency on the object system. This
// imports the catalog, the mesh builders and the dispose helpers, and keeps
// a rebuild cache; folding it in would give gizmos.ts exactly the
// "miscellaneous responsibility" CLAUDE.md's structural pass looks for.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';

import { Obstacles } from '../obstacles/index.js';
import { disposeObject3D } from '../three/dispose.js';

export interface GhostSpec {
  /** The id the placed object will actually get.
   *
   *  Load-bearing, not decoration: obstacle appearance is hashed from the
   *  id (rock colour, squash, canopy layer count), so a ghost built with a
   *  throwaway id is a visibly *different* rock from the one that lands.
   *  EditSession mints the id up front and hands it over so the two agree. */
  id: string;
  kind: Physics.ObstacleKind;
  size: number;
  height: number;
  length?: number;
}

const GHOST_OPACITY = 0.5;

export class ObjectGhost {
  readonly group = new THREE.Group();
  private built: THREE.Object3D | null = null;
  private key = '';

  constructor() {
    this.group.renderOrder = 997;
    this.group.visible = false;
  }

  /** Rebuild the mesh if the spec changed, then seat it.
   *
   *  Position and yaw are parent-transform writes on an already-built
   *  group, so aiming with the wheel costs nothing — which is the whole
   *  reason the mesh builders work in a local frame. */
  show(spec: GhostSpec, x: number, groundY: number, z: number, yaw: number): void {
    const key = `${spec.kind}|${spec.size}|${spec.height}|${spec.length ?? '-'}|${spec.id}`;
    if (key !== this.key) {
      this.rebuild(spec);
      this.key = key;
    }
    this.group.position.set(x, groundY, z);
    this.group.rotation.y = yaw;
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  /** Drop the cached mesh so the next show() rebuilds.
   *
   *  Called after a placement: the next object gets a fresh id, and its
   *  hashed appearance is therefore different. Without this the ghost would
   *  keep showing the rock you just placed. */
  invalidate(): void {
    this.key = '';
  }

  dispose(): void {
    this.clear();
  }

  private clear(): void {
    if (!this.built) return;
    this.group.remove(this.built);
    disposeObject3D(this.built);
    this.built = null;
  }

  private rebuild(spec: GhostSpec): void {
    this.clear();
    // Built at the origin with zero yaw: the group carries the placement.
    const obstacles = new Obstacles([{
      id: spec.id,
      kind: spec.kind,
      x: 0, y: 0, z: 0,
      size: spec.size,
      height: spec.height,
      yaw: 0,
      ...(spec.length !== undefined ? { length: spec.length } : {}),
    }]);
    makeGhostly(obstacles.group);
    this.group.add(obstacles.group);
    this.built = obstacles.group;
  }
}

/** Make every material in the tree translucent.
 *
 *  Clones rather than mutating in place. Each Obstacles instance owns its
 *  materials today, so mutation happens to be safe — but the moment anyone
 *  hoists a shared material to module scope for reuse, in-place mutation
 *  here would turn every rock on the map see-through and the cause would be
 *  nowhere near the symptom. A clone per ghost costs one object. */
function makeGhostly(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.material) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const ghostly = (m: THREE.Material): THREE.Material => {
      const c = m.clone();
      c.transparent = true;
      c.opacity = GHOST_OPACITY;
      // Depth writes off so the ghost's own far faces don't punch holes in
      // its near ones; depth *test* stays on so it is correctly occluded by
      // the hill it is behind.
      c.depthWrite = false;
      const lit = c as THREE.MeshStandardMaterial;
      if (lit.emissive) lit.emissive.setHex(0x224466);
      return c;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(ghostly)
      : ghostly(mesh.material);
  });
}
