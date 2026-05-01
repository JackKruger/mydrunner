// Build a Three.js terrain mesh from a deterministic seed by reusing the
// same generator the server runs. Per-fragment colour comes from a
// procedural noise shader keyed off a per-vertex Surface ID, so each
// surface (road / dirt / mud / deep mud / grass / gravel) gets its own
// look without baking any image assets.
//
// We use a hand-written ShaderMaterial (with a single directional sun
// + ambient + linear fog) instead of macroing MeshStandardMaterial via
// onBeforeCompile - the macroed-pipeline approach was fragile for our
// custom attribute and we don't need PBR for terrain.

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

    const surfAttr = new Float32Array(pos.count);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        this.positions[i * 3 + 1] = this.terrain.heights[i] ?? 0;
        surfAttr[i] = this.terrain.surfaces[i] ?? Physics.Surface.Dirt;
      }
    }
    pos.needsUpdate = true;
    geo.setAttribute('aSurface', new THREE.BufferAttribute(surfAttr, 1));
    geo.computeVertexNormals();

    this.material = makeTerrainMaterial();
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
attribute float aSurface;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vSurface;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(normalMatrix * normal);
  vSurface = aSurface;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uSunDir;       // normalized direction TOWARD the light
uniform vec3 uSunColor;     // directional intensity (premultiplied)
uniform vec3 uAmbient;      // ambient term
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vSurface;

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
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

vec3 surfaceColor(int s, vec2 p) {
  // Road: compacted gravel-dirt. Streaked along +X.
  if (s == 0) {
    float n = fbm(vec2(p.x * 0.4, p.y * 1.6));
    float pebble = step(0.78, vnoise(p * 9.0));
    vec3 base = mix(vec3(0.42, 0.40, 0.38), vec3(0.60, 0.56, 0.50), n);
    return mix(base, vec3(0.30, 0.28, 0.25), pebble * 0.5);
  }
  // Dirt: tan with brown variation.
  if (s == 1) {
    float n = fbm(p * 0.6);
    float g = vnoise(p * 7.0);
    vec3 base = mix(vec3(0.42, 0.30, 0.16), vec3(0.66, 0.52, 0.32), n);
    return base * (0.85 + g * 0.30);
  }
  // Mud: dark wet brown with broad streaks.
  if (s == 2) {
    float n = fbm(p * 0.45);
    float wet = fbm(p * 1.7 + 13.0);
    vec3 base = mix(vec3(0.18, 0.12, 0.07), vec3(0.36, 0.24, 0.14), n);
    return base * (0.85 + wet * 0.40);
  }
  // Deep mud: nearly black with slick variation.
  if (s == 3) {
    float n = fbm(p * 0.5 + 7.0);
    return mix(vec3(0.05, 0.03, 0.02), vec3(0.18, 0.11, 0.06), n);
  }
  // Grass: green with darker macroes and the occasional yellow blade.
  if (s == 4) {
    float macro = fbm(p * 0.5);
    float blade = vnoise(p * 14.0);
    float yellow = step(0.80, fbm(p * 0.25 + 3.0));
    vec3 base = mix(vec3(0.16, 0.30, 0.11), vec3(0.32, 0.50, 0.20), macro);
    base = mix(base, vec3(0.55, 0.50, 0.20), yellow * 0.35);
    return base * (0.78 + blade * 0.34);
  }
  // Gravel: cool gray-brown with high-contrast pebble noise.
  if (s == 5) {
    float pebble = vnoise(p * 9.0);
    float macro = fbm(p * 0.7);
    vec3 base = mix(vec3(0.34, 0.32, 0.30), vec3(0.58, 0.52, 0.48), macro);
    return base * (0.50 + pebble * 0.95);
  }
  return vec3(1.0, 0.0, 1.0);
}

void main() {
  int sid = int(floor(vSurface + 0.5));
  vec3 albedo = surfaceColor(sid, vWorldPos.xz);

  // Lambert + ambient. uSunDir points toward the light source.
  float diff = max(dot(normalize(vNormal), normalize(uSunDir)), 0.0);
  vec3 lit = albedo * (uAmbient + uSunColor * diff);

  // Linear fog matching THREE.Fog (near, far).
  float dist = length(vWorldPos - cameraPosition);
  float fogFactor = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  vec3 final = mix(lit, uFogColor, fogFactor);

  gl_FragColor = vec4(final, 1.0);
}
`;

function makeTerrainMaterial(): THREE.ShaderMaterial {
  // Sun direction must match scene.ts (sun.position = (50, 80, 30) toward
  // origin). Normalising (50, 80, 30) gives roughly (0.5, 0.8, 0.3).
  const sunDir = new THREE.Vector3(50, 80, 30).normalize();
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(0xfff4dd).multiplyScalar(1.4) },
      uAmbient: { value: new THREE.Color(0xb8d0e2).multiplyScalar(0.45) },
      uFogColor: { value: new THREE.Color(0xb8d0e2) },
      uFogNear: { value: 180 },
      uFogFar: { value: 480 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
}
