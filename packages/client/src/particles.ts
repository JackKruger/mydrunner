// Pooled mud-splatter particles. Driven from the renderer when a wheel
// is spinning on mud (wheel surface speed clearly faster than vehicle
// ground speed). Pure visual: doesn't affect physics or networking.

import * as THREE from 'three';

const GRAVITY = -9.81;
const MAX_PARTICLES = 160;

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  ageMs: number;
  lifeMs: number;
  active: boolean;
}

export class ParticleSystem {
  readonly group = new THREE.Group();
  private pool: Particle[] = [];
  private cursor = 0;
  private tmp = new THREE.Vector3();

  constructor() {
    const geo = new THREE.SphereGeometry(0.07, 5, 4);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3a2618,
      roughness: 0.95,
      transparent: true,
    });
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.visible = false;
      mesh.castShadow = false;
      this.group.add(mesh);
      this.pool.push({
        mesh,
        vel: new THREE.Vector3(),
        ageMs: 0,
        lifeMs: 0,
        active: false,
      });
    }
  }

  /** Emit one particle at world position with a random upward velocity. */
  emit(x: number, y: number, z: number, color = 0x3a2618): void {
    const p = this.pool[this.cursor]!;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    p.mesh.position.set(x, y, z);
    p.vel.set(
      (Math.random() - 0.5) * 3,
      2 + Math.random() * 3,
      (Math.random() - 0.5) * 3,
    );
    p.ageMs = 0;
    p.lifeMs = 600 + Math.random() * 400;
    p.active = true;
    p.mesh.visible = true;
    (p.mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
    (p.mesh.material as THREE.MeshStandardMaterial).opacity = 1;
    p.mesh.scale.setScalar(1);
  }

  /** Step the active particles forward. */
  update(frameDtMs: number): void {
    const dt = frameDtMs / 1000;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.ageMs += frameDtMs;
      if (p.ageMs >= p.lifeMs) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      // Integrate.
      p.vel.y += GRAVITY * dt;
      this.tmp.copy(p.vel).multiplyScalar(dt);
      p.mesh.position.add(this.tmp);
      const alpha = 1 - p.ageMs / p.lifeMs;
      (p.mesh.material as THREE.MeshStandardMaterial).opacity = alpha;
      p.mesh.scale.setScalar(0.6 + alpha * 0.6);
    }
  }
}
