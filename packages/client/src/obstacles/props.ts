// Things people left lying around.

import * as THREE from 'three';
import {
  BARREL_COLORS, RUST_COLORS, TRUNK_COLOR, metal, solid,
} from './materials.js';
import { box, cone, cyl, lyingCyl, plane, repeatX, torus } from './prims.js';
import type { ObjectMeshBuilder } from './types.js';

const barrel: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, ctx.pick(BARREL_COLORS, o, 'tint'), 0.75);
  const rim = metal(ctx, 0x9a9a92, 0.55);
  return [
    cyl(o.size, o.size, o.height, mat, { y: o.height / 2 }, 12),
    torus(o.size * 1.02, o.size * 0.06, rim, { y: o.height * 0.28, rx: Math.PI / 2 }),
    torus(o.size * 1.02, o.size * 0.06, rim, { y: o.height * 0.72, rx: Math.PI / 2 }),
    cyl(o.size * 0.94, o.size * 0.94, 0.04, rim, { y: o.height + 0.02 }, 12),
  ];
};

const crate: ObjectMeshBuilder = (ctx, o) => {
  const body = solid(ctx, 0x9a7448, 0.92);
  const batten = solid(ctx, 0x7a5a34, 0.94);
  const w = o.size * 2;
  const len = o.length ?? w;
  const out: THREE.Object3D[] = [box(len, o.height, w, body, { y: o.height / 2 })];
  // Corner battens + a diagonal on the long faces.
  for (const x of [-len / 2, len / 2]) {
    out.push(box(0.06, o.height, w + 0.04, batten, { x, y: o.height / 2 }));
  }
  for (const z of [-w / 2, w / 2]) {
    out.push(box(len + 0.04, 0.06, 0.06, batten, { y: o.height - 0.05, z }));
    out.push(box(len + 0.04, 0.06, 0.06, batten, { y: 0.05, z }));
    out.push(box(Math.hypot(len, o.height) - 0.1, 0.05, 0.05, batten, {
      y: o.height / 2, z, rz: Math.atan2(o.height, len),
    }));
  }
  return out;
};

const pallet: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, 0xa8875c, 0.95);
  const w = o.size * 2;
  const len = o.length ?? 1.2;
  const out: THREE.Object3D[] = [];
  out.push(...repeatX(6, w - w / 6, (_i, z) =>
    box(len, 0.03, w / 6 - 0.02, mat, { y: o.height, z })));
  // Three bearers underneath.
  for (const z of [-w / 2 + 0.08, 0, w / 2 - 0.08]) {
    out.push(box(len, o.height - 0.03, 0.1, mat, { y: (o.height - 0.03) / 2, z }));
  }
  return out;
};

const hayBale: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, ctx.pick([0xc9ab63, 0xbfa059, 0xd2b671], o, 'straw'), 0.98, true);
  const twine = solid(ctx, 0x8a7a48, 0.95);
  const len = o.length ?? 1.4;
  const out: THREE.Object3D[] = [lyingCyl(o.size, len, mat, { y: o.size }, 14)];
  out.push(...repeatX(3, len * 0.6, (_i, x) =>
    torus(o.size * 1.01, o.size * 0.02, twine, { x, y: o.size, ry: Math.PI / 2 })));
  return out;
};

const trafficCone: ObjectMeshBuilder = (ctx, o) => {
  const orange = solid(ctx, 0xe25a12, 0.8);
  const white = solid(ctx, 0xe8e4dc, 0.8);
  return [
    box(o.size * 2, 0.04, o.size * 2, orange, { y: 0.02 }),
    cone(o.size * 0.72, o.height, orange, { y: o.height / 2 + 0.03 }, 10),
    cyl(o.size * 0.42, o.size * 0.5, o.height * 0.14, white, { y: o.height * 0.6 }, 10),
  ];
};

const bollard: ObjectMeshBuilder = (ctx, o) => {
  const mat = metal(ctx, ctx.pick([0xd8d4cc, 0xd4a017], o, 'bollard'), 0.5);
  return [
    cyl(o.size, o.size, o.height, mat, { y: o.height / 2 }, 10),
    cyl(o.size, o.size, o.size, mat, { y: o.height }, 10),
  ];
};

const fencePost: ObjectMeshBuilder = (ctx, o) => [
  box(o.size * 2, o.height, o.size * 2, solid(ctx, 0x8a7a5c, 0.96), { y: o.height / 2 }),
];

const fenceRun: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, 0x8a7a5c, 0.96);
  const len = o.length ?? 8;
  const posts = Math.max(2, Math.round(len / 2.5) + 1);
  const out: THREE.Object3D[] = [];
  out.push(...repeatX(posts, len, (_i, x) =>
    box(o.size * 2, o.height, o.size * 2, mat, { x, y: o.height / 2 })));
  for (const y of [o.height * 0.4, o.height * 0.82]) {
    out.push(box(len, 0.07, 0.05, mat, { y }));
  }
  return out;
};

const gate: ObjectMeshBuilder = (ctx, o) => {
  const post = solid(ctx, 0x8a7a5c, 0.96);
  const bar = metal(ctx, 0xb8bcc0, 0.55);
  const w = o.length ?? 3.5;
  const out: THREE.Object3D[] = [];
  for (const x of [-w / 2, w / 2]) {
    out.push(cyl(o.size, o.size * 1.2, o.height, post, { x, y: o.height / 2 }, 7));
  }
  for (let i = 0; i < 3; i++) {
    out.push(box(w, 0.06, 0.05, bar, { y: o.height * (0.3 + i * 0.24) }));
  }
  out.push(box(Math.hypot(w, o.height * 0.48), 0.05, 0.04, bar, {
    y: o.height * 0.54, rz: Math.atan2(o.height * 0.48, w),
  }));
  return out;
};

const signpost: ObjectMeshBuilder = (ctx, o) => {
  const post = metal(ctx, 0x9a9a94, 0.5);
  const face = solid(ctx, ctx.pick([0x2d6b3a, 0xd4b017, 0xd8d4cc], o, 'sign'), 0.7);
  const panelW = (o.length ?? 1.2);
  const panelH = panelW * 0.55;
  return [
    cyl(o.size, o.size, o.height, post, { y: o.height / 2 }, 8),
    box(0.05, panelH, panelW, face, { y: o.height - panelH / 2 - 0.1 }),
  ];
};

const telegraphPole: ObjectMeshBuilder = (ctx, o) => {
  const wood = solid(ctx, 0x6a5640, 0.96);
  const insul = solid(ctx, 0x3a4a55, 0.6);
  const arm = o.height * 0.22;
  const out: THREE.Object3D[] = [
    cyl(o.size * 0.75, o.size, o.height, wood, { y: o.height / 2 }, 8),
    box(0.09, 0.09, arm, wood, { y: o.height * 0.9 }),
  ];
  // Insulators sit along the crossarm, which runs across the pole on Z.
  for (let i = 0; i < 4; i++) {
    const z = (i / 3 - 0.5) * arm * 0.82;
    out.push(cyl(0.05, 0.05, 0.12, insul, { y: o.height * 0.92, z }, 6));
  }
  return out;
};

const windSock: ObjectMeshBuilder = (ctx, o) => {
  const post = metal(ctx, 0xc8ccd0, 0.5);
  const orange = ctx.mat('sockOrange', () => new THREE.MeshStandardMaterial({
    color: 0xff6a1f, roughness: 0.8, side: THREE.DoubleSide,
  }));
  const white = ctx.mat('sockWhite', () => new THREE.MeshStandardMaterial({
    color: 0xf0ece4, roughness: 0.8, side: THREE.DoubleSide,
  }));
  const out: THREE.Object3D[] = [cyl(o.size, o.size, o.height, post, { y: o.height / 2 }, 8)];
  // Open cone sleeve, banded, streaming off the top along +X.
  for (let i = 0; i < 4; i++) {
    const r = 0.34 - i * 0.06;
    out.push(cyl(r, r + 0.06, 0.32, i % 2 === 0 ? orange : white, {
      x: 0.34 + i * 0.32, y: o.height - 0.1 - i * 0.05, rz: Math.PI / 2 + 0.12,
    }, 10));
  }
  return out;
};

const campfire: ObjectMeshBuilder = (ctx, o) => {
  const stone = solid(ctx, 0x6f6864, 0.9, true);
  const char = solid(ctx, 0x2a2420, 0.98, true);
  const ash = solid(ctx, 0x8a8378, 0.98);
  const out: THREE.Object3D[] = [
    cyl(o.size * 0.7, o.size * 0.7, 0.03, ash, { y: 0.015 }, 12),
  ];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = o.size * 0.24;
    out.push(cyl(r, r * 1.2, r * 1.4, stone, {
      x: Math.cos(a) * o.size * 0.85, y: r * 0.7, z: Math.sin(a) * o.size * 0.85,
    }, 6));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    out.push(lyingCyl(o.size * 0.11, o.size * 1.1, char, {
      y: o.size * 0.18, ry: a, rz: 0.22,
    }, 6));
  }
  return out;
};

const picnicTable: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, TRUNK_COLOR, 0.95);
  const len = o.length ?? 2;
  const w = o.size * 2;
  const out: THREE.Object3D[] = [box(len, 0.06, w, mat, { y: o.height })];
  for (const x of [-len / 2 + 0.2, len / 2 - 0.2]) {
    out.push(box(0.08, o.height, w * 1.4, mat, { x, y: o.height / 2 }));
  }
  for (const z of [-w * 0.62, w * 0.62]) {
    out.push(box(len, 0.05, w * 0.28, mat, { y: o.height * 0.58, z }));
  }
  return out;
};

const flagpole: ObjectMeshBuilder = (ctx, o) => {
  // Summit marker: tall metal pole with a bright orange flag.
  const post = metal(ctx, 0xdde4ee);
  const flagMat = ctx.mat('flag', () => new THREE.MeshStandardMaterial({
    color: 0xff5a1f, roughness: 0.7, side: THREE.DoubleSide,
  }));
  return [
    cyl(0.06, 0.09, o.height, post, { y: o.height / 2 }, 6),
    plane(1.6, 0.9, flagMat, { x: 0.8, y: o.height - 0.45 }),
  ];
};

const wreckCar: ObjectMeshBuilder = (ctx, o) => {
  const body = solid(ctx, ctx.pick(RUST_COLORS, o, 'rust'), 0.98, true);
  const dark = solid(ctx, 0x24201c, 0.95);
  const len = o.length ?? 4;
  const w = o.size * 2;
  const out: THREE.Object3D[] = [
    box(len, o.height * 0.55, w, body, { y: o.height * 0.28 }),
    box(len * 0.46, o.height * 0.45, w * 0.86, body, {
      x: -len * 0.06, y: o.height * 0.72, rz: 0.04,
    }),
    // Empty window band, so it reads as a shell rather than a parked car.
    box(len * 0.42, o.height * 0.2, w * 0.9, dark, { x: -len * 0.06, y: o.height * 0.8 }),
  ];
  for (const x of [-len * 0.32, len * 0.32]) {
    for (const z of [-w * 0.46, w * 0.46]) {
      const wheel = cyl(o.height * 0.22, o.height * 0.22, 0.16, dark, {
        x, y: o.height * 0.16, z, rx: Math.PI / 2,
      }, 8);
      wheel.scale.y = 0.7; // flat tyres
      out.push(wheel);
    }
  }
  return out;
};

export const PROP_MESHES = {
  barrel, crate, pallet, hayBale, trafficCone, bollard, fencePost, fenceRun,
  gate, signpost, telegraphPole, windSock, campfire, picnicTable, flagpole,
  wreckCar,
} satisfies Record<string, ObjectMeshBuilder>;
