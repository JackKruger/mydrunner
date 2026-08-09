// Pooled ground-response particles: mud clods, dust, tyre smoke and water
// spray. Pure visual: doesn't affect physics or networking.

import * as THREE from 'three';
import { activeQuality, type QualitySettings } from './quality.js';

const GRAVITY = -9.81;

interface Particle {
  /** Null on the instanced path, where there is no per-particle Object3D. */
  mesh: THREE.Mesh | null;
  /** World position. On the mesh path this mirrors mesh.position, which is
   *  what the renderer actually reads; on the instanced path it is the only
   *  copy. Integrating into one place keeps the two paths from drifting. */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  ageMs: number;
  lifeMs: number;
  active: boolean;
  /** Base size this particle was emitted at; the fade scales around it. */
  scale: number;
  /** Per-particle acceleration allows heavy mud and buoyant smoke to share
   *  one pool without splitting the renderer into effect-specific systems. */
  gravity: number;
  endScale: number;
  opacity: number;
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
  /** Vertical acceleration in m/s². Defaults to gravity for mud/water. */
  gravity?: number;
  /** Size multiplier at the end of life. Defaults to 0.6 (shrinking clod). */
  endScale?: number;
  opacity?: number;
}

export class ParticleSystem {
  readonly group = new THREE.Group();
  private pool: Particle[] = [];
  private cursor = 0;
  private tmp = new THREE.Vector3();
  private readonly max: number;
  // Held for dispose(): the geometry is shared by every particle. On the mesh
  // path the materials are per-particle clones (emit() writes colour and
  // opacity into them), so the geometry alone is not the whole leak.
  private readonly geo: THREE.SphereGeometry;
  /** Non-null on the instanced path only. */
  private readonly instanced: THREE.InstancedMesh | null = null;
  private readonly instanceMatrix = new THREE.Matrix4();
  private readonly instanceColor = new THREE.Color();
  private readonly instanceScale = new THREE.Vector3();
  private readonly noRotation = new THREE.Quaternion();

  /** Two renderings of one pool.
   *
   *  The mesh path is 160 Meshes, each with a cloned transparent
   *  MeshStandardMaterial, because emit() writes a per-particle colour and
   *  update() writes a per-particle opacity. That is up to 160 sorted
   *  transparent draw calls running a full PBR shader for a speck of mud —
   *  fine on desktop, one of the worst things in the frame on a phone.
   *
   *  The instanced path is one draw call. Per-instance colour comes from
   *  instanceColor; per-instance opacity has no equivalent without patching
   *  three's shader, so particles fade by shrinking to nothing instead
   *  (endScale is forced to 0). For sub-10 cm clods that reads much the same.
   *
   *  The mesh path is kept verbatim so the desktop image does not move. */
  constructor(quality: QualitySettings = activeQuality()) {
    this.max = quality.maxParticles;
    const geo = new THREE.SphereGeometry(0.07, 5, 4);
    this.geo = geo;

    if (quality.particleInstancing) {
      // Unlit: a particle is not a surface worth lighting, and dropping the
      // PBR path is most of the point of coming here.
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 });
      const mesh = new THREE.InstancedMesh(geo, mat, this.max);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      // An InstancedMesh's bounds are computed from the base geometry, not
      // the instances, so it would cull as a 7 cm sphere at the origin.
      mesh.frustumCulled = false;
      this.instanced = mesh;
      this.group.add(mesh);
    }

    const sharedMat = this.instanced ? null : new THREE.MeshStandardMaterial({
      color: 0x3a2618,
      roughness: 0.95,
      transparent: true,
    });

    for (let i = 0; i < this.max; i++) {
      let mesh: THREE.Mesh | null = null;
      if (sharedMat) {
        mesh = new THREE.Mesh(geo, sharedMat.clone());
        mesh.visible = false;
        mesh.castShadow = false;
        this.group.add(mesh);
      }
      this.pool.push({
        mesh,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        ageMs: 0,
        lifeMs: 0,
        active: false,
        scale: 1,
        gravity: GRAVITY,
        endScale: 0.6,
        opacity: 1,
      });
    }
    // Every instance starts collapsed: an InstancedMesh has no per-instance
    // visible flag, so "not emitted yet" has to be a zero-scale matrix.
    if (this.instanced) for (let i = 0; i < this.max; i++) this.writeInstance(i, this.pool[i]!, 0);
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
    const index = this.cursor;
    const p = this.pool[index]!;
    this.cursor = (this.cursor + 1) % this.max;
    p.pos.set(x, y, z);
    p.vel.set(
      (Math.random() - 0.5) * spread + (opts.biasX ?? 0),
      rise + Math.random() * riseVar,
      (Math.random() - 0.5) * spread + (opts.biasZ ?? 0),
    );
    p.ageMs = 0;
    p.lifeMs = (opts.lifeMs ?? 600) + Math.random() * (opts.lifeVarMs ?? 400);
    p.active = true;
    p.scale = opts.scale ?? 1;
    p.gravity = opts.gravity ?? GRAVITY;
    // Without per-instance opacity the fade has to be geometric, so a
    // particle has to reach zero size by the end of its life.
    p.endScale = this.instanced ? 0 : (opts.endScale ?? 0.6);
    p.opacity = opts.opacity ?? 1;

    if (p.mesh) {
      p.mesh.position.copy(p.pos);
      p.mesh.visible = true;
      (p.mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      (p.mesh.material as THREE.MeshStandardMaterial).opacity = p.opacity;
      p.mesh.scale.setScalar(p.scale * 1.2);
    } else {
      this.instanced!.setColorAt(index, this.instanceColor.setHex(color));
      if (this.instanced!.instanceColor) this.instanced!.instanceColor.needsUpdate = true;
      this.writeInstance(index, p, p.scale * 1.2);
    }
  }

  /** Step the active particles forward. */
  update(frameDtMs: number): void {
    const dt = frameDtMs / 1000;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]!;
      if (!p.active) continue;
      p.ageMs += frameDtMs;
      if (p.ageMs >= p.lifeMs) {
        p.active = false;
        if (p.mesh) p.mesh.visible = false;
        else this.writeInstance(i, p, 0);
        continue;
      }
      // Integrate.
      p.vel.y += p.gravity * dt;
      this.tmp.copy(p.vel).multiplyScalar(dt);
      p.pos.add(this.tmp);
      const alpha = 1 - p.ageMs / p.lifeMs;
      const scale = p.scale * (p.endScale + alpha * (1.2 - p.endScale));
      if (p.mesh) {
        p.mesh.position.copy(p.pos);
        (p.mesh.material as THREE.MeshStandardMaterial).opacity = p.opacity * alpha;
        p.mesh.scale.setScalar(scale);
      } else {
        this.writeInstance(i, p, scale);
      }
    }
    if (this.instanced) this.instanced.instanceMatrix.needsUpdate = true;
  }

  private writeInstance(index: number, p: Particle, scale: number): void {
    this.instanceScale.setScalar(scale);
    this.instanceMatrix.compose(p.pos, this.noRotation, this.instanceScale);
    this.instanced!.setMatrixAt(index, this.instanceMatrix);
  }

  /** Free the pool. Three frees nothing on scene.remove(), and on the mesh
   *  path each particle owns a cloned material, so the shared geometry alone
   *  is not the whole leak. */
  dispose(): void {
    for (const p of this.pool) {
      if (p.mesh) (p.mesh.material as THREE.Material).dispose();
    }
    if (this.instanced) {
      (this.instanced.material as THREE.Material).dispose();
      this.instanced.dispose();
    }
    this.geo.dispose();
    this.group.clear();
    this.pool.length = 0;
  }
}
