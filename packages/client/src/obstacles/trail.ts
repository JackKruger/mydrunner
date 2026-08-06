// The obstacle course: things put there to be driven at.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';
import { cautionStripeMaterial, metal, solid, TRUNK_COLOR } from './materials.js';
import { box, cyl, lyingCyl, plane, plankDeck, repeatX, torus } from './prims.js';
import type { ObjectMeshBuilder } from './types.js';

/** A tyre, lying flat (axis up) or standing (face-on). */
function tyre(mat: THREE.Material, r: number, p: Parameters<typeof torus>[3]): THREE.Mesh {
  return torus(r * 0.72, r * 0.28, mat, p);
}

const ramp: ObjectMeshBuilder = (ctx, o) => {
  const t = Physics.rampTransform(o);
  const top = cautionStripeMaterial(ctx);
  const side = solid(ctx, 0x6b4f2a, 0.85);
  const mats = [
    side, side, // +X, -X (ends)
    top,  side, // +Y top, -Y bottom
    side, side, // +Z, -Z (long sides)
  ];
  // The parent group already carries the yaw, so only the tilt is applied
  // here. Composed that is exactly rampTransform's q_yaw * q_tilt, which is
  // what keeps the plank the player sees on top of the collider they hit.
  const deck = box(t.halfLength * 2, t.halfThick * 2, t.halfWidth * 2, mats, {
    y: t.cy - o.y, rx: t.tilt, recv: true,
  });

  // Tall flagpole next to the ramp so it's findable from anywhere on the
  // map. Visual only - no collider.
  const postH = 5;
  const postMat = metal(ctx, 0xdde4ee);
  const flagMat = ctx.mat('flag', () => new THREE.MeshStandardMaterial({
    color: 0xff5a1f, roughness: 0.7, side: THREE.DoubleSide,
  }));
  const z = o.size + 0.5;
  return [
    deck,
    cyl(0.08, 0.08, postH, postMat, { y: postH / 2, z }, 6),
    plane(1.2, 0.7, flagMat, { x: 0.6, y: postH - 0.4, z }),
  ];
};

/** A launch kicker: rise along the run rather than across the width. */
const kicker: ObjectMeshBuilder = (ctx, o) => {
  const len = o.length ?? 4;
  const tilt = Math.atan2(o.height, len);
  const top = cautionStripeMaterial(ctx);
  const side = solid(ctx, 0x6b4f2a, 0.85);
  const mats = [side, side, top, side, side, side];
  return [
    box(Math.hypot(len, o.height), 0.12, o.size * 2, mats, {
      y: o.height / 2, rz: tilt,
    }),
  ];
};

const tyreStack: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, 0x1c1c1e, 0.95);
  const rings = Math.max(2, Math.round(o.height / (o.size * 0.56)));
  const step = o.height / rings;
  const out: THREE.Object3D[] = [];
  for (let i = 0; i < rings; i++) {
    out.push(tyre(mat, o.size, {
      y: step * (i + 0.5), rx: Math.PI / 2, rz: ctx.h(o, `tyre${i}`) * Math.PI,
    }));
  }
  return out;
};

const tyreWall: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, 0x1c1c1e, 0.95);
  const len = o.length ?? 6;
  const rows = Math.max(1, Math.round(o.height / (o.size * 1.7)));
  const cols = Math.max(1, Math.round(len / (o.size * 1.9)));
  const out: THREE.Object3D[] = [];
  for (let r = 0; r < rows; r++) {
    // Half-offset alternate rows so it reads as stacked, not gridded.
    const inset = r % 2 === 1 ? (len / cols) / 2 : 0;
    out.push(...repeatX(cols, len - len / cols, (_i, x) =>
      tyre(mat, o.size, { x: x + inset, y: o.size + r * o.size * 1.7 })));
  }
  return out;
};

const culvertPipe: ObjectMeshBuilder = (ctx, o) => {
  const body = solid(ctx, 0x6a6f74, 0.85, true);
  const rib = solid(ctx, 0x585d62, 0.85);
  const len = o.length ?? 5;
  const out: THREE.Object3D[] = [lyingCyl(o.size, len, body, { y: o.size }, 14)];
  // Rim rings, and ribs along the run: a smooth grey tube reads as plastic.
  out.push(...repeatX(6, len * 0.8, (_i, x) =>
    torus(o.size * 1.02, o.size * 0.05, rib, { x, y: o.size, ry: Math.PI / 2 })));
  for (const x of [-len / 2, len / 2]) {
    out.push(torus(o.size * 1.04, o.size * 0.08, rib, { x, y: o.size, ry: Math.PI / 2 }));
  }
  return out;
};

const concreteBlock: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, ctx.pick([0x9a9a94, 0x8e8e88, 0xa4a49c], o, 'concrete'), 0.95);
  const len = o.length ?? 2;
  const out: THREE.Object3D[] = [box(len, o.height, o.size * 2, mat, { y: o.height / 2 })];
  // Two lifting eyes on the top face.
  const eye = metal(ctx, 0x6a6a68, 0.6);
  out.push(...repeatX(2, len * 0.5, (_i, x) =>
    torus(0.09, 0.025, eye, { x, y: o.height + 0.05, rx: Math.PI / 2 })));
  return out;
};

const jerseyBarrier: ObjectMeshBuilder = (ctx, o) => {
  const white = solid(ctx, 0xd8d6cf, 0.9);
  const orange = solid(ctx, 0xd4681f, 0.9);
  const len = o.length ?? 3;
  // Two stacked boxes approximate the tapered profile.
  return [
    box(len, o.height * 0.38, o.size * 2, white, { y: o.height * 0.19 }),
    box(len, o.height * 0.62, o.size * 1.15, white, { y: o.height * 0.69 }),
    box(len * 0.08, o.height * 0.62, o.size * 1.2, orange, { x: -len / 2 + len * 0.05, y: o.height * 0.69 }),
    box(len * 0.08, o.height * 0.62, o.size * 1.2, orange, { x: len / 2 - len * 0.05, y: o.height * 0.69 }),
  ];
};

const plankBridge: ObjectMeshBuilder = (ctx, o) => {
  const deckMat = solid(ctx, 0x8a6a42, 0.92);
  const beam = solid(ctx, TRUNK_COLOR, 0.95);
  const len = o.length ?? 6;
  const boards = Math.max(3, Math.round(o.size * 2 / 0.22));
  const out: THREE.Object3D[] = [
    ...plankDeck(len, o.size * 2, 0.07, boards, deckMat, o.height),
  ];
  // Trestle legs at both ends, so the deck reads as spanning something.
  for (const x of [-len / 2 + 0.2, len / 2 - 0.2]) {
    for (const z of [-o.size + 0.15, o.size - 0.15]) {
      out.push(cyl(0.07, 0.09, o.height, beam, { x, y: o.height / 2, z }, 6));
    }
  }
  return out;
};

const logCrossing: ObjectMeshBuilder = (ctx, o) => {
  const bark = solid(ctx, TRUNK_COLOR, 0.98, true);
  const len = o.length ?? 5;
  // Three logs side by side across the driving line, plus two chocks.
  const out: THREE.Object3D[] = [];
  for (let i = 0; i < 3; i++) {
    const z = (i - 1) * o.size * 2.1;
    out.push(lyingCyl(o.size, len, bark, { y: o.size, z }));
  }
  for (const x of [-len / 2 + 0.3, len / 2 - 0.3]) {
    out.push(box(0.3, o.size * 0.8, o.size * 6.6, bark, { x, y: o.size * 0.4 }));
  }
  return out;
};

const cattleGrid: ObjectMeshBuilder = (ctx, o) => {
  const frame = solid(ctx, 0x6a6a64, 0.9);
  const bar = metal(ctx, 0x8a8a84, 0.5);
  const len = o.length ?? 3;
  const out: THREE.Object3D[] = [
    // Pit walls either side of the run.
    box(len, o.height, 0.16, frame, { y: o.height / 2, z: -o.size }),
    box(len, o.height, 0.16, frame, { y: o.height / 2, z: o.size }),
  ];
  const bars = Math.max(4, Math.round(len / 0.22));
  out.push(...repeatX(bars, len * 0.92, (_i, x) =>
    cyl(0.045, 0.045, o.size * 2, bar, { x, y: o.height, rx: Math.PI / 2 }, 6)));
  return out;
};

export const TRAIL_MESHES = {
  ramp, kicker, tyreStack, tyreWall, culvertPipe, concreteBlock,
  jerseyBarrier, plankBridge, logCrossing, cattleGrid,
} satisfies Record<string, ObjectMeshBuilder>;
