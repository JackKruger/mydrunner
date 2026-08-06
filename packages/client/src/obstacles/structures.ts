// Buildings and the big fixed hardware.

import * as THREE from 'three';
import { CONTAINER_COLORS, metal, solid } from './materials.js';
import { box, cyl, plankDeck, repeatX, ribbedBox } from './prims.js';
import type { ObjectMeshBuilder } from './types.js';

const shippingContainer: ObjectMeshBuilder = (ctx, o) => {
  const tint = ctx.pick(CONTAINER_COLORS, o, 'tint');
  const body = solid(ctx, tint, 0.85);
  const rib = solid(ctx, tint, 0.95);
  const dark = solid(ctx, 0x2a2622, 0.9);
  const len = o.length ?? 6;
  const w = o.size * 2;
  const out: THREE.Object3D[] = [...ribbedBox(len, o.height, w, 14, body, rib)];
  // Door end: two leaves with locking bars.
  out.push(box(0.05, o.height * 0.94, w * 0.97, rib, { x: len / 2, y: o.height / 2 }));
  for (const z of [-w * 0.2, w * 0.2]) {
    out.push(cyl(0.035, 0.035, o.height * 0.88, dark, { x: len / 2 + 0.04, y: o.height / 2, z }, 6));
  }
  return out;
};

const waterTank: ObjectMeshBuilder = (ctx, o) => {
  const body = solid(ctx, 0x8a9a8c, 0.9);
  const rib = solid(ctx, 0x76877a, 0.92);
  const roof = metal(ctx, 0xa8b0aa, 0.6);
  const out: THREE.Object3D[] = [
    cyl(o.size, o.size, o.height, body, { y: o.height / 2 }, 16),
  ];
  // Corrugation rings.
  const rings = Math.max(3, Math.round(o.height / 0.5));
  for (let i = 0; i < rings; i++) {
    out.push(cyl(o.size * 1.02, o.size * 1.02, 0.05, rib, {
      y: (o.height / rings) * (i + 0.5),
    }, 16));
  }
  out.push(cyl(0.06, o.size * 1.04, o.size * 0.5, roof, { y: o.height + o.size * 0.25 }, 16));
  return out;
};

const shed: ObjectMeshBuilder = (ctx, o) => {
  const wall = solid(ctx, 0x9a9488, 0.92);
  const rib = solid(ctx, 0x87817a, 0.94);
  const roof = metal(ctx, 0x6a7076, 0.65);
  const door = solid(ctx, 0x4a4038, 0.92);
  const len = o.length ?? 4;
  const w = o.size * 2;
  const out: THREE.Object3D[] = [...ribbedBox(len, o.height, w, 10, wall, rib)];
  // Two roof slopes meeting over the ridge.
  const slope = Math.atan2(o.height * 0.3, w / 2);
  const panel = Math.hypot(w / 2, o.height * 0.3) + 0.1;
  for (const s of [-1, 1]) {
    out.push(box(len + 0.2, 0.06, panel, roof, {
      y: o.height + o.height * 0.15, z: (s * w) / 4, rx: -s * slope,
    }));
  }
  out.push(box(0.04, o.height * 0.72, w * 0.34, door, { x: -len / 2 - 0.02, y: o.height * 0.36 }));
  return out;
};

const jetty: ObjectMeshBuilder = (ctx, o) => {
  const deckMat = solid(ctx, 0x8a7050, 0.94);
  const post = solid(ctx, 0x5a4a38, 0.96);
  const len = o.length ?? 8;
  const w = o.size * 2;
  const boards = Math.max(4, Math.round(w / 0.24));
  const out: THREE.Object3D[] = [
    ...plankDeck(len, w, 0.07, boards, deckMat, o.height),
    // Kerb rails down both long edges.
    box(len, 0.09, 0.09, deckMat, { y: o.height + 0.08, z: -w / 2 }),
    box(len, 0.09, 0.09, deckMat, { y: o.height + 0.08, z: w / 2 }),
  ];
  out.push(...repeatX(4, len * 0.86, (_i, x) => {
    const pair: THREE.Object3D[] = [];
    for (const z of [-w / 2 + 0.12, w / 2 - 0.12]) {
      pair.push(cyl(0.09, 0.11, o.height, post, { x, y: o.height / 2, z }, 7));
    }
    const g = new THREE.Group();
    g.add(...pair);
    return g;
  }));
  return out;
};

export const STRUCTURE_MESHES = {
  shippingContainer, waterTank, shed, jetty,
} satisfies Record<string, ObjectMeshBuilder>;
