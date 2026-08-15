import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';
import type { QualitySettings } from './quality.js';

export type GroundCoverKind = 'grass' | 'scrub' | 'stone' | 'branch' | 'litter';
export interface GroundCoverPlacement {
  kind: GroundCoverKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

const UINT = 4294967296;
function mix(v: number): number {
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
  return (v ^ (v >>> 16)) >>> 0;
}
function random(seed: number, row: number, col: number, stream: number): number {
  return mix(seed ^ Math.imul(row, 0x9e3779b1) ^ Math.imul(col, 0x85ebca77) ^ stream) / UINT;
}

/** Pure placement pass. It deliberately never consumes a sequential RNG: every
 * decision is addressed by map seed, cell coordinates and a fixed stream, so
 * adding a cover kind cannot move any existing instance. */
export function generateGroundCover(
  terrain: Physics.TerrainData,
  obstacles: readonly Physics.Obstacle[],
  density = 1,
): GroundCoverPlacement[] {
  const out: GroundCoverPlacement[] = [];
  const n = terrain.resolution;
  const step = terrain.size / (n - 1);
  const seed = mix(terrain.seed ^ Math.imul(n, 65537) ^ Math.round(terrain.size * 100));
  const blocked = (x: number, z: number): boolean => obstacles.some((o) => {
    // length covers buildings, logs and ramps; size covers posts and trees.
    const radius = Math.max(1.1, o.size * 1.35, (o.length ?? 0) * 0.58);
    return (x - o.x) ** 2 + (z - o.z) ** 2 < radius * radius;
  });
  const forestDistance = (x: number, z: number): number => {
    let best = Infinity;
    for (const o of obstacles) {
      if (o.kind !== 'tree' && o.kind !== 'pine') continue;
      best = Math.min(best, Math.hypot(x - o.x, z - o.z));
    }
    return best;
  };

  for (let r = 1; r < n - 1; r++) for (let c = 1; c < n - 1; c++) {
    const i = r * n + c;
    const surface = terrain.surfaces[i];
    if (surface === Physics.Surface.Road || surface === Physics.Surface.Concrete
      || surface === Physics.Surface.DeepMud) continue;
    const y0 = terrain.heights[i]!;
    if (Physics.isWet(terrain.waterLevel[i]!) && terrain.waterLevel[i]! - y0 > 0.08) continue;
    const dx = terrain.heights[i + 1]! - terrain.heights[i - 1]!;
    const dz = terrain.heights[i + n]! - terrain.heights[i - n]!;
    const slope = Math.hypot(dx, dz) / (2 * step);
    if (slope > 0.72) continue;
    // Jitter stays inside its source cell, making cell ownership unambiguous.
    const x = -terrain.size / 2 + c * step + (random(seed, r, c, 1) - 0.5) * step * 0.76;
    const z = -terrain.size / 2 + r * step + (random(seed, r, c, 2) - 0.5) * step * 0.76;
    if (blocked(x, z)) continue;
    const forest = forestDistance(x, z);
    const elevation = Math.max(0, Math.min(1, (y0 + 3) / 35));
    const roll = random(seed, r, c, 3);
    const base = surface === Physics.Surface.Grass ? 0.82 : surface === Physics.Surface.Dirt ? 0.30 : 0.16;
    let kind: GroundCoverKind;
    if (forest < 15 && roll < 0.34) kind = 'litter';
    else if (forest < 20 && roll < 0.43) kind = 'branch';
    else if (roll < base * (1 - slope) * (1 - elevation * 0.25)) kind = 'grass';
    else if (roll < base + 0.10 * (1 - elevation)) kind = 'scrub';
    else if (roll < base + 0.18 + elevation * 0.10) kind = 'stone';
    else continue;
    if (random(seed, r, c, 4) >= density) continue;
    out.push({ kind, x, y: y0 + 0.025, z, yaw: random(seed, r, c, 5) * Math.PI * 2,
      scale: 0.72 + random(seed, r, c, 6) * 0.65 });
  }
  return out;
}

function cutoutMaterial(color: number, distance: number, atlas: THREE.Texture): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color, map: atlas, alphaTest: 0.45, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.coverFar = { value: distance };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float vCoverDistance;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvCoverDistance = length(mvPosition.xyz);');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vCoverDistance;\nuniform float coverFar;')
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif (vCoverDistance > coverFar || fract(gl_FragCoord.x * .75487766 + gl_FragCoord.y * .56984029) > 1.0 - smoothstep(coverFar * .72, coverFar, vCoverDistance)) discard;');
  };
  return material;
}

function grassTuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const blade = (
    x: number, z: number, yaw: number, width: number, height: number,
    leanX: number, leanZ: number,
  ): void => {
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const base = positions.length / 3;
    const midX = x + leanX * 0.34;
    const midZ = z + leanZ * 0.34;
    const midHalf = width * 0.25;
    positions.push(
      x - rightX * width * 0.5, 0, z - rightZ * width * 0.5,
      x + rightX * width * 0.5, 0, z + rightZ * width * 0.5,
      midX - rightX * midHalf, height * 0.57, midZ - rightZ * midHalf,
      midX + rightX * midHalf, height * 0.57, midZ + rightZ * midHalf,
      x + leanX, height, z + leanZ,
    );
    // Keep every blade in the atlas's opaque half. Its outline now comes from
    // tapered geometry, so the tuft cannot resolve into a rectangular card.
    uvs.push(0.05, 0, 0.45, 0, 0.15, 0.57, 0.35, 0.57, 0.25, 1);
    indices.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4);
  };

  blade(-0.20, 0.00, -0.18, 0.13, 0.46, -0.09, 0.01);
  blade(-0.11, 0.01, 0.12, 0.12, 0.63, -0.05, 0.02);
  blade(0.00, 0.00, -0.08, 0.13, 0.72, 0.02, 0.02);
  blade(0.11, 0.00, 0.18, 0.12, 0.59, 0.07, -0.02);
  blade(0.20, 0.01, -0.22, 0.12, 0.44, 0.10, 0.01);
  blade(-0.08, 0.01, Math.PI * 0.48, 0.11, 0.52, 0.01, 0.08);
  blade(0.08, -0.01, Math.PI * 0.54, 0.11, 0.55, -0.01, -0.08);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export class GroundCover {
  readonly group = new THREE.Group();
  private readonly owned: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> = [];
  private readonly atlas: THREE.DataTexture;

  constructor(terrain: Physics.TerrainData, obstacles: readonly Physics.Obstacle[], quality: QualitySettings) {
    this.group.name = 'ground-cover';
    const placements = generateGroundCover(terrain, obstacles, quality.groundCoverDensity);
    const grass = grassTuftGeometry();
    const lowPlane = new THREE.PlaneGeometry(0.8, 0.12); lowPlane.translate(0, 0.06, 0);
    const stone = new THREE.DodecahedronGeometry(0.16, 0); stone.translate(0, 0.10, 0);
    const branch = new THREE.CylinderGeometry(0.045, 0.065, 0.9, 5); branch.rotateZ(Math.PI / 2); branch.translate(0, 0.07, 0);
    // All five materials sample one tiny atlas. Vegetation uses its cutout
    // alpha rather than transparent blending, preserving early depth writes.
    const pixels = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0]);
    this.atlas = new THREE.DataTexture(pixels, 2, 2, THREE.RGBAFormat);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.needsUpdate = true;
    const specs: Record<GroundCoverKind, [THREE.BufferGeometry, number]> = {
      // The pointed blades expose more upward-facing normals than the old
      // billboard cards, so use deeper vegetation albedos that stay grounded
      // under direct sun instead of turning lime green.
      grass: [grass, 0x405828], scrub: [grass, 0x515431], stone: [stone, 0x77736b],
      branch: [branch, 0x59412a], litter: [lowPlane, 0x76502d],
    };
    const dummy = new THREE.Object3D();
    for (const kind of Object.keys(specs) as GroundCoverKind[]) {
      const entries = placements.filter((p) => p.kind === kind);
      if (!entries.length) continue;
      const [geometry, color] = specs[kind];
      const material = cutoutMaterial(color, quality.groundCoverDrawDistance, this.atlas);
      const mesh = new THREE.InstancedMesh(geometry, material, entries.length);
      mesh.name = `ground-cover-${kind}`;
      entries.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(0, p.yaw, 0); dummy.scale.setScalar(p.scale);
        dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = quality.shadows; mesh.receiveShadow = true;
      this.group.add(mesh); this.owned.push({ geometry, material });
    }
    // A biome need not use every shape, but construction still made the
    // shared geometry set; retain those too so teardown always releases it.
    for (const geometry of [grass, lowPlane, stone, branch]) {
      if (!this.owned.some((entry) => entry.geometry === geometry)) this.owned.push({ geometry, material: new THREE.Material() });
    }
  }

  dispose(): void {
    for (const { geometry, material } of this.owned) {
      geometry.dispose();
      material.dispose();
    }
    this.atlas.dispose();
    this.group.clear(); this.owned.length = 0;
  }
}
