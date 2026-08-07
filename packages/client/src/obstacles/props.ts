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

const fuelPump: ObjectMeshBuilder = (ctx, o) => {
  const body = solid(ctx, ctx.pick([0xb94836, 0x336f78, 0xd2aa36], o, 'pump'), 0.78);
  const trim = metal(ctx, 0xd4d0c5, 0.48);
  const dark = solid(ctx, 0x20272a, 0.75);
  const hose = solid(ctx, 0x202020, 0.9);
  const w = o.length ?? 0.75;
  return [
    box(w * 1.15, 0.12, o.size * 2.2, trim, { y: 0.06 }),
    box(w, o.height * 0.84, o.size * 2, body, { y: o.height * 0.48 }),
    box(w * 0.72, o.height * 0.2, 0.035, dark, {
      y: o.height * 0.68, z: o.size + 0.02,
    }),
    box(w * 1.05, o.height * 0.12, o.size * 2.08, trim, { y: o.height * 0.94 }),
    torus(o.height * 0.2, 0.025, hose, {
      x: w * 0.56, y: o.height * 0.48, z: 0, ry: Math.PI / 2,
    }),
    box(0.08, o.height * 0.24, 0.1, dark, {
      x: w * 0.62, y: o.height * 0.68, z: o.size * 0.3, rz: -0.2,
    }),
  ];
};

const generator: ObjectMeshBuilder = (ctx, o) => {
  const frame = metal(ctx, 0x2f3335, 0.5);
  const engine = solid(ctx, ctx.pick([0xd55f25, 0xd3a72f, 0x3b6e8c], o, 'generator'), 0.78);
  const dark = solid(ctx, 0x232526, 0.92);
  const len = o.length ?? 1.2;
  const w = o.size * 2;
  const tube = 0.055;
  const out: THREE.Object3D[] = [
    box(len * 0.7, o.height * 0.58, w * 0.72, engine, { y: o.height * 0.46 }),
    box(len * 0.28, o.height * 0.42, w * 0.76, dark, {
      x: len * 0.28, y: o.height * 0.47,
    }),
  ];
  for (const y of [tube, o.height - tube]) {
    for (const z of [-w / 2, w / 2]) out.push(box(len, tube * 2, tube * 2, frame, { y, z }));
  }
  for (const x of [-len / 2, len / 2]) {
    for (const z of [-w / 2, w / 2]) out.push(box(tube * 2, o.height, tube * 2, frame, { x, y: o.height / 2, z }));
  }
  for (const x of [-len * 0.32, len * 0.32]) {
    out.push(cyl(o.height * 0.15, o.height * 0.15, w * 1.08, dark, {
      x, y: o.height * 0.15, rx: Math.PI / 2,
    }, 10));
  }
  return out;
};

const portableToilet: ObjectMeshBuilder = (ctx, o) => {
  const body = solid(ctx, ctx.pick([0x287aa1, 0x267a58, 0x8b63a6], o, 'toilet'), 0.86);
  const dark = solid(ctx, 0x26333a, 0.82);
  const white = solid(ctx, 0xd7dedb, 0.82);
  const w = o.length ?? 1.15;
  return [
    box(w * 1.08, 0.12, o.size * 2.08, dark, { y: 0.06 }),
    box(w, o.height * 0.91, o.size * 2, body, { y: o.height * 0.48 }),
    box(w * 0.86, o.height * 0.82, 0.035, dark, {
      y: o.height * 0.47, z: o.size + 0.02,
    }),
    box(w * 0.28, 0.05, 0.04, white, {
      y: o.height * 0.62, z: o.size + 0.045,
    }),
    cyl(0.055, 0.055, o.height * 0.28, dark, {
      x: -w * 0.32, y: o.height * 1.05, z: -o.size * 0.3,
    }, 7),
    box(w * 1.08, o.height * 0.08, o.size * 2.08, body, {
      y: o.height * 0.96, rz: 0.03,
    }),
  ];
};

const streetLight: ObjectMeshBuilder = (ctx, o) => {
  const pole = metal(ctx, 0x777d80, 0.46);
  const lamp = solid(ctx, 0xe4deae, 0.5);
  const arm = o.height * 0.18;
  return [
    cyl(o.size * 0.7, o.size, o.height * 0.9, pole, { y: o.height * 0.45 }, 9),
    lyingCyl(o.size * 0.62, arm, pole, {
      x: arm / 2, y: o.height * 0.9,
    }, 8),
    box(arm * 0.42, o.size * 1.4, o.size * 2.5, pole, {
      x: arm, y: o.height * 0.88,
    }),
    box(arm * 0.34, 0.025, o.size * 2, lamp, {
      x: arm, y: o.height * 0.8,
    }),
  ];
};

const bench: ObjectMeshBuilder = (ctx, o) => {
  const timber = solid(ctx, ctx.pick([0x7f5d3a, 0x8c6943, 0x6f5438], o, 'bench'), 0.93);
  const frame = metal(ctx, 0x383b3c, 0.58);
  const len = o.length ?? 1.8;
  const out: THREE.Object3D[] = [];
  for (const z of [-o.size * 0.55, 0, o.size * 0.55]) {
    out.push(box(len, 0.08, o.size * 0.48, timber, { y: o.height * 0.52, z }));
  }
  for (let i = 0; i < 3; i++) {
    out.push(box(len, 0.08, o.size * 0.45, timber, {
      y: o.height * (0.66 + i * 0.13), z: -o.size * 0.82, rx: -0.12,
    }));
  }
  for (const x of [-len * 0.36, len * 0.36]) {
    out.push(box(0.08, o.height * 0.56, 0.08, frame, { x, y: o.height * 0.28, z: o.size * 0.45 }));
    out.push(box(0.08, o.height * 0.92, 0.08, frame, { x, y: o.height * 0.46, z: -o.size * 0.72 }));
  }
  return out;
};

const roadworkBarrier: ObjectMeshBuilder = (ctx, o) => {
  const orange = solid(ctx, 0xe56a1d, 0.78);
  const white = solid(ctx, 0xf1eee5, 0.76);
  const dark = solid(ctx, 0x303234, 0.9);
  const len = o.length ?? 2.4;
  const out: THREE.Object3D[] = [];
  for (const x of [-len / 2, len / 2]) {
    out.push(cyl(o.size, o.size, o.height, dark, { x, y: o.height / 2 }, 8));
    out.push(box(o.size * 5, 0.055, o.size * 3, dark, { x, y: 0.03 }));
  }
  const segments = 7;
  out.push(...repeatX(segments, len - len / segments, (i, x) =>
    box(len / segments + 0.015, o.height * 0.2, o.size * 2, i % 2 ? white : orange, {
      x, y: o.height * 0.72,
    })));
  return out;
};

const checkpointArch: ObjectMeshBuilder = (ctx, o) => {
  const orange = solid(ctx, 0xe85c1c, 0.75);
  const dark = solid(ctx, 0x25282a, 0.82);
  const white = solid(ctx, 0xf0eee7, 0.74);
  const half = (o.length ?? 4.5) / 2;
  const out: THREE.Object3D[] = [];
  for (const x of [-half, half]) {
    out.push(cyl(o.size, o.size * 1.25, o.height, orange, { x, y: o.height / 2 }, 8));
    for (let i = 0; i < 4; i++) {
      out.push(box(o.size * 2.05, o.height * 0.11, o.size * 2.05, i % 2 ? white : dark, {
        x, y: o.height * (0.22 + i * 0.18),
      }));
    }
  }
  out.push(
    box(half * 2 + o.size * 2, o.size * 2, o.size * 2, orange, {
      y: o.height - o.size,
    }),
    box(half * 1.08, o.size * 1.2, o.size * 2.1, dark, {
      y: o.height - o.size,
    }),
  );
  return out;
};

const campTent: ObjectMeshBuilder = (ctx, o) => {
  const canvas = solid(ctx, ctx.pick([0x6f7845, 0x9b7b4c, 0x5e6d58], o, 'tent'), 0.94);
  const ground = solid(ctx, 0x49483f, 0.98);
  const pole = metal(ctx, 0x767875, 0.58);
  const len = o.length ?? 2.4;
  const slope = Math.atan2(o.height, o.size);
  const panel = Math.hypot(o.height, o.size);
  return [
    box(len, 0.035, o.size * 2, ground, { y: 0.018 }),
    box(len, 0.045, panel, canvas, {
      y: o.height / 2, z: o.size / 2, rx: slope,
    }),
    box(len, 0.045, panel, canvas, {
      y: o.height / 2, z: -o.size / 2, rx: -slope,
    }),
    lyingCyl(0.025, len * 1.08, pole, { y: o.height }, 6),
    cyl(0.025, 0.025, o.height, pole, {
      x: -len / 2, y: o.height / 2,
    }, 6),
    cyl(0.025, 0.025, o.height, pole, {
      x: len / 2, y: o.height / 2,
    }, 6),
  ];
};

const woodPile: ObjectMeshBuilder = (ctx, o) => {
  const bark = solid(ctx, TRUNK_COLOR, 0.98, true);
  const cut = solid(ctx, 0xa6855c, 0.92);
  const len = o.length ?? 2.5;
  const rows = Math.max(2, Math.round(o.height / 0.28));
  const out: THREE.Object3D[] = [];
  for (let row = 0; row < rows; row++) {
    const logs = Math.max(2, rows - Math.floor(row / 2));
    for (let j = 0; j < logs; j++) {
      const r = Math.min(0.16, o.height / rows * 0.46);
      const z = (j - (logs - 1) / 2) * r * 1.8;
      const y = r + row * r * 1.65;
      out.push(
        lyingCyl(r, len * (0.88 + ctx.h(o, `log${row}-${j}`) * 0.12), bark, { y, z }, 7),
        cyl(r * 0.9, r * 0.9, 0.025, cut, {
          x: len * 0.45, y, z, rz: Math.PI / 2,
        }, 7),
      );
    }
  }
  // Uprights at the ends keep the stack visually contained.
  for (const x of [-len / 2, len / 2]) {
    out.push(cyl(0.06, 0.07, o.height, bark, { x, y: o.height / 2, z: o.size * 0.75 }, 7));
  }
  return out;
};

const waterTrough: ObjectMeshBuilder = (ctx, o) => {
  const steel = metal(ctx, 0x858d8c, 0.62);
  const water = ctx.mat('troughWater', () => new THREE.MeshStandardMaterial({
    color: 0x416f7b, roughness: 0.3, metalness: 0.05,
  }));
  const len = o.length ?? 2.4;
  const rim = 0.08;
  return [
    box(len, o.height, rim, steel, { y: o.height / 2, z: -o.size }),
    box(len, o.height, rim, steel, { y: o.height / 2, z: o.size }),
    box(rim, o.height, o.size * 2, steel, { x: -len / 2, y: o.height / 2 }),
    box(rim, o.height, o.size * 2, steel, { x: len / 2, y: o.height / 2 }),
    box(len, rim, o.size * 2, steel, { y: rim / 2 }),
    box(len - rim * 2, 0.025, o.size * 2 - rim * 2, water, { y: o.height * 0.72 }),
  ];
};

const farmWindmill: ObjectMeshBuilder = (ctx, o) => {
  const steel = metal(ctx, 0x747b7c, 0.56);
  const rust = solid(ctx, 0x86563b, 0.9);
  const rotorR = o.height * 0.19;
  const rotorY = o.height * 0.82;
  const out: THREE.Object3D[] = [
    cyl(o.size * 0.55, o.size, o.height, steel, { y: o.height / 2 }, 7),
    torus(rotorR, o.size * 0.32, rust, {
      x: o.size * 1.2, y: rotorY, ry: Math.PI / 2,
    }),
    cyl(o.size * 0.25, o.size * 0.25, rotorR * 2, rust, {
      x: o.size * 1.2, y: rotorY,
    }, 6),
    cyl(o.size * 0.25, o.size * 0.25, rotorR * 2, rust, {
      x: o.size * 1.2, y: rotorY, rx: Math.PI / 2,
    }, 6),
  ];
  // Wide footings and braces give the narrow tower a farm-windmill silhouette.
  for (const z of [-rotorR * 0.45, rotorR * 0.45]) {
    out.push(box(o.size, o.height * 0.75, o.size, steel, {
      y: o.height * 0.36, z, rx: z < 0 ? -0.12 : 0.12,
    }));
  }
  return out;
};

const solarPanel: ObjectMeshBuilder = (ctx, o) => {
  const frame = metal(ctx, 0x737b7e, 0.48);
  const cell = solid(ctx, 0x173a55, 0.34);
  const len = o.length ?? 2.4;
  const out: THREE.Object3D[] = [];
  for (const x of [-len * 0.3, len * 0.3]) {
    out.push(cyl(0.055, 0.07, o.height * 0.8, frame, { x, y: o.height * 0.4 }, 7));
  }
  const panel = new THREE.Group();
  panel.position.y = o.height * 0.8;
  panel.rotation.x = -0.35;
  panel.add(box(len, 0.1, o.size * 2, frame, { recv: true }));
  const cols = 6;
  const rows = 3;
  for (let x = 0; x < cols; x++) {
    for (let z = 0; z < rows; z++) {
      panel.add(box(len / cols - 0.025, 0.012, o.size * 2 / rows - 0.025, cell, {
        x: -len / 2 + (x + 0.5) * len / cols,
        y: 0.058,
        z: -o.size + (z + 0.5) * o.size * 2 / rows,
      }));
    }
  }
  out.push(panel);
  return out;
};

const oldTractor: ObjectMeshBuilder = (ctx, o) => {
  const paint = solid(ctx, ctx.pick([0x6d7938, 0xa35831, 0x9b8a3a], o, 'tractor'), 0.9, true);
  const rust = solid(ctx, ctx.pick(RUST_COLORS, o, 'tractorRust'), 0.98, true);
  const tyreMat = solid(ctx, 0x232322, 0.96);
  const seat = solid(ctx, 0x322b25, 0.95);
  const len = o.length ?? 3.2;
  const out: THREE.Object3D[] = [
    box(len * 0.52, o.height * 0.34, o.size * 1.3, paint, {
      x: len * 0.2, y: o.height * 0.56,
    }),
    box(len * 0.28, o.height * 0.12, o.size * 0.9, rust, {
      x: -len * 0.23, y: o.height * 0.75,
    }),
    box(len * 0.2, o.height * 0.3, o.size * 0.65, seat, {
      x: -len * 0.22, y: o.height * 0.92, rz: -0.12,
    }),
    cyl(0.055, 0.07, o.height * 0.82, rust, {
      x: len * 0.33, y: o.height * 1.02, z: -o.size * 0.38,
    }, 7),
  ];
  for (const [x, r] of [[-len * 0.3, o.height * 0.34], [len * 0.3, o.height * 0.23]] as const) {
    for (const z of [-o.size, o.size]) {
      out.push(cyl(r, r, o.size * 0.34, tyreMat, { x, y: r, z, rx: Math.PI / 2 }, 12));
      out.push(cyl(r * 0.42, r * 0.42, o.size * 0.36, rust, { x, y: r, z, rx: Math.PI / 2 }, 10));
    }
  }
  return out;
};

export const PROP_MESHES = {
  barrel, crate, pallet, hayBale, trafficCone, bollard, fencePost, fenceRun,
  gate, signpost, telegraphPole, windSock, campfire, picnicTable, flagpole,
  wreckCar, fuelPump, generator, portableToilet, streetLight, bench,
  roadworkBarrier, checkpointArch, campTent, woodPile, waterTrough,
  farmWindmill, solarPanel, oldTractor,
} satisfies Record<string, ObjectMeshBuilder>;
