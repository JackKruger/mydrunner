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
  /** Base size this particle was emitted at; the fade scales around it. */
  scale: number;
}

/** Per-emission overrides. Everything defaults to the mud behaviour. */
export interface EmitOptions {
  /** Horizontal velocity spread, m/s. */
  spread?: number;
  /** Minimum upward velocity, m/s. */
  rise?: number;
  /** Extra random upward velocity on top of `rise`. */
  riseVar?: number;
  /** Directional push, e.g. spray thrown along the wheel's travel. */
  biasX?: number;
  biasZ?: number;
  lifeMs?: number;
  lifeVarMs?: number;
  scale?: number;
}

export class ParticleSystem {
  readonly group = new THREE.Group();
  private pool: Particle[] = [];
  private cursor = 0;
  private tmp = new THREE.Vector3();
  // Held for dispose(): the geometry is shared by every particle, the
  // materials are per-particle clones (emit() writes colour and opacity).
  private readonly geo: THREE.SphereGeometry;

  constructor() {
    const geo = new THREE.SphereGeometry(0.07, 5, 4);
    this.geo = geo;
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
        scale: 1,
      });
    }
  }

  /** Emit one particle at a world position.
   *
   *  `opts` exists for water spray, which needs a lighter, faster, more
   *  short-lived particle than a clod of mud. Defaults reproduce the
   *  original mud behaviour exactly. */
  emit(x: number, y: number, z: number, color = 0x3a2618, opts: EmitOptions = {}): void {
    const spread = opts.spread ?? 3;
    const rise = opts.rise ?? 2;
    const riseVar = opts.riseVar ?? 3;
    const p = this.pool[this.cursor]!;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    p.mesh.position.set(x, y, z);
    p.vel.set(
      (Math.random() - 0.5) * spread + (opts.biasX ?? 0),
      rise + Math.random() * riseVar,
      (Math.random() - 0.5) * spread + (opts.biasZ ?? 0),
    );
    p.ageMs = 0;
    p.lifeMs = (opts.lifeMs ?? 600) + Math.random() * (opts.lifeVarMs ?? 400);
    p.active = true;
    p.mesh.visible = true;
    p.scale = opts.scale ?? 1;
    (p.mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
    (p.mesh.material as THREE.MeshStandardMaterial).opacity = 1;
    p.mesh.scale.setScalar(p.scale);
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
      p.mesh.scale.setScalar(p.scale * (0.6 + alpha * 0.6));
    }
  }

  /** Free the pool. Three frees nothing on scene.remove(), and each
   *  particle owns a cloned material, so the shared geometry alone is not
   *  the whole leak. */
  dispose(): void {
    for (const p of this.pool) {
      (p.mesh.material as THREE.Material).dispose();
    }
    this.geo.dispose();
    this.group.clear();
    this.pool.length = 0;
  }
}
