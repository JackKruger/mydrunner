// Buildings and the big fixed hardware.

import * as THREE from 'three';
import { CONTAINER_COLORS, metal, solid } from './materials.js';
import { box, cyl, lyingCyl, plankDeck, repeatX, ribbedBox, torus } from './prims.js';
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

const horizontalTank: ObjectMeshBuilder = (ctx, o) => {
  const tank = metal(ctx, ctx.pick([0xa3a8a4, 0x808b86, 0xb0a48d], o, 'tank'), 0.62);
  const band = metal(ctx, 0x686d6b, 0.5);
  const dark = solid(ctx, 0x4a4d4c, 0.9);
  const len = o.length ?? 4;
  const cy = o.size + 0.35;
  const out: THREE.Object3D[] = [
    lyingCyl(o.size, len, tank, { y: cy }, 18),
  ];
  for (const x of [-len * 0.32, 0, len * 0.32]) {
    out.push(torus(o.size * 1.01, o.size * 0.045, band, {
      x, y: cy, ry: Math.PI / 2,
    }));
  }
  // Two shallow concrete saddles keep the tank visibly off the ground.
  for (const x of [-len * 0.3, len * 0.3]) {
    out.push(box(o.size * 0.35, 0.42, o.size * 1.35, dark, {
      x, y: 0.21,
    }));
  }
  out.push(
    cyl(o.size * 0.1, o.size * 0.1, o.size * 0.45, band, {
      y: cy + o.size * 1.12,
    }, 8),
    cyl(o.size * 0.17, o.size * 0.17, 0.05, band, {
      y: cy + o.size * 1.36,
    }, 8),
  );
  return out;
};

const watchtower: ObjectMeshBuilder = (ctx, o) => {
  const timber = solid(ctx, 0x5e4934, 0.96);
  const deck = solid(ctx, 0x806747, 0.93);
  const wall = solid(ctx, 0x927e5d, 0.9);
  const roof = metal(ctx, 0x59636a, 0.62);
  const dark = solid(ctx, 0x263038, 0.75);
  const w = o.length ?? 2.4;
  const halfX = w / 2;
  const out: THREE.Object3D[] = [];
  for (const x of [-halfX + 0.14, halfX - 0.14]) {
    for (const z of [-o.size + 0.14, o.size - 0.14]) {
      out.push(cyl(0.1, 0.13, o.height, timber, { x, y: o.height / 2, z }, 7));
    }
  }
  out.push(
    box(w, 0.16, o.size * 2, deck, { y: o.height, recv: true }),
    box(w * 0.72, o.height * 0.42, o.size * 1.34, wall, {
      y: o.height * 1.22,
    }),
    box(w * 0.5, o.height * 0.16, o.size * 1.38, dark, {
      y: o.height * 1.25, z: o.size * 0.68,
    }),
    box(w * 0.92, 0.1, o.size * 1.72, roof, {
      y: o.height * 1.46,
    }),
  );
  // Cross-bracing makes the open lower frame read as a tower.
  for (const z of [-o.size + 0.12, o.size - 0.12]) {
    for (const dir of [-1, 1]) {
      out.push(box(Math.hypot(w * 0.78, o.height * 0.72), 0.08, 0.08, timber, {
        y: o.height * 0.47,
        z,
        rz: dir * Math.atan2(o.height * 0.72, w * 0.78),
      }));
    }
  }
  // Simple ladder on the front side.
  for (const x of [-w * 0.18, w * 0.18]) {
    out.push(box(0.06, o.height, 0.06, timber, {
      x, y: o.height / 2, z: o.size + 0.08,
    }));
  }
  const rungs = Math.max(4, Math.round(o.height / 0.42));
  for (let i = 1; i < rungs; i++) {
    out.push(box(w * 0.4, 0.045, 0.06, timber, {
      y: i * o.height / rungs, z: o.size + 0.08,
    }));
  }
  return out;
};

const bushHut: ObjectMeshBuilder = (ctx, o) => {
  const wallTint = ctx.pick([0x81796c, 0x8b735c, 0x6f756e], o, 'hutWall');
  const wall = solid(ctx, wallTint, 0.94);
  const rib = solid(ctx, wallTint, 0.99);
  const roof = metal(ctx, ctx.pick([0x797a74, 0x765b49, 0x686f70], o, 'hutRoof'), 0.76);
  const door = solid(ctx, 0x554638, 0.96);
  const dark = solid(ctx, 0x29343a, 0.75);
  const len = o.length ?? 4;
  const w = o.size * 2;
  const slope = Math.atan2(o.height * 0.28, o.size);
  const panel = Math.hypot(o.size, o.height * 0.28) + 0.14;
  const out: THREE.Object3D[] = [...ribbedBox(len, o.height, w, 10, wall, rib)];
  for (const side of [-1, 1]) {
    out.push(box(len + 0.25, 0.07, panel, roof, {
      y: o.height * 1.14,
      z: side * o.size / 2,
      rx: -side * slope,
      recv: true,
    }));
  }
  out.push(
    box(0.045, o.height * 0.72, w * 0.34, door, {
      x: -len / 2 - 0.025, y: o.height * 0.36,
    }),
    box(0.05, o.height * 0.26, w * 0.28, dark, {
      x: len / 2 + 0.03, y: o.height * 0.64,
    }),
    box(0.28, o.height * 0.62, 0.28, dark, {
      x: len * 0.28, y: o.height * 1.18, z: -o.size * 0.25,
    }),
  );
  return out;
};

const timberCabin: ObjectMeshBuilder = (ctx, o) => {
  const timber = solid(ctx, ctx.pick([0x71563b, 0x806247, 0x654e39], o, 'cabin'), 0.97, true);
  const trim = solid(ctx, 0x4b3a2b, 0.98);
  const roof = solid(ctx, 0x4f554f, 0.9);
  const glass = solid(ctx, 0x29404a, 0.62);
  const len = o.length ?? 5;
  const w = o.size * 2;
  const slope = Math.atan2(o.height * 0.34, o.size);
  const panel = Math.hypot(o.size, o.height * 0.34) + 0.18;
  const out: THREE.Object3D[] = [box(len, o.height, w, timber, { y: o.height / 2, recv: true })];
  // Horizontal log courses and heavy corner posts sell the cabin material.
  const courses = Math.max(5, Math.round(o.height / 0.28));
  for (let i = 1; i < courses; i++) {
    out.push(box(len + 0.04, 0.045, w + 0.05, trim, { y: i * o.height / courses }));
  }
  for (const x of [-len / 2, len / 2]) {
    for (const z of [-w / 2, w / 2]) {
      out.push(box(0.14, o.height, 0.14, trim, { x, y: o.height / 2, z }));
    }
  }
  for (const side of [-1, 1]) {
    out.push(box(len + 0.3, 0.1, panel, roof, {
      y: o.height * 1.17, z: side * o.size / 2, rx: -side * slope, recv: true,
    }));
  }
  out.push(
    box(0.05, o.height * 0.75, w * 0.3, trim, {
      x: -len / 2 - 0.03, y: o.height * 0.375,
    }),
    box(0.055, o.height * 0.28, w * 0.3, glass, {
      x: len / 2 + 0.03, y: o.height * 0.62,
    }),
  );
  return out;
};

const leanTo: ObjectMeshBuilder = (ctx, o) => {
  const timber = solid(ctx, 0x655039, 0.97);
  const roof = metal(ctx, 0x737875, 0.72);
  const len = o.length ?? 4;
  const halfX = len / 2;
  const out: THREE.Object3D[] = [];
  for (const x of [-halfX + 0.12, halfX - 0.12]) {
    for (const z of [-o.size + 0.12, o.size - 0.12]) {
      const front = z > 0;
      const h = o.height * (front ? 1 : 0.88);
      out.push(cyl(0.08, 0.11, h, timber, { x, y: h / 2, z }, 7));
    }
  }
  const tilt = Math.atan2(o.height * 0.12, o.size * 2);
  out.push(
    box(len + 0.22, 0.09, o.size * 2 + 0.22, roof, {
      y: o.height * 0.94, rx: tilt, recv: true,
    }),
    // A rough work bench against the rear posts.
    box(len * 0.58, 0.08, 0.6, timber, {
      y: o.height * 0.36, z: -o.size * 0.72,
    }),
  );
  return out;
};

const caravan: ObjectMeshBuilder = (ctx, o) => {
  const body = solid(ctx, ctx.pick([0xe0d7c1, 0xc8d3cf, 0xd8c8ad], o, 'caravan'), 0.86);
  const stripe = solid(ctx, ctx.pick([0x8a5a3c, 0x46758a, 0x7a7442], o, 'caravanStripe'), 0.8);
  const glass = solid(ctx, 0x263b45, 0.58);
  const trim = metal(ctx, 0x999d9b, 0.56);
  const tyre = solid(ctx, 0x222323, 0.96);
  const len = o.length ?? 5;
  const w = o.size * 2;
  const baseY = 0.35;
  const out: THREE.Object3D[] = [
    box(len, o.height, w, body, { y: baseY + o.height / 2, recv: true }),
    box(len + 0.08, o.height * 0.12, w + 0.08, stripe, { y: baseY + o.height * 0.42 }),
    box(len * 0.22, o.height * 0.3, 0.045, glass, {
      x: -len * 0.27, y: baseY + o.height * 0.68, z: o.size + 0.025,
    }),
    box(len * 0.22, o.height * 0.3, 0.045, glass, {
      x: len * 0.24, y: baseY + o.height * 0.68, z: o.size + 0.025,
    }),
    box(len * 0.15, o.height * 0.72, 0.05, stripe, {
      x: len * 0.02, y: baseY + o.height * 0.36, z: o.size + 0.03,
    }),
    box(len + 0.18, 0.11, w + 0.14, trim, { y: baseY + o.height + 0.04 }),
  ];
  for (const x of [-len * 0.25, len * 0.25]) {
    out.push(cyl(0.38, 0.38, 0.2, tyre, { x, y: 0.38, z: o.size, rx: Math.PI / 2 }, 12));
    out.push(cyl(0.38, 0.38, 0.2, tyre, { x, y: 0.38, z: -o.size, rx: Math.PI / 2 }, 12));
  }
  // Drawbar and hitch project from the front end.
  out.push(
    box(len * 0.28, 0.07, 0.07, trim, { x: len * 0.63, y: 0.42, z: -w * 0.2, ry: -0.18 }),
    box(len * 0.28, 0.07, 0.07, trim, { x: len * 0.63, y: 0.42, z: w * 0.2, ry: 0.18 }),
  );
  return out;
};

const bushDunny: ObjectMeshBuilder = (ctx, o) => {
  const timber = solid(ctx, ctx.pick([0x77654e, 0x6d725f, 0x826f59], o, 'dunny'), 0.98, true);
  const trim = solid(ctx, 0x4f4638, 0.98);
  const roof = metal(ctx, 0x6d706b, 0.76);
  const dark = solid(ctx, 0x252a27, 0.82);
  const len = o.length ?? 1.25;
  const w = o.size * 2;
  const out: THREE.Object3D[] = [box(len, o.height, w, timber, { y: o.height / 2 })];
  const boards = 5;
  for (let i = 1; i < boards; i++) {
    out.push(box(0.035, o.height, w + 0.02, trim, {
      x: -len / 2 + i * len / boards, y: o.height / 2,
    }));
  }
  out.push(
    box(0.045, o.height * 0.84, w * 0.76, trim, {
      x: -len / 2 - 0.025, y: o.height * 0.42,
    }),
    box(len + 0.16, 0.08, w + 0.18, roof, {
      y: o.height * 1.03, rz: -0.08, recv: true,
    }),
    torus(w * 0.09, 0.018, dark, {
      x: -len / 2 - 0.055, y: o.height * 0.68, ry: Math.PI / 2,
    }),
    cyl(0.055, 0.065, o.height * 0.32, dark, {
      x: len * 0.28, y: o.height * 1.12, z: -w * 0.28,
    }, 7),
  );
  return out;
};

export const STRUCTURE_MESHES = {
  shippingContainer, waterTank, shed, jetty, horizontalTank, watchtower,
  bushHut, timberCabin, leanTo, caravan, bushDunny,
} satisfies Record<string, ObjectMeshBuilder>;
