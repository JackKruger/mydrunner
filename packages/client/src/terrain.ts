// Build a Three.js terrain mesh from a deterministic seed by reusing the
// same generator the server runs. Vertex colors come from the surface map.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';

const SURFACE_COLORS: Record<number, [number, number, number]> = {
  [Physics.Surface.Road]: [0.32, 0.32, 0.34],
  [Physics.Surface.Dirt]: [0.45, 0.40, 0.25],
  [Physics.Surface.Mud]: [0.30, 0.22, 0.13],
  [Physics.Surface.DeepMud]: [0.18, 0.12, 0.07],
};

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  readonly terrain: Physics.TerrainData;
  private positions: Float32Array;
  private geometry: THREE.PlaneGeometry;

  constructor(seed: number, size: number, resolution: number) {
    this.terrain = Physics.generateTerrain({ seed, size, resolution });
    const n = resolution;
    // PlaneGeometry on XZ - we'll deform Y from heights.
    const geo = new THREE.PlaneGeometry(size, size, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    this.geometry = geo;

    const pos = geo.attributes.position as THREE.BufferAttribute;
    this.positions = pos.array as Float32Array;
    const colors = new Float32Array(pos.count * 3);

    // PlaneGeometry vertex order: row by row, top-left corner first. After
    // rotateX, +X is right, +Z is forward. We need to map (vertex i) ->
    // (col, row) in our heights array.
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const vi = r * n + c;
        const hi = r * n + c;
        this.positions[vi * 3 + 1] = this.terrain.heights[hi] ?? 0;
        const surf = this.terrain.surfaces[hi] ?? Physics.Surface.Dirt;
        const col = SURFACE_COLORS[surf] ?? SURFACE_COLORS[Physics.Surface.Dirt]!;
        colors[vi * 3] = col[0];
        colors[vi * 3 + 1] = col[1];
        colors[vi * 3 + 2] = col[2];
      }
    }
    pos.needsUpdate = true;
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  /** Apply a rut delta: lower the height at cell index `i` by `dy` and update
   *  the affected vertex + its neighbors' normals. Cheap; called per-cell. */
  applyRut(i: number, dy: number): void {
    const n = this.terrain.resolution;
    const r = Math.floor(i / n);
    const c = i % n;
    if (r < 0 || r >= n || c < 0 || c >= n) return;
    const cur = this.terrain.heights[i] ?? 0;
    const next = cur - dy;
    this.terrain.heights[i] = next;
    this.positions[i * 3 + 1] = next;
    // Darken the cell's color a bit so ruts read visually.
    const colors = (this.geometry.attributes.color as THREE.BufferAttribute).array as Float32Array;
    colors[i * 3] = Math.max(0.06, (colors[i * 3] ?? 0) * 0.92);
    colors[i * 3 + 1] = Math.max(0.04, (colors[i * 3 + 1] ?? 0) * 0.92);
    colors[i * 3 + 2] = Math.max(0.02, (colors[i * 3 + 2] ?? 0) * 0.92);
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    // Recompute normals only if a batch finished - caller can flush.
  }

  /** Call after a batch of applyRut() calls to recompute lighting. */
  flush(): void {
    this.geometry.computeVertexNormals();
  }
}
