// Three.js mesh for the authored water surface. Shading lives in
// waterShader.ts.
//
// Same shape as TerrainMesh, and for the same reasons: a full-grid
// PlaneGeometry with the level written into vertex Y, row-major to match
// waterLevel[r * n + c] directly, and a rect-scoped update so an editor
// brush does not rebuild geometry on every pointermove.
//
// The one structural difference is aWet. Building geometry from only the
// wet cells would mean regenerating the whole buffer on every stroke, so
// instead every cell has a vertex and dry ones are flagged and discarded
// in the fragment shader. A map with a thin river still pays for a full
// 128^2 grid of vertices, which is nothing, and gains a stroke update
// that touches only the rect the brush moved.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';
import { flowTextureOf, makeWaterMaterial, packFlow, refreshWaterEnvironment } from './waterShader.js';
import { activeQuality, type QualitySettings } from './quality.js';

export class WaterMesh {
  readonly mesh: THREE.Mesh;
  readonly terrain: Physics.TerrainData;
  private positions: Float32Array;
  private wet: Float32Array;
  private depth: Float32Array;
  private geometry: THREE.PlaneGeometry;
  private material: THREE.ShaderMaterial;
  private startMs = performance.now();

  constructor(terrain: Physics.TerrainData, quality: QualitySettings = activeQuality()) {
    this.terrain = terrain;
    const { size, resolution } = terrain;
    const n = resolution;
    const geo = new THREE.PlaneGeometry(size, size, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    this.geometry = geo;

    this.positions = (geo.attributes.position as THREE.BufferAttribute).array as Float32Array;
    this.wet = new Float32Array(n * n);
    this.depth = new Float32Array(n * n);
    geo.setAttribute('aWet', new THREE.BufferAttribute(this.wet, 1));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(this.depth, 1));

    this.writeCells({ r0: 0, c0: 0, rows: n, cols: n });
    geo.computeBoundingSphere();

    this.material = makeWaterMaterial(terrain, quality);
    this.mesh = new THREE.Mesh(geo, this.material);
    // Water neither receives nor casts shadows: it is a transparent
    // surface with depthWrite off, so a shadow on it would be cast onto
    // whatever is behind it instead.
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    // Drawn after the opaque world so the bed is already in the depth
    // buffer and shows through the shallow tint.
    this.mesh.renderOrder = 1;
  }

  /** Advance the ripple clock.
   *
   *  Self-ticked from performance.now() rather than taking a dt
   *  parameter, exactly as Sky does, so WorldView.render(camera) keeps
   *  its signature and neither the game nor the editor call site
   *  changes. */
  update(): void {
    this.material.uniforms.uTime!.value = (performance.now() - this.startMs) / 1000;
  }

  /** Apply values changed by the ?dev render sliders without rebuilding. */
  refreshRenderEnvironment(): void {
    refreshWaterEnvironment(this.material);
  }

  /** Push level / wetness changes for a block of cells to the GPU.
   *
   *  Reads from the shared terrain arrays, so callers mutate and then say
   *  which part moved — same contract as TerrainMesh.updateHeights. Call
   *  after sculpting too, not just after a water edit: depth is level
   *  minus ground, so moving the bed changes the water above it. */
  updateWater(rect: Physics.GridRect): void {
    const n = this.terrain.resolution;
    const { r0, c0, r1, c1 } = clampRect(rect, n);
    if (r1 <= r0 || c1 <= c0) return;

    this.writeCells({ r0, c0, rows: r1 - r0, cols: c1 - c0 });
    this.geometry.computeBoundingSphere();

    const tex = flowTextureOf(this.material);
    if (tex) {
      packFlow(this.terrain, tex.image.data as Uint8Array, { r0, c0, rows: r1 - r0, cols: c1 - c0 });
      tex.needsUpdate = true;
    }
  }

  private writeCells(rect: Physics.GridRect): void {
    const n = this.terrain.resolution;
    const { r0, c0, r1, c1 } = clampRect(rect, n);
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const i = r * n + c;
        const level = this.terrain.waterLevel[i] ?? 0;
        const ground = this.terrain.heights[i] ?? 0;
        const isWet = Physics.isWet(level) && level > ground;
        this.wet[i] = isWet ? 1 : 0;
        this.depth[i] = isWet ? level - ground : 0;
        // Dry vertices sit on the bed rather than at the sentinel. The
        // fragment shader discards them either way, but a vertex at
        // -1e9 blows up the bounding sphere and the mesh stops being
        // culled — or worse, stops being raycastable in the editor.
        this.positions[i * 3 + 1] = isWet ? level : ground;
      }
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.aWet as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.aDepth as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Free geometry, material AND the flow DataTexture. Material.dispose()
   *  does not touch textures (see three/dispose.ts). */
  dispose(): void {
    this.geometry.dispose();
    flowTextureOf(this.material)?.dispose();
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
