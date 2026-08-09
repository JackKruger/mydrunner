// Procedural sky dome: a large inside-out sphere with a custom shader
// that produces a horizon-to-zenith gradient plus FBM clouds keyed off
// the view direction. No assets - the noise is the same hash21/vnoise
// pair used by the terrain shader.

import * as THREE from 'three';
import { activeQuality, buildSkyFragment, type QualitySettings } from './quality.js';

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
uniform vec3 uSunDir;        // unit vector toward the sun
uniform vec3 uSunColor;
uniform vec3 uHorizonWarm;   // warm tint mixed into the horizon band

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
float fbm5(vec2 p) {
  // 5 octaves for puffier, more detailed clouds than the terrain shader.
  // CLOUD_OCTAVES comes from the quality prelude.
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < CLOUD_OCTAVES; i++) {
    v += a * vnoise(p);
    p *= 2.03;
    a *= 0.48;
  }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float t = clamp(d.y, 0.0, 1.0);

  // ---- Sky gradient ----
  // Warm horizon band: blends a golden/warm tone into the lower sky so
  // the horizon reads as atmospheric rather than just a flat blue edge.
  // The warm band is strongest at t=0 (horizon) and fades above ~15 deg.
  float horizonBand = smoothstep(0.25, 0.0, t);
  vec3 horizonCol = mix(uHorizon, uHorizonWarm, horizonBand * 0.55);
  float grad = pow(t, 0.55);
  vec3 sky = mix(horizonCol, uZenith, grad);

  // ---- Clouds ----
  if (d.y > 0.0) {
    // Stereographic projection for smooth polar tiling.
    vec2 uv = d.xz / (d.y + 0.6);
    uv += vec2(uTime * 0.012, uTime * 0.005);

    // Two scales of FBM: large puffy masses + fine wispy detail.
#ifdef CLOUD_FINE
    float nLarge = fbm5(uv * 1.2);
    float nFine  = fbm5(uv * 3.5 + 17.0);
    float n = nLarge * 0.72 + nFine * 0.28;
#else
    // The fine layer doubles the sky's noise cost on its own and only adds
    // wisps at the edges of masses the large layer already places. Scale the
    // large layer by the same 0.72 + 0.28 the blend used, so cloud coverage
    // lands on the same side of uCloudCover and the sky keeps its shape.
    float n = fbm5(uv * 1.2);
#endif

    float coverage = smoothstep(uCloudCover, uCloudCover + uCloudSoftness, n);

    // Cloud edge softening: lower coverage near horizon for a natural
    // taper, denser overhead.
    float heightFade = smoothstep(0.0, 0.35, d.y);
    coverage *= heightFade;

    // Cloud colour: whiter at zenith, slightly warm near horizon.
    vec3 cloudBase = mix(uCloudColor * 0.82, uCloudColor, t);
    // Subtle undershade on thick parts for depth.
    float thickness = smoothstep(uCloudCover + 0.05, uCloudCover + 0.25, n);
    vec3 cloud = mix(cloudBase, cloudBase * 0.72, thickness * 0.3);

    sky = mix(sky, cloud, coverage * (0.45 + 0.55 * t));
  }

  // ---- Sun disc + glow ----
  // Fixed sun position. The disc is a sharp circle; the glow is a wider
  // soft halo that tints nearby sky warm.
  float sunDot = dot(d, uSunDir);
  // Disc: sharp cutoff at ~0.9997 (~1.4 deg radius).
  float disc = smoothstep(0.9993, 0.9998, sunDot);
  // Glow: wide soft halo (~8 deg).
  float glow = pow(max(0.0, sunDot), 64.0);
  // Horizon scatter: sun glow intensifies near the horizon for a
  // "golden hour" feel even when the sun is higher.
  float horizonScatter = smoothstep(0.3, 0.0, d.y) * 0.4;

  sky += uSunColor * (disc * 1.8);
  sky += uSunColor * (glow * 0.35 + horizonScatter * glow);

  gl_FragColor = vec4(sky, 1.0);
}
`;

export class Sky {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private startMs: number;

  constructor(quality: QualitySettings = activeQuality()) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uHorizon: { value: new THREE.Color(0xd6e2ec) },
        uZenith: { value: new THREE.Color(0x6c95c4) },
        uCloudColor: { value: new THREE.Color(0xfafcff) },
        uCloudCover: { value: 0.52 },
        uCloudSoftness: { value: 0.18 },
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.5, 0.45, 0.3).normalize() },
        uSunColor: { value: new THREE.Color(0xfff4dd) },
        uHorizonWarm: { value: new THREE.Color(0xf0c88a) },
      },
      vertexShader: VERT,
      fragmentShader: buildSkyFragment(quality, FRAG),
      side: THREE.BackSide,
      depthWrite: false,
    });
    // Big enough to contain the world; not so big it pushes the far plane.
    const geo = new THREE.SphereGeometry(450, 24, 12);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    // Draw the dome AFTER the opaque world, not before it.
    //
    // Three sorts the opaque list by groupOrder, then renderOrder, then
    // *material.id*, and only then by depth. Sky's material is constructed
    // before every other world material, so with everything at the default
    // renderOrder 0 the dome sorted first and painted a 40-noise-tap shader
    // across the whole screen, which the terrain then overdrew. It already
    // has depthWrite off and depthTest on, so ordering it last instead lets
    // the depth buffer reject every hidden sky fragment. No visual change.
    //
    // 1 clears the default-0 world. WinchView's marker sits at 10 and is
    // depthTest:false, so it still draws over everything either way.
    this.mesh.renderOrder = 1;
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
