// Short-lived tyre marks drawn over the immutable terrain mesh. This is a
// visual layer, not the old heightfield-rut system: changing collision terrain
// would make every client-owned physics world agree on mutable ground again.

import * as THREE from 'three';
import {
  Physics,
  type PlayerId,
  type VehicleBuild,
  type VehicleState,
} from '@mydrunner/shared';

export interface TrackPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

interface TrackPoint {
  x: number;
  z: number;
  surface: Physics.Surface;
}

interface TrackStyle {
  color: readonly [number, number, number];
  opacity: number;
}

const DEFAULT_MAX_SEGMENTS = 8192;
const VERTICES_PER_SEGMENT = 4;
const INDICES_PER_SEGMENT = 6;
const MIN_TRACK_SPEED = 0.35;
const MIN_SEGMENT_LENGTH = 0.24;
const MAX_SEGMENT_LENGTH = 1.5;
const TERRAIN_SUPPORT_TOLERANCE = 0.6;
const TRACK_Y_OFFSET = 0.025;
const TRACK_WIDTH_SCALE = 0.9;

export const TYRE_TRACK_FADE_START_MS = 35_000;
export const TYRE_TRACK_LIFETIME_MS = 50_000;

const TRACK_STYLES: Partial<Record<Physics.Surface, TrackStyle>> = {
  [Physics.Surface.Dirt]: { color: rgb(0x49351f), opacity: 0.18 },
  [Physics.Surface.Mud]: { color: rgb(0x24150d), opacity: 0.30 },
  [Physics.Surface.DeepMud]: { color: rgb(0x100905), opacity: 0.38 },
  [Physics.Surface.Grass]: { color: rgb(0x34452a), opacity: 0.17 },
};

const VERTEX_SHADER = /* glsl */ `
attribute vec3 aTrackColor;
attribute float aBornMs;
attribute float aTrackOpacity;

varying vec3 vTrackColor;
varying float vBornMs;
varying float vTrackOpacity;
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vTrackColor = aTrackColor;
  vBornMs = aBornMs;
  vTrackOpacity = aTrackOpacity;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec3 vTrackColor;
varying float vBornMs;
varying float vTrackOpacity;
varying vec3 vWorldPos;

uniform float uNowMs;
uniform float uFadeStartMs;
uniform float uLifetimeMs;
uniform float uFogNear;
uniform float uFogFar;

void main() {
  float ageMs = max(0.0, uNowMs - vBornMs);
  float fade = 1.0 - smoothstep(uFadeStartMs, uLifetimeMs, ageMs);
  float fog = clamp((length(vWorldPos - cameraPosition) - uFogNear)
    / (uFogFar - uFogNear), 0.0, 1.0);
  float alpha = vTrackOpacity * fade * (1.0 - fog);
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(vTrackColor, alpha);
}
`;

/** The same fade curve used by the material, exposed as pure logic so its
 *  lifetime can be pinned without needing a WebGL context in unit tests. */
export function tyreTrackFade(ageMs: number): number {
  if (ageMs <= TYRE_TRACK_FADE_START_MS) return 1;
  if (ageMs >= TYRE_TRACK_LIFETIME_MS) return 0;
  const x = (ageMs - TYRE_TRACK_FADE_START_MS)
    / (TYRE_TRACK_LIFETIME_MS - TYRE_TRACK_FADE_START_MS);
  const smooth = x * x * (3 - 2 * x);
  return 1 - smooth;
}

/** The visible print is a little narrower than the full tyre sidewall. */
export function tyreTrackWidth(build: VehicleBuild): number {
  return Physics.geomFor(build).wheelWidth * TRACK_WIDTH_SCALE;
}

/**
 * One dynamic mesh containing every live mark. Slots are overwritten in a
 * ring, so a long multiplayer session cannot grow objects or GPU memory.
 */
export class TyreTrackSystem {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private terrain: Physics.TerrainData | null = null;
  private trails = new Map<PlayerId, Array<TrackPoint | null>>();
  private positions: Float32Array;
  private colors: Float32Array;
  private born: Float32Array;
  private opacities: Float32Array;
  private positionAttr: THREE.BufferAttribute;
  private colorAttr: THREE.BufferAttribute;
  private bornAttr: THREE.BufferAttribute;
  private opacityAttr: THREE.BufferAttribute;
  private cursor = 0;
  private segmentCount = 0;
  private elapsedMs = 0;
  private readonly maxSegments: number;

  constructor(maxSegments = DEFAULT_MAX_SEGMENTS) {
    // Four vertices per slot must remain addressable by Uint16 indices.
    this.maxSegments = Math.max(1, Math.min(16_384, Math.floor(maxSegments)));
    const vertexCount = this.maxSegments * VERTICES_PER_SEGMENT;
    this.positions = new Float32Array(vertexCount * 3);
    this.colors = new Float32Array(vertexCount * 3);
    this.born = new Float32Array(vertexCount);
    this.opacities = new Float32Array(vertexCount);

    const indices = new Uint16Array(this.maxSegments * INDICES_PER_SEGMENT);
    for (let i = 0; i < this.maxSegments; i++) {
      const v = i * VERTICES_PER_SEGMENT;
      const o = i * INDICES_PER_SEGMENT;
      indices[o] = v;
      indices[o + 1] = v + 2;
      indices[o + 2] = v + 1;
      indices[o + 3] = v + 2;
      indices[o + 4] = v + 3;
      indices[o + 5] = v + 1;
    }

    const geometry = new THREE.BufferGeometry();
    this.positionAttr = dynamicAttribute(this.positions, 3);
    this.colorAttr = dynamicAttribute(this.colors, 3);
    this.bornAttr = dynamicAttribute(this.born, 1);
    this.opacityAttr = dynamicAttribute(this.opacities, 1);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('aTrackColor', this.colorAttr);
    geometry.setAttribute('aBornMs', this.bornAttr);
    geometry.setAttribute('aTrackOpacity', this.opacityAttr);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uNowMs: { value: 0 },
        uFadeStartMs: { value: TYRE_TRACK_FADE_START_MS },
        uLifetimeMs: { value: TYRE_TRACK_LIFETIME_MS },
        // Matches WorldView and the raw terrain material.
        uFogNear: { value: 180 },
        uFogFar: { value: 480 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'tyre-tracks';
    this.mesh.visible = false;
    // Recomputing bounds for a circular dynamic mesh costs more than simply
    // letting the one cheap track draw participate in every frame.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.group.name = 'tyre-track-effects';
    this.group.add(this.mesh);
  }

  get activeSegmentCount(): number { return this.segmentCount; }
  get capacity(): number { return this.maxSegments; }

  setTerrain(terrain: Physics.TerrainData | null): void {
    this.terrain = terrain;
    this.clear();
  }

  sampleVehicle(
    id: PlayerId,
    build: VehicleBuild,
    vehicle: VehicleState,
    pose: TrackPose,
  ): void {
    const terrain = this.terrain;
    if (!terrain) return;

    let trail = this.trails.get(id);
    if (!trail) {
      trail = [null, null, null, null];
      this.trails.set(id, trail);
    }

    const geom = Physics.geomFor(build);
    const wheelPositions = Physics.restWheelPositions(build);
    const speed = Math.hypot(vehicle.linVel.x, vehicle.linVel.z);
    const width = tyreTrackWidth(build);
    const q = pose.quaternion;

    for (let i = 0; i < 4; i++) {
      const wheel = vehicle.wheels[i];
      if (!wheel?.contact) {
        trail[i] = null;
        continue;
      }

      const mount = wheelPositions[i]!;
      const loadedRadius = Math.max(0, geom.wheelRadius - wheel.tireDeflection);
      const localBottom = {
        x: mount.x - wheel.tireContactNormal.x * loadedRadius,
        y: mount.y - wheel.suspensionLength - wheel.tireContactNormal.y * loadedRadius,
        z: mount.z - wheel.tireContactNormal.z * loadedRadius,
      };
      const offset = Physics.rotateVecByQuat(localBottom, {
        x: q.x, y: q.y, z: q.z, w: q.w,
      });
      const x = pose.position.x + offset.x;
      const z = pose.position.z + offset.z;
      const bottomY = pose.position.y + offset.y;
      const point = this.trackPointAt(x, bottomY, z);
      if (!point) {
        trail[i] = null;
        continue;
      }

      const previous = trail[i];
      trail[i] = point;
      if (speed < MIN_TRACK_SPEED || !previous) continue;

      const dx = point.x - previous.x;
      const dz = point.z - previous.z;
      const distance = Math.hypot(dx, dz);
      if (distance < MIN_SEGMENT_LENGTH) {
        // Keep accumulating from the older anchor rather than replacing it
        // with tiny samples that never become a visible segment.
        trail[i] = previous;
        continue;
      }
      if (distance > MAX_SEGMENT_LENGTH || previous.surface !== point.surface) continue;

      const style = TRACK_STYLES[point.surface];
      if (style) this.writeSegment(previous, point, width, style, i);
    }
  }

  /** Forget continuity for players no longer in the snapshot. Their existing
   *  marks still fade normally; only a future rejoin must start a new line. */
  retainPlayers(active: ReadonlySet<PlayerId>): void {
    for (const id of this.trails.keys()) {
      if (!active.has(id)) this.trails.delete(id);
    }
  }

  update(frameDtMs: number): void {
    // Wall-clock lifetime should keep advancing while the tab is hidden; a
    // minute-long background pause must not bring minute-old marks back.
    this.elapsedMs += Math.max(0, frameDtMs);
    this.mesh.material.uniforms.uNowMs!.value = this.elapsedMs;
  }

  clear(): void {
    this.trails.clear();
    this.cursor = 0;
    this.segmentCount = 0;
    this.elapsedMs = 0;
    this.opacities.fill(0);
    this.mesh.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    this.mesh.material.uniforms.uNowMs!.value = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.group.clear();
    this.trails.clear();
  }

  private trackPointAt(x: number, bottomY: number, z: number): TrackPoint | null {
    const terrain = this.terrain!;
    if (Physics.worldToTerrainIndex(terrain, x, z) < 0) return null;
    const groundY = Physics.sampleHeightBilinear(terrain, x, z);
    if (Math.abs(bottomY - groundY) > TERRAIN_SUPPORT_TOLERANCE) return null;

    const surface = Physics.sampleSurface(terrain, x, z);
    if (!TRACK_STYLES[surface]) return null;
    const waterDepth = Physics.sampleWaterDepth(terrain, x, z);
    if (waterDepth > 0.03
      && surface !== Physics.Surface.Mud
      && surface !== Physics.Surface.DeepMud) return null;
    return { x, z, surface };
  }

  private writeSegment(
    start: TrackPoint,
    end: TrackPoint,
    width: number,
    style: TrackStyle,
    wheelIndex: number,
  ): void {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const invLength = 1 / Math.hypot(dx, dz);
    const px = -dz * invLength;
    const pz = dx * invLength;
    const halfStart = width * 0.5 * edgeVariation(start.x, start.z, wheelIndex);
    const halfEnd = width * 0.5 * edgeVariation(end.x, end.z, wheelIndex);
    const corners = [
      [start.x + px * halfStart, start.z + pz * halfStart],
      [start.x - px * halfStart, start.z - pz * halfStart],
      [end.x + px * halfEnd, end.z + pz * halfEnd],
      [end.x - px * halfEnd, end.z - pz * halfEnd],
    ] as const;

    const slot = this.cursor;
    const vertexOffset = slot * VERTICES_PER_SEGMENT;
    const positionOffset = vertexOffset * 3;
    for (let i = 0; i < VERTICES_PER_SEGMENT; i++) {
      const [x, z] = corners[i]!;
      const p = positionOffset + i * 3;
      this.positions[p] = x;
      this.positions[p + 1] = Physics.sampleHeightBilinear(this.terrain!, x, z) + TRACK_Y_OFFSET;
      this.positions[p + 2] = z;
      this.colors[p] = style.color[0];
      this.colors[p + 1] = style.color[1];
      this.colors[p + 2] = style.color[2];
      this.born[vertexOffset + i] = this.elapsedMs;
      this.opacities[vertexOffset + i] = style.opacity;
    }

    markRange(this.positionAttr, positionOffset, 12);
    markRange(this.colorAttr, positionOffset, 12);
    markRange(this.bornAttr, vertexOffset, 4);
    markRange(this.opacityAttr, vertexOffset, 4);

    this.cursor = (this.cursor + 1) % this.maxSegments;
    this.segmentCount = Math.min(this.maxSegments, this.segmentCount + 1);
    this.mesh.geometry.setDrawRange(0, this.segmentCount * INDICES_PER_SEGMENT);
    this.mesh.visible = true;
  }
}

function dynamicAttribute(array: Float32Array, itemSize: number): THREE.BufferAttribute {
  const attribute = new THREE.BufferAttribute(array, itemSize);
  attribute.setUsage(THREE.DynamicDrawUsage);
  return attribute;
}

function markRange(attribute: THREE.BufferAttribute, start: number, count: number): void {
  attribute.addUpdateRange(start, count);
  attribute.needsUpdate = true;
}

function edgeVariation(x: number, z: number, wheelIndex: number): number {
  const n = Math.sin(x * 12.9898 + z * 78.233 + wheelIndex * 19.19) * 43758.5453;
  return 0.92 + (n - Math.floor(n)) * 0.16;
}

function rgb(hex: number): readonly [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
