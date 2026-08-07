// Rocks, trees and everything else that grew there.

import * as THREE from 'three';
import {
  BOULDER_COLORS, BUSH_COLORS, DEAD_WOOD_COLORS, FOLIAGE_COLORS, PINE_COLORS,
  ROCK_COLORS, TRUNK_COLOR, solid,
} from './materials.js';
import { box, cone, cyl, ico, lyingCyl, plane, repeatX } from './prims.js';
import type { ObjectMeshBuilder } from './types.js';

/** Slightly irregular sphere for shape variety; low-poly icosahedron. */
const rock: ObjectMeshBuilder = (ctx, o) => {
  const mesh = ico(o.size, solid(ctx, ctx.pick(ROCK_COLORS, o, 'rockColor'), 0.85, true),
    { y: o.size * 0.6, recv: true });
  // Non-uniform scale to make rocks look less spherical.
  mesh.scale.set(1, 0.7 + ctx.h(o, 'rockSquash') * 0.6, 1);
  return [mesh];
};

const boulder: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, ctx.pick(BOULDER_COLORS, o, 'rockColor'), 0.9, true);
  const main = ico(o.size, mat, { y: o.size * 0.55, recv: true }, 1);
  main.scale.set(1, 0.78 + ctx.h(o, 'rockSquash') * 0.4, 0.9);
  main.rotation.y = ctx.h(o, 'spin') * Math.PI;
  // A second smaller lump fused into the flank, so a boulder reads as
  // bigger-and-chunkier rather than just a scaled-up rock.
  const lump = ico(o.size * 0.45, mat, {
    x: o.size * 0.6, y: o.size * 0.35, z: o.size * 0.2,
  }, 0);
  return [main, lump];
};

/** Tree: trunk capsule + canopy cone-stack. */
const tree: ObjectMeshBuilder = (ctx, o) => {
  const trunkMat = solid(ctx, TRUNK_COLOR, 0.95);
  const trunkHeight = Math.max(0.1, o.height - 2 * o.size);
  const fullTrunkH = trunkHeight + 2 * o.size;
  const out: THREE.Object3D[] = [
    cyl(o.size * 0.85, o.size, fullTrunkH, trunkMat, { y: fullTrunkH / 2 }, 8),
  ];
  const foliageMat = solid(ctx, ctx.pick(FOLIAGE_COLORS, o, 'foliage'), 0.95, true);
  // Stack 2-3 cones of decreasing size for a fir-tree silhouette.
  const layers = 2 + Math.floor(ctx.h(o, 'layers') * 2);
  const baseRadius = o.size * 4;
  const baseY = trunkHeight * 0.6;
  for (let l = 0; l < layers; l++) {
    const r = baseRadius * (1 - l * 0.25);
    const h = 1.6 + ctx.h(o, `coneH${l}`) * 0.4;
    out.push(cone(r, h, foliageMat, { y: baseY + l * h * 0.55, ry: l * 0.3 }, 7));
  }
  return out;
};

/** Big pine: tall narrow trunk + 4-5 cone layers tapering toward the top.
 *  About 4x the visual mass of the normal scattered trees. */
const pine: ObjectMeshBuilder = (ctx, o) => {
  const trunkMat = solid(ctx, 0x3c2a18, 0.95);
  const trunkHeight = Math.max(0.5, o.height - 2 * o.size);
  const fullTrunkH = trunkHeight + 2 * o.size;
  const out: THREE.Object3D[] = [
    cyl(o.size * 0.55, o.size, fullTrunkH, trunkMat, { y: fullTrunkH / 2, recv: true }, 8),
  ];
  const foliageMat = solid(ctx, ctx.pick(PINE_COLORS, o, 'pine'), 0.95, true);
  // 5 cones, each smaller than the one below, stacking from ~30% up the
  // trunk to the top. Total visible foliage covers the upper ~70%.
  const layers = 5;
  const baseRadius = o.size * 5.5;
  const baseY = fullTrunkH * 0.30;
  const totalSpan = fullTrunkH * 0.70;
  for (let l = 0; l < layers; l++) {
    const t = l / (layers - 1);
    const r = baseRadius * (1 - t * 0.78);
    const h = (totalSpan / layers) * 1.6;
    out.push(cone(r, h, foliageMat, { y: baseY + t * totalSpan, ry: l * 0.3 }, 8));
  }
  return out;
};

const deadTree: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, ctx.pick(DEAD_WOOD_COLORS, o, 'deadWood'), 0.98, true);
  const h = o.height;
  const out: THREE.Object3D[] = [cyl(o.size * 0.4, o.size, h, mat, { y: h / 2 }, 7)];
  // Three stubs angled off the upper trunk. No foliage: the silhouette is
  // the whole point of a dead tree.
  for (let i = 0; i < 3; i++) {
    const a = ctx.h(o, `branch${i}`) * Math.PI * 2;
    const up = 0.55 + i * 0.14;
    const len = o.size * (5 - i);
    const br = cyl(o.size * 0.18, o.size * 0.3, len, mat, {
      y: h * up, rz: Math.PI / 3, ry: a,
    }, 5);
    br.position.x = Math.cos(a) * len * 0.35;
    br.position.z = -Math.sin(a) * len * 0.35;
    out.push(br);
  }
  return out;
};

const stump: ObjectMeshBuilder = (ctx, o) => {
  const bark = solid(ctx, TRUNK_COLOR, 0.98, true);
  const cut = solid(ctx, 0x9c7f5a, 0.9);
  return [
    cyl(o.size * 0.94, o.size, o.height, bark, { y: o.height / 2 }, 9),
    // A lighter disc just proud of the top so the cut face reads from above.
    cyl(o.size * 0.9, o.size * 0.9, 0.04, cut, { y: o.height + 0.02 }, 9),
  ];
};

const log: ObjectMeshBuilder = (ctx, o) => {
  const bark = solid(ctx, TRUNK_COLOR, 0.98, true);
  const cut = solid(ctx, 0x9c7f5a, 0.9);
  const len = o.length ?? 4;
  return [
    lyingCyl(o.size, len, bark, { y: o.size }),
    cyl(o.size * 0.96, o.size * 0.96, 0.04, cut, { x: len / 2, y: o.size, rz: Math.PI / 2 }, 10),
    cyl(o.size * 0.96, o.size * 0.96, 0.04, cut, { x: -len / 2, y: o.size, rz: Math.PI / 2 }, 10),
  ];
};

const bush: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, ctx.pick(BUSH_COLORS, o, 'bush'), 0.98, true);
  const out: THREE.Object3D[] = [];
  // Three overlapping squashed lumps — no trunk, so it reads as scrub
  // rather than a small tree.
  for (let i = 0; i < 3; i++) {
    const a = ctx.h(o, `lump${i}`) * Math.PI * 2;
    const r = o.size * (0.9 - i * 0.16);
    const m = ico(r, mat, {
      x: Math.cos(a) * o.size * 0.4,
      y: r * 0.7 + i * o.size * 0.16,
      z: Math.sin(a) * o.size * 0.4,
    }, 0);
    m.scale.set(1, 0.65, 1);
    out.push(m);
  }
  return out;
};

const palm: ObjectMeshBuilder = (ctx, o) => {
  const trunkMat = solid(ctx, 0x7a6244, 0.95);
  const frondMat = ctx.mat('palmFrond', () => new THREE.MeshStandardMaterial({
    color: 0x4a7a34, roughness: 0.9, side: THREE.DoubleSide,
  }));
  const segs = 5;
  const segH = o.height / segs;
  const out: THREE.Object3D[] = [];
  // A gentle lean built from stacked segments — a palm that stands dead
  // straight looks like a lamp post.
  const lean = (ctx.h(o, 'lean') - 0.5) * 0.5;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    out.push(cyl(o.size * (0.8 - t * 0.2), o.size * (0.9 - t * 0.2), segH * 1.05, trunkMat, {
      x: lean * t * t * o.height * 0.5,
      y: segH * (i + 0.5),
      rz: -lean * t * 0.4,
    }, 7));
  }
  const topX = lean * o.height * 0.5;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    out.push(plane(o.height * 0.42, o.size * 3.4, frondMat, {
      x: topX + Math.cos(a) * o.height * 0.19,
      y: o.height - o.size * 0.4,
      z: Math.sin(a) * o.height * 0.19,
      rx: -Math.PI / 2 + 0.5, ry: -a,
    }));
  }
  return out;
};

const cactus: ObjectMeshBuilder = (ctx, o) => {
  const green = solid(ctx, ctx.pick([0x467a3b, 0x3f7136, 0x568546], o, 'cactus'), 0.92);
  const flower = solid(ctx, ctx.pick([0xc94d65, 0xe08a3e, 0xd6b43d], o, 'flower'), 0.88);
  const out: THREE.Object3D[] = [
    cyl(o.size * 0.82, o.size, o.height, green, { y: o.height / 2 }, 9),
    cyl(o.size * 0.84, o.size * 0.84, o.size * 0.45, green, { y: o.height }, 9),
  ];
  for (const [side, up] of [[-1, 0.48], [1, 0.64]] as const) {
    const armH = o.height * (side < 0 ? 0.28 : 0.22);
    const armX = side * o.size * 2.2;
    out.push(
      lyingCyl(o.size * 0.48, o.size * 2.5, green, {
        x: side * o.size * 1.15, y: o.height * up,
      }, 8),
      cyl(o.size * 0.43, o.size * 0.5, armH, green, {
        x: armX, y: o.height * up + armH / 2,
      }, 8),
      cyl(o.size * 0.44, o.size * 0.44, o.size * 0.28, flower, {
        x: armX, y: o.height * up + armH,
      }, 7),
    );
  }
  return out;
};

const reeds: ObjectMeshBuilder = (ctx, o) => {
  const stalk = solid(ctx, 0x6f8242, 0.95);
  const head = solid(ctx, 0x5a3d26, 0.98);
  const leaf = ctx.mat('reedLeaf', () => new THREE.MeshStandardMaterial({
    color: 0x78954c, roughness: 0.95, side: THREE.DoubleSide,
  }));
  const out: THREE.Object3D[] = [];
  const count = Math.max(7, Math.round(o.size * 10));
  for (let i = 0; i < count; i++) {
    const a = ctx.h(o, `reedA${i}`) * Math.PI * 2;
    const r = Math.sqrt(ctx.h(o, `reedR${i}`)) * o.size;
    const h = o.height * (0.65 + ctx.h(o, `reedH${i}`) * 0.35);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    out.push(cyl(0.014, 0.02, h, stalk, { x, y: h / 2, z }, 5));
    if (i % 2 === 0) {
      out.push(cyl(0.035, 0.045, h * 0.16, head, { x, y: h, z }, 6));
    }
    out.push(plane(h * 0.34, 0.06, leaf, {
      x: x + Math.cos(a) * h * 0.12,
      y: h * 0.42,
      z: z + Math.sin(a) * h * 0.12,
      ry: -a,
      rz: 0.55,
    }));
  }
  return out;
};

const rockStep: ObjectMeshBuilder = (ctx, o) => {
  const mat = solid(ctx, ctx.pick(ROCK_COLORS, o, 'rockColor'), 0.88, true);
  const len = o.length ?? 4;
  const out: THREE.Object3D[] = [box(len, o.height, o.size * 2, mat, { y: o.height / 2 })];
  // A few lumps along the lip so the flat top doesn't read as concrete.
  out.push(...repeatX(4, len * 0.8, (i, x) => {
    const r = o.size * (0.3 + ctx.h(o, `lip${i}`) * 0.25);
    const m = ico(r, mat, { x, y: o.height, z: (ctx.h(o, `lipz${i}`) - 0.5) * o.size });
    m.scale.set(1, 0.5, 1);
    return m;
  }));
  return out;
};

export const NATURAL_MESHES = {
  rock, boulder, tree, pine, deadTree, stump, log, bush, palm, cactus, reeds,
  rockStep,
} satisfies Record<string, ObjectMeshBuilder>;
