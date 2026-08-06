// Shared appearance: the deterministic hash, the palettes, and the
// per-instance material cache the builders draw from.
//
// Appearance is derived from each obstacle's id rather than Math.random():
// the editor rebuilds the whole obstacle group whenever the world changes,
// and random colours meant every rock and every tree reshuffled on each
// rebuild. Hashing the id also means a given rock looks the same on every
// client, which matters as soon as two people are looking at the same one.

import * as THREE from 'three';
import { fnv1a32, type Physics as PhysicsNs } from '@mydrunner/shared';

type Obstacle = PhysicsNs.Obstacle;

/** Deterministic [0,1) from an obstacle id. `salt` separates the several
 *  independent choices made for one obstacle. */
export function hash01(id: string, salt: string): number {
  return fnv1a32(`${id}:${salt}`) / 4294967296;
}

/** Deterministic pick from a palette. */
export function pick<T>(palette: readonly T[], id: string, salt: string): T {
  return palette[Math.floor(hash01(id, salt) * palette.length)] ?? palette[0]!;
}

export const ROCK_COLORS = [0x6f6864, 0x55504c, 0x7a736e];
export const BOULDER_COLORS = [0x5a5450, 0x484341, 0x635c57];
export const TRUNK_COLOR = 0x4a3826;
export const FOLIAGE_COLORS = [0x33502a, 0x3e6033, 0x2a4a25, 0x4d6b3a];
export const PINE_COLORS = [0x1f3d1f, 0x2c4a2a, 0x365434, 0x274023];
export const BUSH_COLORS = [0x3f5c31, 0x4a6b3a, 0x35502c];
export const DEAD_WOOD_COLORS = [0x8a7f6d, 0x7a6f5e, 0x6d6455];
export const BARREL_COLORS = [0x2d5f8a, 0x7a3a2a, 0x3f6b3a, 0xa8862c];
export const CONTAINER_COLORS = [0x8a4a32, 0x2d5a7a, 0x3f6b4a, 0x9a8438, 0x6b4a6b];
export const RUST_COLORS = [0x7a4a32, 0x6b4530, 0x8a5a3c];

/** Materials and geometries, keyed and reused for the lifetime of one
 *  Obstacles instance.
 *
 *  Before this, a 986-obstacle world allocated a fresh MeshStandardMaterial
 *  per rock and per tree canopy. Keying by the values that actually differ
 *  means rocks that hashed to the same colour now share one material, which
 *  is both fewer draw-call state changes and less to dispose. */
export interface MeshCtx {
  mat<T extends THREE.Material>(key: string, make: () => T): T;
  geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T;
  h(o: Obstacle, salt: string): number;
  pick<T>(palette: readonly T[], o: Obstacle, salt: string): T;
}

export function createMeshCtx(): MeshCtx {
  const mats = new Map<string, THREE.Material>();
  const geos = new Map<string, THREE.BufferGeometry>();
  return {
    mat<T extends THREE.Material>(key: string, make: () => T): T {
      let m = mats.get(key) as T | undefined;
      if (!m) { m = make(); mats.set(key, m); }
      return m;
    },
    geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
      let g = geos.get(key) as T | undefined;
      if (!g) { g = make(); geos.set(key, g); }
      return g;
    },
    h: (o, salt) => hash01(o.id, salt),
    pick: (palette, o, salt) => pick(palette, o.id, salt),
  };
}

/** A plain flat-shaded standard material, cached by its colour. */
export function solid(
  ctx: MeshCtx, color: number, roughness = 0.9, flat = false,
): THREE.MeshStandardMaterial {
  return ctx.mat(`solid:${color}:${roughness}:${flat}`, () =>
    new THREE.MeshStandardMaterial({ color, roughness, flatShading: flat }));
}

export function metal(ctx: MeshCtx, color: number, roughness = 0.4): THREE.MeshStandardMaterial {
  return ctx.mat(`metal:${color}:${roughness}`, () =>
    new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness }));
}

/** Diagonal yellow/black caution stripes painted on a CanvasTexture.
 *  Used for the flex-ramp top so it pops against the brown terrain. */
export function cautionStripeMaterial(ctx: MeshCtx): THREE.MeshStandardMaterial {
  return ctx.mat('cautionStripe', () => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#f5b820';
    c.fillRect(0, 0, size, size);
    c.fillStyle = '#1a1a1a';
    const stripe = 22;
    for (let i = -size; i < size * 2; i += stripe * 2) {
      c.beginPath();
      c.moveTo(i, 0);
      c.lineTo(i + stripe, 0);
      c.lineTo(i + stripe + size, size);
      c.lineTo(i + size, size);
      c.closePath();
      c.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
  });
}
