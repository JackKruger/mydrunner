// Editor-only overlays: the brush footprint and the spawn markers.
//
// Lives in the editor rather than WorldView because the game must never
// render either — WorldView is shared precisely so the editor sees the
// shipped world, and putting authoring furniture in it would undo that.

import * as THREE from 'three';
import type { Maps } from '@mydrunner/shared';
import { disposeObject3D } from '../three/dispose.js';

/** A ring on the ground showing where the brush will land.
 *
 *  Drawn as a ring of segments each lifted to its own ground height, not
 *  a flat circle: on a slope a flat ring is half-buried and reads as a
 *  smaller brush than you get, which makes every stroke a surprise. */
export class BrushCursor {
  readonly object: THREE.Line;
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private readonly segments: number;

  constructor(segments = 64) {
    this.segments = segments;
    this.positions = new Float32Array((segments + 1) * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x66ddff,
      // Depth-tested off: a ring following the ground z-fights with it,
      // and a half-visible cursor is worse than one that always shows.
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    this.object = new THREE.Line(this.geometry, material);
    this.object.renderOrder = 999;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  hide(): void {
    this.object.visible = false;
  }

  update(x: number, z: number, radius: number, groundAt: (x: number, z: number) => number): void {
    for (let i = 0; i <= this.segments; i++) {
      const a = (i / this.segments) * Math.PI * 2;
      const px = x + Math.cos(a) * radius;
      const pz = z + Math.sin(a) * radius;
      this.positions[i * 3] = px;
      this.positions[i * 3 + 1] = groundAt(px, pz) + 0.15;
      this.positions[i * 3 + 2] = pz;
    }
    this.geometry.attributes.position!.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    this.object.visible = true;
  }

  dispose(): void {
    disposeObject3D(this.object);
  }
}

/** Spawn points, drawn as a post with an arrow for the facing. */
export class SpawnMarkers {
  readonly group = new THREE.Group();
  private post = new THREE.CylinderGeometry(0.18, 0.18, 2.4, 8);
  private arrow = new THREE.ConeGeometry(0.5, 1.4, 4);
  private material = new THREE.MeshBasicMaterial({ color: 0x44ff88 });

  constructor() {
    this.group.renderOrder = 998;
  }

  set(spawns: readonly Maps.SpawnPoint[], groundAt: (x: number, z: number) => number): void {
    this.group.clear();
    for (const s of spawns) {
      const y = groundAt(s.x, s.z);
      const post = new THREE.Mesh(this.post, this.material);
      post.position.set(s.x, y + 1.2, s.z);
      this.group.add(post);

      const arrow = new THREE.Mesh(this.arrow, this.material);
      // yaw rotates local +Z (vehicle forward) into world space, matching
      // Room's spawn convention, so the arrow points where the truck will.
      arrow.position.set(s.x + Math.sin(s.yaw) * 1.6, y + 0.7, s.z + Math.cos(s.yaw) * 1.6);
      arrow.rotation.set(Math.PI / 2, 0, -s.yaw);
      this.group.add(arrow);
    }
  }

  dispose(): void {
    this.group.clear();
    this.post.dispose();
    this.arrow.dispose();
    this.material.dispose();
  }
}
