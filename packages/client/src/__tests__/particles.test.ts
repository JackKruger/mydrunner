import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ParticleSystem } from '../particles.js';
import { QUALITY } from '../quality.js';

function instancedMesh(system: ParticleSystem): THREE.InstancedMesh {
  const found = system.group.children.find((c) => (c as THREE.InstancedMesh).isInstancedMesh);
  return found as THREE.InstancedMesh;
}

function scaleOf(mesh: THREE.InstancedMesh, index: number): number {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(index, m);
  return new THREE.Vector3().setFromMatrixScale(m).x;
}

describe('high tier', () => {
  it('keeps the per-mesh pool the desktop image was captured with', () => {
    const system = new ParticleSystem(QUALITY.high);
    const meshes = system.group.children.filter((c) => (c as THREE.Mesh).isMesh);
    expect(meshes).toHaveLength(QUALITY.high.maxParticles);
    expect(instancedMesh(system)).toBeUndefined();
    // Per-particle cloned materials are the whole reason this path is
    // expensive, and also the reason emit() can set a colour and update() an
    // opacity. Distinct materials is the property, not an accident.
    const materials = new Set(meshes.map((m) => (m as THREE.Mesh).material));
    expect(materials.size).toBe(QUALITY.high.maxParticles);
  });
});

describe('low tier', () => {
  it('draws the whole pool as one instanced mesh', () => {
    const system = new ParticleSystem(QUALITY.low);
    const mesh = instancedMesh(system);
    expect(mesh).toBeDefined();
    expect(mesh.count).toBe(QUALITY.low.maxParticles);
    // Up to 160 sorted transparent PBR draw calls become one.
    expect(system.group.children).toHaveLength(1);
    // Bounds come from the base geometry, not the instances, so leaving
    // culling on would make the pool vanish as a 7 cm sphere at the origin.
    expect(mesh.frustumCulled).toBe(false);
  });

  it('collapses unemitted and expired instances to zero scale', () => {
    // An InstancedMesh has no per-instance visible flag, so "not drawn" has
    // to be expressed geometrically.
    const system = new ParticleSystem(QUALITY.low);
    const mesh = instancedMesh(system);
    expect(scaleOf(mesh, 0)).toBe(0);

    system.emit(1, 2, 3);
    expect(scaleOf(mesh, 0)).toBeGreaterThan(0);

    // Past its longest possible life (600 + 400 ms).
    system.update(1100);
    expect(scaleOf(mesh, 0)).toBe(0);
  });

  it('shrinks a particle to nothing over its life', () => {
    // Without per-instance opacity the fade has to be geometric, so endScale
    // is forced to 0 no matter what the caller asked for.
    const system = new ParticleSystem(QUALITY.low);
    const mesh = instancedMesh(system);
    system.emit(0, 0, 0, 0xffffff, { lifeMs: 1000, lifeVarMs: 0, endScale: 0.6 });
    const born = scaleOf(mesh, 0);
    system.update(500);
    const half = scaleOf(mesh, 0);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(born);
  });

  it('wraps rather than growing when the pool is exhausted', () => {
    const system = new ParticleSystem(QUALITY.low);
    for (let i = 0; i < QUALITY.low.maxParticles * 2 + 5; i++) system.emit(i, 0, 0);
    expect(instancedMesh(system).count).toBe(QUALITY.low.maxParticles);
  });
});
