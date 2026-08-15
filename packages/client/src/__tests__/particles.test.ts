import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ParticleSystem } from '../particles.js';
import { QUALITY } from '../quality.js';

describe('batched particle renderers', () => {
  it('uses a bounded set of batches on both quality tiers', () => {
    for (const quality of Object.values(QUALITY)) {
      const system = new ParticleSystem(quality);
      expect(system.group.children).toHaveLength(4);
      expect(system.group.children.every((o) =>
        (o as THREE.Points).isPoints || (o as THREE.InstancedMesh).isInstancedMesh)).toBe(true);
      expect(system.group.children.some((o) =>
        (o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh)).toBe(false);
      system.dispose();
    }
  });

  it('reuses each pool instead of adding scene objects', () => {
    const system = new ParticleSystem(QUALITY.high);
    const children = [...system.group.children];
    for (let i = 0; i < QUALITY.high.maxParticles * 3; i++) {
      system.emit(i, 0, 0, 0xffffff, { effect: i % 2 ? 'dust' : 'mud' });
    }
    expect(system.group.children).toEqual(children);
    expect(system.stats().active).toBeLessThanOrEqual(QUALITY.high.maxParticles * 2);
    system.dispose();
  });

  it('expires particles and turns spray contacts into bounded decals', () => {
    const system = new ParticleSystem(QUALITY.high);
    system.emit(0, .01, 0, 0xffffff, {
      effect: 'water', contactY: 0, rise: 0, riseVar: 0, gravity: -9.81,
      lifeMs: 100, lifeVarMs: 0,
    });
    system.update(50);
    expect(system.stats().active).toBe(1); // spray was replaced by foam
    system.update(1000);
    expect(system.stats().active).toBe(0);
    system.dispose();
  });

  it('applies low-tier density deterministically per emission event', () => {
    const emit = () => {
      const system = new ParticleSystem(QUALITY.low);
      for (let i = 0; i < 200; i++) system.emit(0, 0, 0, undefined, { effect: 'dust' });
      return system.stats().emitted;
    };
    expect(emit()).toBe(emit());
    expect(emit()).toBeLessThan(200);
  });
});
