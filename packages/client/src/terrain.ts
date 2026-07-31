// Three.js mesh for the terrain heightfield. Shading lives in
// terrainShader.ts.
//
// The mesh is a plain PlaneGeometry with the heightfield written into the
// Y component of each vertex. Note this is NOT transposed, unlike the
// Rapier collider in shared/physics/world.ts: Rapier's heightfield wants
// column-major, PlaneGeometry's vertex order is row-major and matches
// heights[r * n + c] directly.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';
import { makeTerrainMaterial, packSurfaces, surfaceTextureOf } from './terrainShader.js';

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  readonly terrain: Physics.TerrainData;
  private positions: Float32Array;
  private geometry: THREE.PlaneGeometry;
  private material: THREE.ShaderMaterial;

  constructor(terrain: Physics.TerrainData) {
    // Shares the TerrainData instance generated once in main.ts. The game
    // never mutates it after generation, so the HUD surface lookup, the
    // minimap and the prediction world can all read the same copy for the
    // whole session. The level editor DOES mutate it in place, which is
    // what updateHeights / updateSurfaces below are for — every reader
    // seeing the same array is the point there too.
    this.terrain = terrain;
    const { size, resolution } = terrain;
    const n = resolution;
    const geo = new THREE.PlaneGeometry(size, size, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    this.geometry = geo;

    const pos = geo.attributes.position as THREE.BufferAttribute;
    this.positions = pos.array as Float32Array;
    for (let i = 0; i < n * n; i++) {
      this.positions[i * 3 + 1] = this.terrain.heights[i] ?? 0;
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    // PlaneGeometry's bounding sphere is computed from the flat plane, so
    // it does not contain the mountain. It happens to work today because
    // the flat 320 m plane's radius (~226 m) exceeds the 70 m peak — but
    // that is luck, and raycasting against a sculpted mesh needs it right.
    geo.computeBoundingSphere();

    this.material = makeTerrainMaterial(this.terrain);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  /** Push height changes for a block of cells to the GPU.
   *
   *  Reads from `this.terrain.heights`, so callers mutate the shared array
   *  and then say which part moved. Rebuilding the whole TerrainMesh per
   *  brush stroke would mean a new geometry, material and texture every
   *  pointermove. */
  updateHeights(rect: Physics.GridRect): void {
    const n = this.terrain.resolution;
    const { r0, c0, r1, c1 } = clampRect(rect, n);
    if (r1 <= r0 || c1 <= c0) return;

    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const i = r * n + c;
        this.positions[i * 3 + 1] = this.terrain.heights[i] ?? 0;
      }
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    // Full recompute rather than a rect-local one. A rect-local version has
    // to reproduce Three's face-accumulate-then-normalise exactly or the
    // edited region lights differently from its surroundings, and at
    // 128^2 the full pass is ~1 ms — worth revisiting only if profiling
    // says the brush is frame-bound.
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  /** Push surface-ID changes for a block of cells to the GPU. */
  updateSurfaces(rect: Physics.GridRect): void {
    const tex = surfaceTextureOf(this.material);
    if (!tex) return;
    const n = this.terrain.resolution;
    const { r0, c0, r1, c1 } = clampRect(rect, n);
    if (r1 <= r0 || c1 <= c0) return;

    packSurfaces(this.terrain.surfaces, tex.image.data as Uint8Array, n, {
      r0, c0, rows: r1 - r0, cols: c1 - c0,
    });
    // Three has no partial-texture upload on DataTexture, so the whole
    // n*n RGBA buffer re-uploads. At 128^2 that is 64 KB — cheaper than
    // the geometry work above, so it is not worth a custom path.
    tex.needsUpdate = true;
  }

  /** Free geometry, material AND the surface-ID DataTexture.
   *
   *  Material.dispose() does not touch textures, and the surface map is
   *  only reachable through the shader uniform - so the old inline
   *  "dispose geometry + material" in Scene.setTerrain leaked a
   *  resolution^2 RGBA texture on every reconnect (main.ts reconnects
   *  automatically with backoff, rebuilding terrain each welcome). */
  dispose(): void {
    this.geometry.dispose();
    surfaceTextureOf(this.material)?.dispose();
    this.material.dispose();
  }
}

function clampRect(
  rect: Physics.GridRect,
  n: number,
): { r0: number; c0: number; r1: number; c1: number } {
  return {
    r0: Math.max(0, rect.r0),
    c0: Math.max(0, rect.c0),
    r1: Math.min(n, rect.r0 + rect.rows),
    c1: Math.min(n, rect.c0 + rect.cols),
  };
}
