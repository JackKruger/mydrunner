// Visuals for the procedural rocks and trees. Built once on terrain
// handshake from the same generator the server uses; no per-frame state.

import * as THREE from 'three';
import { Physics, type Physics as PhysicsNs } from '@mydrunner/shared';

type Obstacle = PhysicsNs.Obstacle;

const ROCK_COLORS = [0x6f6864, 0x55504c, 0x7a736e];
const TRUNK_COLOR = 0x4a3826;
const FOLIAGE_COLORS = [0x33502a, 0x3e6033, 0x2a4a25, 0x4d6b3a];
const PINE_COLORS = [0x1f3d1f, 0x2c4a2a, 0x365434, 0x274023];

export class Obstacles {
  readonly group = new THREE.Group();

  constructor(seed: number, size: number, resolution: number) {
    const terrain = Physics.generateTerrain({ seed, size, resolution });
    const list = Physics.generateObstacles(terrain);
    this.build(list);
  }

  private build(list: Obstacle[]): void {
    const trunkMat = new THREE.MeshStandardMaterial({ color: TRUNK_COLOR, roughness: 0.95 });
    const pineTrunkMat = new THREE.MeshStandardMaterial({ color: 0x3c2a18, roughness: 0.95 });
    for (const o of list) {
      if (o.kind === 'pine') {
        this.buildPine(o, pineTrunkMat);
        continue;
      }
      if (o.kind === 'rock') {
        const mat = new THREE.MeshStandardMaterial({
          color: ROCK_COLORS[Math.floor(Math.random() * ROCK_COLORS.length)] ?? 0x6f6864,
          roughness: 0.85,
          flatShading: true,
        });
        // Slightly irregular sphere for shape variety; low-poly icosahedron.
        const geo = new THREE.IcosahedronGeometry(o.size, 0);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(o.x, o.y + o.size * 0.6, o.z);
        mesh.rotation.y = o.yaw;
        // Random non-uniform scale to make rocks look less spherical.
        mesh.scale.set(1, 0.7 + Math.random() * 0.6, 1);
        this.group.add(mesh);
      } else {
        // Tree: trunk capsule + canopy cone-stack.
        const trunkHeight = Math.max(0.1, o.height - 2 * o.size);
        const trunkGeo = new THREE.CylinderGeometry(o.size * 0.85, o.size, trunkHeight + 2 * o.size, 8);
        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.castShadow = true;
        trunk.position.set(o.x, o.y + (trunkHeight + 2 * o.size) / 2, o.z);
        this.group.add(trunk);

        const foliageMat = new THREE.MeshStandardMaterial({
          color: FOLIAGE_COLORS[Math.floor(Math.random() * FOLIAGE_COLORS.length)] ?? 0x33502a,
          roughness: 0.95,
          flatShading: true,
        });
        // Stack 2-3 cones of decreasing size for a fir-tree silhouette.
        const layers = 2 + Math.floor(Math.random() * 2);
        const baseRadius = o.size * 4;
        const baseY = o.y + trunkHeight * 0.6;
        for (let l = 0; l < layers; l++) {
          const r = baseRadius * (1 - l * 0.25);
          const h = 1.6 + Math.random() * 0.4;
          const cone = new THREE.Mesh(
            new THREE.ConeGeometry(r, h, 7),
            foliageMat,
          );
          cone.castShadow = true;
          cone.position.set(o.x, baseY + l * h * 0.55, o.z);
          cone.rotation.y = o.yaw + l * 0.3;
          this.group.add(cone);
        }
      }
    }
  }

  /** Big pine: tall narrow trunk + 4-5 cone layers tapering toward the
   *  top. About 4x the visual mass of the normal scattered trees. */
  private buildPine(o: Obstacle, trunkMat: THREE.MeshStandardMaterial): void {
    const trunkHeight = Math.max(0.5, o.height - 2 * o.size);
    const fullTrunkH = trunkHeight + 2 * o.size;
    const trunkGeo = new THREE.CylinderGeometry(o.size * 0.55, o.size, fullTrunkH, 8);
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    trunk.position.set(o.x, o.y + fullTrunkH / 2, o.z);
    this.group.add(trunk);

    const foliageMat = new THREE.MeshStandardMaterial({
      color: PINE_COLORS[Math.floor(Math.random() * PINE_COLORS.length)] ?? PINE_COLORS[0]!,
      roughness: 0.95,
      flatShading: true,
    });
    // 5 cones, each smaller than the one below, stacking from ~30% up
    // the trunk to the top. Total visible foliage covers the upper
    // ~70% of the pine.
    const layers = 5;
    const baseRadius = o.size * 5.5;
    const baseY = o.y + fullTrunkH * 0.30;
    const totalSpan = fullTrunkH * 0.70;
    for (let l = 0; l < layers; l++) {
      const t = l / (layers - 1);
      const r = baseRadius * (1 - t * 0.78);
      const h = (totalSpan / layers) * 1.6;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), foliageMat);
      cone.castShadow = true;
      cone.position.set(o.x, baseY + t * totalSpan, o.z);
      cone.rotation.y = o.yaw + l * 0.3;
      this.group.add(cone);
    }
  }
}
