// The shapes 35 object builders are assembled from.
//
// Without these, each new kind is a fresh pile of BoxGeometry/position/
// rotation/castShadow lines and they drift apart — one forgets a shadow,
// another spells the rotation order differently. Every helper here returns
// a shadow-casting Mesh positioned in the *local* frame: origin at the
// object's ground point, +X along its facing, +Y up. The dispatcher applies
// the world position and yaw, so no builder ever mentions o.x or o.yaw.

import * as THREE from 'three';

export interface Placement {
  x?: number; y?: number; z?: number;
  rx?: number; ry?: number; rz?: number;
  /** Take shadows as well as cast them. Off by default, and deliberately
   *  so: foliage is many overlapping fragments and shadow-receiving them
   *  costs a map sample each, for self-shadowing between canopy cones that
   *  reads as banding rather than depth. Broad flat surfaces — a rock face,
   *  a ramp deck, a container roof — do want it. */
  recv?: boolean;
}

function place(mesh: THREE.Mesh, p: Placement): THREE.Mesh {
  mesh.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
  mesh.rotation.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0);
  mesh.castShadow = true;
  mesh.receiveShadow = p.recv ?? false;
  return mesh;
}

export function box(
  w: number, h: number, d: number, mat: THREE.Material | THREE.Material[], p: Placement = {},
): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), p);
}

export function cyl(
  rTop: number, rBottom: number, h: number, mat: THREE.Material,
  p: Placement = {}, seg = 10,
): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, seg), mat), p);
}

export function cone(
  r: number, h: number, mat: THREE.Material, p: Placement = {}, seg = 8,
): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat), p);
}

export function ico(
  r: number, mat: THREE.Material, p: Placement = {}, detail = 0,
): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), mat), p);
}

export function torus(
  r: number, tube: number, mat: THREE.Material, p: Placement = {},
): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 12), mat), p);
}

export function plane(
  w: number, h: number, mat: THREE.Material, p: Placement = {},
): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat), p);
}

/** A lying cylinder along local +X — a log, a pipe, a round bale.
 *  Rapier's cylinder and Three's both stand on Y, so both need the same
 *  quarter turn; keeping it in one helper is what stops the collider and
 *  the mesh disagreeing about which way a log points. */
export function lyingCyl(
  r: number, len: number, mat: THREE.Material, p: Placement = {}, seg = 12,
): THREE.Mesh {
  return place(new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat), {
    ...p, rz: Math.PI / 2 + (p.rz ?? 0),
  });
}

/** `n` copies of whatever `make` returns, spread evenly along local X. */
export function repeatX(
  n: number, span: number, make: (i: number, x: number) => THREE.Object3D | null,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  if (n <= 0) return out;
  const step = n === 1 ? 0 : span / (n - 1);
  const start = n === 1 ? 0 : -span / 2;
  for (let i = 0; i < n; i++) {
    const obj = make(i, start + i * step);
    if (obj) out.push(obj);
  }
  return out;
}

/** A deck of planks spanning `len` along X, `width` across Z. */
export function plankDeck(
  len: number, width: number, thickness: number, boards: number,
  mat: THREE.Material, y: number,
): THREE.Object3D[] {
  const gap = 0.02;
  const bw = width / boards - gap;
  return repeatX(boards, width - bw, (_i, z) =>
    box(len, thickness, bw, mat, { y, z, recv: true }));
}

/** A ribbed panel — shipping containers, sheds, water tanks, culverts.
 *  Ribs are separate thin boxes rather than a texture: the editor rebuilds
 *  this group constantly and a CanvasTexture per kind per rebuild is a
 *  worse trade than a handful of extra boxes. */
export function ribbedBox(
  w: number, h: number, d: number, ribs: number,
  body: THREE.Material, rib: THREE.Material,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [box(w, h, d, body, { y: h / 2, recv: true })];
  out.push(...repeatX(ribs, w * 0.9, (_i, x) =>
    box(w * 0.012, h * 0.96, d + 0.03, rib, { x, y: h / 2 })));
  return out;
}
