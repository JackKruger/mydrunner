// GLSL for the water surface. Split from water.ts on the same principle
// terrainShader.ts is split from terrain.ts: the mesh class stays about
// geometry, this stays about shading.
//
// Two things here are gameplay, not decoration, and should survive any
// restyling:
//
//   Depth tint. How dark the water reads IS the depth readout — it is
//   what lets a player pick a line before committing to the crossing.
//   A uniformly opaque surface would hide the one fact that matters.
//
//   Flow-scrolled ripples. The surface normal detail scrolls along the
//   authored velocity field, so a river visibly moves and a pond visibly
//   does not. Still water over a flowing river reads as a bug, and worse,
//   it hides the current that is about to push the truck sideways.
//
// This is a raw ShaderMaterial, so scene lights never reach it. Its uniforms
// are populated from renderEnvironment.ts, the same source as WorldView and
// terrainShader.ts, so the river cannot drift away from the bank lighting.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';
import { activeQuality, buildWaterFragment, type QualitySettings } from './quality.js';
import { RENDER_ENVIRONMENT } from './renderEnvironment.js';

const VERT = /* glsl */ `
attribute float aWet;
attribute float aDepth;
varying vec3 vWorldPos;
varying float vWet;
varying float vDepth;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWet = aWet;
  vDepth = aDepth;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;
varying float vWet;
varying float vDepth;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
uniform sampler2D uFlowMap;
uniform float uFlowRange;
uniform float uTerrainSize;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform float uDeepAt;
uniform float uFoamDepth;

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
  // WATER_OCTAVES comes from the quality prelude.
  for (int i = 0; i < WATER_OCTAVES; i++) {
    v += a * vnoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

void main() {
  // Dry vertices are collapsed onto the bed and flagged; discarding is
  // what lets one full-grid mesh serve a map with a thin river on it.
  if (vWet < 0.5) discard;

  vec2 uv = vWorldPos.xz / uTerrainSize + 0.5;
  // RG stores the authored velocity normalised by uFlowRange. Decode it
  // back to m/s before animating. The old shader used the normalised
  // value directly, making every visible current four times too slow.
  vec2 flow = (texture2D(uFlowMap, uv).rg * 2.0 - 1.0) * uFlowRange;
  float flowSpeed = length(flow);
  // Byte packing maps exact zero to a tiny non-zero value. Kill that
  // quantisation residue so a still pond really stays still.
  if (flowSpeed < 0.03) {
    flow = vec2(0.0);
    flowSpeed = 0.0;
  }
  vec2 flowDir = flowSpeed > 0.0 ? flow / flowSpeed : vec2(1.0, 0.0);
  vec2 flowAcross = vec2(-flowDir.y, flowDir.x);

  // Every detail is evaluated in the same advected world-space frame,
  // so the surface moves as one body instead of looking like unrelated
  // textures sliding through each other.
  vec2 p = vWorldPos.xz;
  vec2 q = p - flow * uTime;
  float r1 = fbm(q * 1.7);
#ifdef WATER_RIPPLE_NORMAL
  float r2 = fbm(q * 4.3 + 17.0);
  float ripple = r1 * 0.6 + r2 * 0.4;
#else
  // The fine ripple only modulates the albedo and the foam band; the coarse
  // layer already carries the motion. Dropped with the gradient taps below,
  // since both are decoration on top of the flow the player actually reads.
  float ripple = r1;
#endif

  // Build the normal from the advected ripple field. The mesh stays flat
  // (its 2.5 m vertex spacing is too coarse for wave geometry), while the
  // fragment-resolution normal catches broad ripples and coherent wave
  // fronts. The sine's gradient is analytic, saving six extra noise
  // samples per pixel compared with differencing the whole height field.
  float currentMix = smoothstep(0.08, 0.9, flowSpeed);
#ifdef WATER_RIPPLE_NORMAL
  float e = 0.07;
  float r1x = fbm((q + vec2(e, 0.0)) * 1.7);
  float r1z = fbm((q + vec2(0.0, e)) * 1.7);
  float frontPhase = dot(q, flowDir) * 4.8 + fbm(q * 0.31 + 57.0) * 5.0;
  float frontSlope = cos(frontPhase) * 4.8 * 0.012 * currentMix;
  float slopeX = (r1x - r1) * 0.10 / e + flowDir.x * frontSlope;
  float slopeZ = (r1z - r1) * 0.10 / e + flowDir.y * frontSlope;
#else
  // Three fbm taps gone: two for the ripple gradient, one for the wave-front
  // phase jitter. The wave fronts themselves stay, driven by the analytic
  // cosine along the flow direction -- so a river still visibly moves and a
  // pond still visibly does not, which is the part that is gameplay.
  float frontPhase = dot(q, flowDir) * 4.8 + r1 * 5.0;
  float frontSlope = cos(frontPhase) * 4.8 * 0.012 * currentMix;
  float slopeX = flowDir.x * frontSlope;
  float slopeZ = flowDir.y * frontSlope;
#endif
  vec3 n = normalize(vec3(-slopeX, 1.0, -slopeZ));

  // Depth tint: this is the readout the player steers by.
  float t = clamp(vDepth / uDeepAt, 0.0, 1.0);
  vec3 base = mix(uShallowColor, uDeepColor, t);

  // Shallow water is see-through, deep water is not.
  float alpha = mix(0.34, 0.82, t);

  // Sun glitter. Sharp and weak: a highlight on a moving surface, not a
  // light source.
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 h = normalize(normalize(uSunDir) + viewDir);
  float specTight = pow(max(dot(n, h), 0.0), 150.0);
  float specBroad = pow(max(dot(n, h), 0.0), 32.0);
  // Fresnel: water is a mirror at grazing angles and nearly clear looking
  // straight down. It is also what makes the far side of a river read as
  // brighter than the water at your own bumper, which is the depth cue
  // you actually steer by.
  float fres = pow(1.0 - max(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0), 4.0);

  // Foam at the waterline. Draws the shore, and marks the shallow edge
  // that is safe to enter.
  // Do not reverse smoothstep's edges: GLSL leaves that undefined and
  // different GPUs can lose the shoreline band entirely.
  float foam = (1.0 - smoothstep(0.0, uFoamDepth, vDepth)) * (0.55 + 0.45 * ripple);
  base = mix(base, vec3(0.86, 0.90, 0.92), foam * 0.45);
  alpha = mix(alpha, 0.9, foam * 0.5);

  // Long, broken filaments give the eye a feature it can actually track
  // downstream. They align to the local flow field, move at its real
  // speed, and fade completely out on still water.
#ifdef WATER_FILAMENTS
  vec2 streamUv = vec2(dot(q, flowDir) * 0.16, dot(q, flowAcross) * 1.35);
  float filaments = smoothstep(0.68, 0.88, fbm(streamUv + 73.0));
  float breakup = smoothstep(0.32, 0.72, fbm(q * 0.48 + 113.0));
  float currentInk = filaments * breakup * smoothstep(0.18, 1.05, flowSpeed);
  currentInk *= smoothstep(0.04, 0.28, vDepth);
  base = mix(base, vec3(0.72, 0.82, 0.84), currentInk * 0.24);
  alpha = clamp(alpha + currentInk * 0.05, 0.0, 1.0);
#else
  // Two more fbm taps. Purely decorative surface streaking -- the specular
  // and the wave fronts already show which way the current runs.
  float currentInk = 0.0;
#endif

  float diff = max(dot(n, normalize(uSunDir)), 0.0);
  vec3 lit = base * (uAmbient + uSunColor * (0.35 + 0.65 * diff));
  // A cool sky reflection is the cue that was missing from the almost
  // black deep water. It grows at grazing angles like real water.
  vec3 skyReflection = mix(vec3(0.34, 0.48, 0.58), uFogColor, 0.45);
  lit = mix(lit, skyReflection, fres * 0.58);
  lit += uSunColor * (specTight * 0.42 + specBroad * 0.07);
  // A touch of the ripple in the albedo so flow is legible even in flat
  // light, where the specular alone would not show it.
  lit += (ripple - 0.5) * 0.045 + currentInk * 0.025;
  alpha = clamp(alpha + fres * 0.25, 0.0, 1.0);

  float dist = length(vWorldPos - cameraPosition);
  float fogFactor = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  vec3 final = mix(lit, uFogColor, fogFactor);

  gl_FragColor = vec4(final, alpha);
}
`;

/** Depth at which the tint reaches uDeepColor, m. Chosen against the
 *  wading depths in vehicleGeom: by the time water reads fully "deep" it
 *  is already over every kind's air intake. */
const DEEP_AT = 1.4;

/** Depth below which the foam band draws, m. */
const FOAM_DEPTH = 0.22;

export function makeWaterMaterial(
  terrain: Physics.TerrainData,
  quality: QualitySettings = activeQuality(),
): THREE.ShaderMaterial {
  const env = RENDER_ENVIRONMENT;
  const n = terrain.resolution;
  const flowData = new Uint8Array(n * n * 4);
  packFlow(terrain, flowData, { r0: 0, c0: 0, rows: n, cols: n });
  const flowMap = new THREE.DataTexture(flowData, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Linear, unlike the surface map: flow is a continuous field and
  // nearest sampling would make the ripples visibly step at cell edges.
  flowMap.magFilter = THREE.LinearFilter;
  flowMap.minFilter = THREE.LinearFilter;
  flowMap.colorSpace = THREE.NoColorSpace;
  flowMap.needsUpdate = true;

  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(env.sun.position.x, env.sun.position.y, env.sun.position.z).normalize() },
      uSunColor: { value: new THREE.Color(env.sun.color).multiplyScalar(env.sun.intensity) },
      uAmbient: { value: new THREE.Color(env.hemisphere.skyColor).multiplyScalar(env.shaderAmbientIntensity) },
      uFogColor: { value: new THREE.Color(env.fog.color) },
      uFogNear: { value: env.fog.near },
      uFogFar: { value: env.fog.far },
      uTime: { value: 0 },
      uFlowMap: { value: flowMap },
      uFlowRange: { value: FLOW_RANGE },
      uTerrainSize: { value: terrain.size },
      uShallowColor: { value: new THREE.Color(0x668f83) },
      uDeepColor: { value: new THREE.Color(0x16404b) },
      uDeepAt: { value: DEEP_AT },
      uFoamDepth: { value: FOAM_DEPTH },
    },
    vertexShader: VERT,
    fragmentShader: buildWaterFragment(quality, FRAG),
    transparent: true,
    // Water must not occlude what is under it in the depth buffer, or the
    // bed it is meant to be see-through to stops drawing.
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Pack the flow field into RG, signed range mapped to [0, 255].
 *
 *  FLOW_RANGE bounds what a byte can express. Anything faster than this
 *  clamps visually while still being fully simulated — the physics reads
 *  the float field, this texture only drives ripple advection. */
const FLOW_RANGE = 4;

export function packFlow(
  terrain: Physics.TerrainData,
  out: Uint8Array,
  rect: Physics.GridRect,
): void {
  const n = terrain.resolution;
  const r1 = Math.min(n, rect.r0 + rect.rows);
  const c1 = Math.min(n, rect.c0 + rect.cols);
  for (let r = Math.max(0, rect.r0); r < r1; r++) {
    for (let c = Math.max(0, rect.c0); c < c1; c++) {
      const i = r * n + c;
      const fx = (terrain.waterFlowX[i] ?? 0) / FLOW_RANGE;
      const fz = (terrain.waterFlowZ[i] ?? 0) / FLOW_RANGE;
      out[i * 4] = Math.round((Math.max(-1, Math.min(1, fx)) * 0.5 + 0.5) * 255);
      out[i * 4 + 1] = Math.round((Math.max(-1, Math.min(1, fz)) * 0.5 + 0.5) * 255);
    }
  }
}

/** The flow texture is only reachable through the uniform; both the
 *  editor's repaint path and dispose() need it. */
export function flowTextureOf(mat: THREE.ShaderMaterial): THREE.DataTexture | undefined {
  return mat.uniforms.uFlowMap?.value as THREE.DataTexture | undefined;
}
