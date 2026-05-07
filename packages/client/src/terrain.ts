// Build a Three.js terrain mesh from a deterministic seed by reusing the
// same generator the server runs. Per-fragment colour comes from a
// procedural noise shader keyed off a Surface ID sampled from a DataTexture.
//
// Why a texture rather than a per-vertex attribute: linear interpolation
// across a triangle with two different surface IDs produces meaningless
// intermediate values (e.g. road=0 + grass=4 gives mud=2 mid-triangle).
// The texture stores one ID per cell with nearest-neighbour sampling, and
// the shader jitters the world-space lookup with FBM noise so cell-aligned
// boundaries become irregular and organic.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  readonly terrain: Physics.TerrainData;
  private positions: Float32Array;
  private geometry: THREE.PlaneGeometry;
  private material: THREE.ShaderMaterial;

  constructor(seed: number, size: number, resolution: number) {
    this.terrain = Physics.generateTerrain({ seed, size, resolution });
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

    this.material = makeTerrainMaterial(this.terrain);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  /** Apply a rut delta: lower the height at cell index `i` by `dy`. Visual
   *  only; surface remains the same. Currently unused (ruts disabled). */
  applyRut(i: number, dy: number): void {
    const n = this.terrain.resolution;
    const r = Math.floor(i / n);
    const c = i % n;
    if (r < 0 || r >= n || c < 0 || c >= n) return;
    const cur = this.terrain.heights[i] ?? 0;
    const next = cur - dy;
    this.terrain.heights[i] = next;
    this.positions[i * 3 + 1] = next;
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Call after a batch of applyRut() calls to recompute lighting. */
  flush(): void {
    this.geometry.computeVertexNormals();
  }
}

const VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;
varying vec3 vNormal;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;

uniform sampler2D uSurfaceMap;
uniform float uTerrainSize;       // world size in m (square)

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

vec3 surfaceColor(int s, vec2 p) {
  // Each surface mixes a low-frequency colour variation (broad patches)
  // with a high-frequency detail (grain / pebbles / blades).
  if (s == 0) {
    // Road: compacted gravel-dirt with streaks along the +X axis.
    float n = fbm(vec2(p.x * 0.4, p.y * 1.6));
    float pebble = step(0.78, vnoise(p * 9.0));
    vec3 base = mix(vec3(0.42, 0.40, 0.38), vec3(0.60, 0.56, 0.50), n);
    return mix(base, vec3(0.30, 0.28, 0.25), pebble * 0.5);
  }
  if (s == 1) {
    // Dirt: tan with brown variation.
    float n = vnoise(p * 0.6);
    float g = vnoise(p * 7.0);
    vec3 base = mix(vec3(0.42, 0.30, 0.16), vec3(0.66, 0.52, 0.32), n);
    return base * (0.85 + g * 0.30);
  }
  if (s == 2) {
    // Mud: dark wet brown with broad streaks.
    float n = vnoise(p * 0.45);
    float wet = vnoise(p * 1.7 + 13.0);
    vec3 base = mix(vec3(0.18, 0.12, 0.07), vec3(0.36, 0.24, 0.14), n);
    return base * (0.85 + wet * 0.40);
  }
  if (s == 3) {
    // Deep mud: nearly black with slick variation.
    float n = vnoise(p * 0.5 + 7.0);
    return mix(vec3(0.05, 0.03, 0.02), vec3(0.18, 0.11, 0.06), n);
  }
  if (s == 4) {
    // Grass: green with darker patches and the occasional yellow blade.
    float macro = vnoise(p * 0.5);
    float blade = vnoise(p * 14.0);
    float yellow = step(0.80, vnoise(p * 0.25 + 3.0));
    vec3 base = mix(vec3(0.16, 0.30, 0.11), vec3(0.32, 0.50, 0.20), macro);
    base = mix(base, vec3(0.55, 0.50, 0.20), yellow * 0.35);
    return base * (0.78 + blade * 0.34);
  }
  if (s == 5) {
    // Gravel: cool gray-brown with high-contrast pebble noise.
    float pebble = vnoise(p * 9.0);
    float macro = vnoise(p * 0.7);
    vec3 base = mix(vec3(0.34, 0.32, 0.30), vec3(0.58, 0.52, 0.48), macro);
    return base * (0.50 + pebble * 0.95);
  }
  if (s == 6) {
    // Concrete: dark asphalt-ish grey with very fine grain + slight
    // patch variation and a thin "expansion joint" line every few
    // metres so the eye reads it as paving rather than flat colour.
    float grain = vnoise(p * 18.0);
    float patches = vnoise(p * 0.5);
    vec3 base = mix(vec3(0.22, 0.22, 0.22), vec3(0.32, 0.31, 0.30), patches);
    base *= (0.88 + grain * 0.18);
    float jointX = step(0.92, abs(fract(p.x / 4.0) - 0.5) * 2.0);
    float jointZ = step(0.92, abs(fract(p.y / 4.0) - 0.5) * 2.0);
    float joint = max(jointX, jointZ);
    return mix(base, base * 0.55, joint);
  }
  return vec3(1.0, 0.0, 1.0);
}

void main() {
  // Jitter the surface lookup with low-frequency noise so cell-aligned
  // boundaries (the heightfield grid) become irregular instead of grid
  // lines. ~3m of displacement at a noise scale that produces 5-8m
  // wavelengths breaks up the seams without losing the broad layout.
  vec2 wp = vWorldPos.xz;
  float jx = fbm(wp * 0.18) - 0.5;
  float jz = fbm(wp * 0.18 + 71.0) - 0.5;
  vec2 lookup = wp + vec2(jx, jz) * 4.5;

  vec2 uv = lookup / uTerrainSize + 0.5;
  // texture2D returns a normalised [0,1] value; we stored the byte ID as
  // the R channel of an unsigned-byte texture, so multiply by 255.
  float surfRaw = texture2D(uSurfaceMap, uv).r * 255.0;
  int sid = int(surfRaw + 0.5);

  vec3 albedo = surfaceColor(sid, wp);

  // Soften the boundary further with a fine secondary jitter.
  float blend = vnoise(wp * 1.3);
  if (blend > 0.65) {
    vec2 lookup2 = wp + vec2(jx, jz) * 7.0;
    vec2 uv2 = lookup2 / uTerrainSize + 0.5;
    int sid2 = int(texture2D(uSurfaceMap, uv2).r * 255.0 + 0.5);
    if (sid != sid2) {
      vec3 a2 = surfaceColor(sid2, wp);
      albedo = mix(albedo, a2, smoothstep(0.65, 0.8, blend));
    }
  }

  // Lambert + ambient.
  float diff = max(dot(normalize(vNormal), normalize(uSunDir)), 0.0);
  vec3 lit = albedo * (uAmbient + uSunColor * diff);

  // Linear fog matching THREE.Fog.
  float dist = length(vWorldPos - cameraPosition);
  float fogFactor = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  vec3 final = mix(lit, uFogColor, fogFactor);

  gl_FragColor = vec4(final, 1.0);
}
`;

function makeTerrainMaterial(terrain: Physics.TerrainData): THREE.ShaderMaterial {
  const sunDir = new THREE.Vector3(50, 80, 30).normalize();

  // Pack the surface map into an 8-bit single-channel texture. Three.js
  // doesn't expose a clean `R8` format on WebGL 1, so we use Luminance
  // (.r works on both WebGL 1 and 2 and we only sample .r in the shader).
  const n = terrain.resolution;
  // Three.js dropped Luminance in newer revisions; use RedFormat which
  // is supported when WebGL 2 is active (Vite default in modern Chrome).
  // Fall back to a 4-channel texture if not.
  const dataRgba = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const s = terrain.surfaces[i] ?? 1;
    dataRgba[i * 4] = s;
  }
  const surfaceMap = new THREE.DataTexture(dataRgba, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  surfaceMap.magFilter = THREE.NearestFilter;
  surfaceMap.minFilter = THREE.NearestFilter;
  surfaceMap.needsUpdate = true;

  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(0xfff4dd).multiplyScalar(1.4) },
      uAmbient: { value: new THREE.Color(0xd6e2ec).multiplyScalar(0.45) },
      uFogColor: { value: new THREE.Color(0xd6e2ec) },
      uFogNear: { value: 180 },
      uFogFar: { value: 480 },
      uSurfaceMap: { value: surfaceMap },
      uTerrainSize: { value: terrain.size },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}
