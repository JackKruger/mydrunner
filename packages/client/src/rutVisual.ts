// Persistent room-session rut overlay. The physics field is deliberately
// independent from the coarse terrain collider; this mesh consumes the same
// quantized tiles and feathers the 25 cm samples into continuous wet tracks.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';

const VERTICES_PER_CELL = 6;
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
    // Quantized field samples are interpolated across adjoining cells. The
    // fade discards the zero-depth perimeter, so an elliptical stamp reads as
    // a tyre groove rather than a collection of opaque 25 cm squares.
    float coverage = smoothstep(0.0005, 0.008, vRutDepth);
    if (coverage < 0.015) discard;
    float depthTone = smoothstep(0.0, 0.12, vRutDepth);
    vec3 dampMud = vec3(0.20, 0.12, 0.075);
    vec3 deepMud = vec3(0.055, 0.025, 0.012);
    vec3 colour = mix(dampMud, deepMud, depthTone);
    gl_FragColor = vec4(colour, 1.0);
  }
`;

const RUT_MASK_FRAGMENT_SHADER = /* glsl */`
  varying float vRutDepth;
  void main() {
    if (smoothstep(0.0005, 0.008, vRutDepth) < 0.015) discard;
    gl_FragColor = vec4(0.0);
  }
`;

export class RutVisual {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly mask: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private terrain: Physics.TerrainData | null = null;
  private field: Physics.RutSessionReplica | null = null;
  private localOwnerId = 'local';
  private readonly tiles = new Map<string, Physics.RutTilePayload>();
  private cells = 0;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geometry.setAttribute('rutDepth', new THREE.BufferAttribute(new Float32Array(0), 1));
    const material = new THREE.ShaderMaterial({
      vertexShader: RUT_VERTEX_SHADER,
      fragmentShader: RUT_FRAGMENT_SHADER,
      uniforms: { displace: { value: 1 } },
      transparent: false,
      depthWrite: true,
      // Normal depth testing is essential: vehicles, rocks and vegetation
      // must occlude the track. The tiny surface offset and polygon offset
      // keep it above the immutable coarse terrain without drawing through
      // foreground geometry.
      depthTest: true,
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
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'session-ruts';
    this.mesh.visible = false;
    this.mesh.renderOrder = 0;
    this.mesh.frustumCulled = false;
    const maskMaterial = new THREE.ShaderMaterial({
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
    this.mask = new THREE.Mesh(geometry, maskMaterial);
    this.mask.name = 'session-rut-stencil';
    this.mask.visible = false;
    this.mask.renderOrder = -2;
    this.mask.frustumCulled = false;
    this.group.add(this.mask, this.mesh);
  }

  get activeCellCount(): number { return this.cells; }

  setStencilSupported(supported: boolean): void {
    this.mask.material.stencilWrite = supported;
    this.mesh.material.stencilWrite = supported;
    this.mesh.material.stencilFunc = supported ? THREE.EqualStencilFunc : THREE.AlwaysStencilFunc;
    this.mesh.material.uniforms.displace!.value = supported ? 1 : 0;
    this.mask.visible = supported && this.cells > 0;
  }

  setLocalOwnerId(id: string): void {
    if (id === this.localOwnerId) return;
    this.localOwnerId = id;
    if (this.terrain) this.field = new Physics.RutSessionReplica(this.terrain.size, id);
    this.tiles.clear();
    this.rebuild();
  }

  setTerrain(terrain: Physics.TerrainData | null): void {
    this.terrain = terrain;
    this.field = terrain ? new Physics.RutSessionReplica(terrain.size, this.localOwnerId) : null;
    this.tiles.clear();
    this.rebuild();
  }

  applyTile(tile: Physics.RutTilePayload): void {
    if (!this.field) return;
    const copy = { tileX: tile.tileX, tileZ: tile.tileZ, depths: new Uint8Array(tile.depths) };
    this.tiles.set(`${tile.tileX},${tile.tileZ}`, copy);
    this.field.applyTile(copy);
    this.rebuild();
  }

  predictStamp(stamp: Physics.PredictedRutStamp): void {
    if (!this.field) return;
    this.field.predict(stamp);
    this.syncTilesAndRebuild();
  }

  applyStamps(stamps: readonly Physics.RutStamp[]): void {
    if (!this.field) return;
    this.field.applyAuthoritative(stamps);
    this.syncTilesAndRebuild();
  }

  resolveStamp(ownerSequence: number, accepted: boolean, globalSequence?: number): void {
    if (!this.field) return;
    this.field.resolve(ownerSequence, accepted, globalSequence);
    this.syncTilesAndRebuild();
  }

  private syncTilesAndRebuild(): void {
    if (!this.field) return;
    this.tiles.clear();
    for (const tile of this.field.exportTiles()) this.tiles.set(`${tile.tileX},${tile.tileZ}`, tile);
    this.rebuild();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mask.material.dispose();
  }

  private rebuild(): void {
    const terrain = this.terrain;
    if (!terrain) {
      this.cells = 0;
      this.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      this.mesh.geometry.setAttribute('rutDepth', new THREE.BufferAttribute(new Float32Array(0), 1));
      this.mesh.visible = false;
      this.mask.visible = false;
      return;
    }
    const field = this.field;
    if (!field) return;
    let count = 0;
    const cells = new Set<string>();
    const cellLimit = Math.floor(terrain.size / Physics.RUT_CELL_SIZE);
    for (const tile of this.tiles.values()) {
      for (let localZ = 0; localZ < Physics.RUT_TILE_CELLS; localZ++) {
        for (let localX = 0; localX < Physics.RUT_TILE_CELLS; localX++) {
          const byte = tile.depths[localZ * Physics.RUT_TILE_CELLS + localX]!;
          if (byte === 0) continue;
          count++;
          const gx = tile.tileX * Physics.RUT_TILE_CELLS + localX;
          const gz = tile.tileZ * Physics.RUT_TILE_CELLS + localZ;
          // A depth sample is shared by four quads. Including all four gives
          // the shader a zero-depth perimeter over which it can interpolate
          // a smooth edge instead of ending at a square cell boundary.
          addCell(cells, gx - 1, gz - 1, cellLimit);
          addCell(cells, gx, gz - 1, cellLimit);
          addCell(cells, gx - 1, gz, cellLimit);
          addCell(cells, gx, gz, cellLimit);
        }
      }
    }
    const orderedCells = [...cells].map((key) => {
      const comma = key.indexOf(',');
      return { gx: Number(key.slice(0, comma)), gz: Number(key.slice(comma + 1)) };
    }).sort((a, b) => a.gz - b.gz || a.gx - b.gx);
    const positions = new Float32Array(orderedCells.length * VERTICES_PER_CELL * 3);
    const depths = new Float32Array(orderedCells.length * VERTICES_PER_CELL);
    let offset = 0;
    let depthOffset = 0;
    for (const { gx, gz } of orderedCells) {
      const x0 = gx * Physics.RUT_CELL_SIZE - terrain.size * 0.5;
      const x1 = x0 + Physics.RUT_CELL_SIZE;
      const z0 = gz * Physics.RUT_CELL_SIZE - terrain.size * 0.5;
      const z1 = z0 + Physics.RUT_CELL_SIZE;
      const d00 = field.sampleDepth(x0, z0);
      const d10 = field.sampleDepth(x1, z0);
      const d01 = field.sampleDepth(x0, z1);
      const d11 = field.sampleDepth(x1, z1);
      const y00 = Physics.sampleHeightBilinear(terrain, x0, z0);
      const y10 = Physics.sampleHeightBilinear(terrain, x1, z0);
      const y01 = Physics.sampleHeightBilinear(terrain, x0, z1);
      const y11 = Physics.sampleHeightBilinear(terrain, x1, z1);
      offset = writeVertex(positions, offset, x0, y00, z0);
      depths[depthOffset++] = d00;
      offset = writeVertex(positions, offset, x0, y01, z1);
      depths[depthOffset++] = d01;
      offset = writeVertex(positions, offset, x1, y10, z0);
      depths[depthOffset++] = d10;
      offset = writeVertex(positions, offset, x1, y10, z0);
      depths[depthOffset++] = d10;
      offset = writeVertex(positions, offset, x0, y01, z1);
      depths[depthOffset++] = d01;
      offset = writeVertex(positions, offset, x1, y11, z1);
      depths[depthOffset++] = d11;
    }
    this.cells = count;
    this.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.mesh.geometry.setAttribute('rutDepth', new THREE.BufferAttribute(depths, 1));
    this.mesh.geometry.setDrawRange(0, orderedCells.length * VERTICES_PER_CELL);
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.visible = count > 0;
    this.mask.visible = count > 0 && this.mask.material.stencilWrite;
  }
}

function addCell(cells: Set<string>, gx: number, gz: number, limit: number): void {
  if (gx < 0 || gz < 0 || gx >= limit || gz >= limit) return;
  cells.add(`${gx},${gz}`);
}

function writeVertex(out: Float32Array, offset: number, x: number, y: number, z: number): number {
  out[offset] = x;
  out[offset + 1] = y;
  out[offset + 2] = z;
  return offset + 3;
}
