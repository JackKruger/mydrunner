// Procedural sky dome: a large inside-out sphere with a custom shader
// that produces a horizon-to-zenith gradient plus FBM clouds keyed off
// the view direction. No assets - the noise is the same hash21/vnoise
// pair used by the terrain shader.

import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // World-space direction from origin to vertex - we use this in the
  // fragment shader as a unit vector for the gradient and clouds.
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uCloudColor;
uniform float uCloudCover;   // [0,1] - threshold above which clouds form
uniform float uCloudSoftness;// [0,1] - smoothstep width on the threshold
uniform float uTime;

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
  // 3 octaves is plenty for clouds at this scale - 5 was overkill and
  // measurably slower per-frame.
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p *= 2.1;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  // Vertical gradient: horizon at d.y=0, zenith at d.y=1. We bias the
  // gradient toward the horizon so most of the sky reads as zenith blue.
  float t = clamp(d.y, 0.0, 1.0);
  t = pow(t, 0.55);
  vec3 sky = mix(uHorizon, uZenith, t);

  // Clouds: project the upper hemisphere onto a plane via stereographic
  // projection so noise tiles smoothly without poles. Slow drift via
  // uTime. Hide clouds below the horizon.
  if (d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.6);
    uv += vec2(uTime * 0.012, uTime * 0.005);
    float n = fbm(uv * 1.4);
    float coverage = smoothstep(uCloudCover, uCloudCover + uCloudSoftness, n);
    // Clouds get whiter as they approach zenith, more grey near horizon.
    vec3 cloud = mix(uCloudColor * 0.78, uCloudColor, t);
    sky = mix(sky, cloud, coverage * (0.4 + 0.6 * t));
  }

  gl_FragColor = vec4(sky, 1.0);
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private startMs: number;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: new THREE.Color(0xd6e2ec) },
        uZenith: { value: new THREE.Color(0x6c95c4) },
        uCloudColor: { value: new THREE.Color(0xfafcff) },
        uCloudCover: { value: 0.55 },
        uCloudSoftness: { value: 0.18 },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    // Big enough to contain the world; not so big it pushes the far plane.
    const geo = new THREE.SphereGeometry(450, 24, 12);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.startMs = performance.now();
  }

  /** Call once per render frame - keeps the dome centred on the camera so
   *  the horizon stays the horizon as the player drives, and ticks the
   *  cloud-drift uTime. */
  update(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
    this.mat.uniforms.uTime!.value = (performance.now() - this.startMs) / 1000;
  }
}
