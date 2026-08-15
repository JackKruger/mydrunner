// Sparse room-session rut geometry. Physics and rendering consume the same
// quantized replica, while the immutable Rapier heightfield remains the firm
// layer that can belly the chassis out.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';

const TILE_VERTICES = Physics.RUT_TILE_CELLS + 1;
const TILE_VERTEX_COUNT = TILE_VERTICES * TILE_VERTICES;
const TILE_INDEX_COUNT = Physics.RUT_TILE_CELLS * Physics.RUT_TILE_CELLS * 6;
const SURFACE_OFFSET = 0.018;

const RUT_VERTEX_SHADER = /* glsl */`
  attribute float rutDepth;
  uniform float displace;
  varying float vRutDepth;

  void main() {
    vRutDepth = rutDepth;
    vec3 displaced = position;
    displaced.y += mix(${SURFACE_OFFSET.toFixed(3)}, -rutDepth + 0.003, displace);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const RUT_FRAGMENT_SHADER = /* glsl */`
  varying float vRutDepth;
  void main() {
    float coverage = smoothstep(0.0005, 0.008, vRutDepth);
    if (coverage < 0.015) discard;
    float depthTone = smoothstep(0.0, 0.12, vRutDepth);
    gl_FragColor = vec4(mix(vec3(0.20, 0.12, 0.075), vec3(0.055, 0.025, 0.012), depthTone), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const RUT_MASK_FRAGMENT_SHADER = /* glsl */`
  varying float vRutDepth;
  void main() {
    if (smoothstep(0.0005, 0.008, vRutDepth) < 0.015) discard;
    gl_FragColor = vec4(0.0);
  }
`;

interface RutTileVisual {
  geometry: THREE.BufferGeometry;
  floor: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  mask: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  depths: Float32Array;
}

export class RutVisual {
  readonly group = new THREE.Group();
  private readonly floorMaterial: THREE.ShaderMaterial;
  private readonly maskMaterial: THREE.ShaderMaterial;
  private readonly emptyMesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly tileVisuals = new Map<string, RutTileVisual>();
  private terrain: Physics.TerrainData | null = null;
  private field: Physics.RutSessionReplica | null = null;
  private localOwnerId = 'local';
  private stencilSupported = true;
  private cells = 0;

  constructor() {
    this.floorMaterial = new THREE.ShaderMaterial({
      vertexShader: RUT_VERTEX_SHADER,
      fragmentShader: RUT_FRAGMENT_SHADER,
      uniforms: { displace: { value: 1 } },
      transparent: false,
      // The terrain has already established which surface is nearest. The
      // stencil mask below depth-tests against it, then confines this
      // recessed floor to only those visible pixels. Testing the displaced
      // floor against the unchanged terrain depth would hide the depression.
      depthWrite: false,
      depthTest: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.EqualStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    this.maskMaterial = new THREE.ShaderMaterial({
      vertexShader: RUT_VERTEX_SHADER,
      fragmentShader: RUT_MASK_FRAGMENT_SHADER,
      uniforms: { displace: { value: 0 } },
      colorWrite: false,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    const emptyGeometry = new THREE.BufferGeometry();
    emptyGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    emptyGeometry.setAttribute('rutDepth', new THREE.BufferAttribute(new Float32Array(0), 1));
    this.emptyMesh = new THREE.Mesh(emptyGeometry, this.floorMaterial);
    this.emptyMesh.visible = false;
  }

  /** Compatibility/debug accessor: the first live tile, or an empty mesh. */
  get mesh(): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    return this.tileVisuals.values().next().value?.floor ?? this.emptyMesh;
  }

  get activeCellCount(): number { return this.cells; }
  get activeTileCount(): number { return this.tileVisuals.size; }

  /** Test/debug access without exposing tile ownership to scene callers. */
  tileGeometry(tileX: number, tileZ: number): THREE.BufferGeometry | undefined {
    return this.tileVisuals.get(tileKey(tileX, tileZ))?.geometry;
  }

  setStencilSupported(supported: boolean): void {
    this.stencilSupported = supported;
    this.maskMaterial.stencilWrite = supported;
    this.floorMaterial.stencilWrite = supported;
    this.floorMaterial.stencilFunc = supported ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc;
    // Without stencil support the floor becomes a small surface-offset decal,
    // so it must use the regular depth buffer to stay behind hills.
    this.floorMaterial.depthTest = !supported;
    this.floorMaterial.depthWrite = !supported;
    this.floorMaterial.uniforms.displace!.value = supported ? 1 : 0;
    for (const tile of this.tileVisuals.values()) tile.mask.visible = supported;
  }

  setLocalOwnerId(id: string): void {
    if (id === this.localOwnerId) return;
    this.localOwnerId = id;
    this.field = this.terrain ? new Physics.RutSessionReplica(this.terrain.size, id) : null;
    this.clearTiles();
    this.cells = 0;
  }

  setTerrain(terrain: Physics.TerrainData | null): void {
    this.terrain = terrain;
    this.field = terrain ? new Physics.RutSessionReplica(terrain.size, this.localOwnerId) : null;
    this.clearTiles();
    this.cells = 0;
  }

  applyTile(tile: Physics.RutTilePayload): void {
    if (!this.field) return;
    this.updateDirty(this.field.applyTile({
      tileX: tile.tileX,
      tileZ: tile.tileZ,
      depths: new Uint8Array(tile.depths),
    }));
  }

  predictStamp(stamp: Physics.PredictedRutStamp): void {
    if (!this.field) return;
    this.updateDirty(this.field.predict(stamp));
  }

  applyStamps(stamps: readonly Physics.RutStamp[]): void {
    if (!this.field) return;
    this.updateDirty(this.field.applyAuthoritative(stamps));
  }

  resolveStamp(ownerSequence: number, accepted: boolean, globalSequence?: number): void {
    if (!this.field) return;
    this.updateDirty(this.field.resolve(ownerSequence, accepted, globalSequence));
  }

  dispose(): void {
    this.clearTiles();
    this.emptyMesh.geometry.dispose();
    this.floorMaterial.dispose();
    this.maskMaterial.dispose();
  }

  private updateDirty(dirty: readonly Physics.RutDirtyTile[]): void {
    if (!this.field || !this.terrain || dirty.length === 0) return;
    const affected = new Map<string, Physics.RutDirtyTile>();
    for (const tile of dirty) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const next = { tileX: tile.tileX + dx, tileZ: tile.tileZ + dz };
          affected.set(tileKey(next.tileX, next.tileZ), next);
        }
      }
    }
    for (const tile of affected.values()) this.updateTile(tile.tileX, tile.tileZ);
    this.cells = countActiveCells(this.field.exportTiles());
  }

  private updateTile(tileX: number, tileZ: number): void {
    const terrain = this.terrain!;
    const field = this.field!;
    const cellLimit = Math.floor(terrain.size / Physics.RUT_CELL_SIZE);
    const baseX = tileX * Physics.RUT_TILE_CELLS;
    const baseZ = tileZ * Physics.RUT_TILE_CELLS;
    if (baseX + Physics.RUT_TILE_CELLS < 0 || baseZ + Physics.RUT_TILE_CELLS < 0
      || baseX >= cellLimit || baseZ >= cellLimit) {
      this.removeTile(tileX, tileZ);
      return;
    }

    let visual = this.tileVisuals.get(tileKey(tileX, tileZ));
    const sampledDepths = visual?.depths ?? new Float32Array(TILE_VERTEX_COUNT);
    let nonZero = false;
    let offset = 0;
    for (let localZ = 0; localZ < TILE_VERTICES; localZ++) {
      const z = (baseZ + localZ) * Physics.RUT_CELL_SIZE - terrain.size * 0.5;
      for (let localX = 0; localX < TILE_VERTICES; localX++) {
        const x = (baseX + localX) * Physics.RUT_CELL_SIZE - terrain.size * 0.5;
        const depth = field.sampleDepth(x, z);
        sampledDepths[offset++] = depth;
        nonZero ||= depth > 0;
      }
    }
    if (!nonZero) {
      this.removeTile(tileX, tileZ);
      return;
    }
    if (!visual) {
      visual = this.createTile(tileX, tileZ, sampledDepths);
      this.tileVisuals.set(tileKey(tileX, tileZ), visual);
      return;
    }
    const attribute = visual.geometry.getAttribute('rutDepth') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
    visual.geometry.computeBoundingSphere();
  }

  private createTile(tileX: number, tileZ: number, depths: Float32Array): RutTileVisual {
    const terrain = this.terrain!;
    const baseX = tileX * Physics.RUT_TILE_CELLS;
    const baseZ = tileZ * Physics.RUT_TILE_CELLS;
    const positions = new Float32Array(TILE_VERTEX_COUNT * 3);
    let vertex = 0;
    for (let localZ = 0; localZ < TILE_VERTICES; localZ++) {
      const z = (baseZ + localZ) * Physics.RUT_CELL_SIZE - terrain.size * 0.5;
      for (let localX = 0; localX < TILE_VERTICES; localX++) {
        const x = (baseX + localX) * Physics.RUT_CELL_SIZE - terrain.size * 0.5;
        positions[vertex * 3] = x;
        positions[vertex * 3 + 1] = Physics.sampleHeightBilinear(terrain, x, z);
        positions[vertex * 3 + 2] = z;
        vertex++;
      }
    }
    const indices = new Uint16Array(TILE_INDEX_COUNT);
    let index = 0;
    for (let z = 0; z < Physics.RUT_TILE_CELLS; z++) {
      for (let x = 0; x < Physics.RUT_TILE_CELLS; x++) {
        const a = z * TILE_VERTICES + x;
        const b = a + TILE_VERTICES;
        indices[index++] = a;
        indices[index++] = b;
        indices[index++] = a + 1;
        indices[index++] = a + 1;
        indices[index++] = b;
        indices[index++] = b + 1;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('rutDepth', new THREE.BufferAttribute(depths, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    const floor = new THREE.Mesh(geometry, this.floorMaterial);
    floor.name = `session-rut-floor:${tileX},${tileZ}`;
    floor.renderOrder = -1;
    floor.frustumCulled = false;
    const mask = new THREE.Mesh(geometry, this.maskMaterial);
    mask.name = `session-rut-stencil:${tileX},${tileZ}`;
    mask.renderOrder = -2;
    mask.frustumCulled = false;
    mask.visible = this.stencilSupported;
    this.group.add(mask, floor);
    return { geometry, floor, mask, depths };
  }

  private removeTile(tileX: number, tileZ: number): void {
    const key = tileKey(tileX, tileZ);
    const visual = this.tileVisuals.get(key);
    if (!visual) return;
    this.group.remove(visual.floor, visual.mask);
    visual.geometry.dispose();
    this.tileVisuals.delete(key);
  }

  private clearTiles(): void {
    for (const tile of this.tileVisuals.values()) {
      this.group.remove(tile.floor, tile.mask);
      tile.geometry.dispose();
    }
    this.tileVisuals.clear();
  }
}

function countActiveCells(tiles: readonly Physics.RutTilePayload[]): number {
  let count = 0;
  for (const tile of tiles) for (const depth of tile.depths) if (depth !== 0) count++;
  return count;
}

function tileKey(tileX: number, tileZ: number): string { return `${tileX},${tileZ}`; }
