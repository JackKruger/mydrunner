// GLSL for the terrain surface, split out of terrain.ts so the mesh class
// stays about geometry and this stays about shading.
//
// Per-fragment colour comes from a procedural noise shader keyed off a
// Surface ID sampled from a DataTexture.
//
// Why a texture rather than a per-vertex attribute: linear interpolation
// across a triangle with two different surface IDs produces meaningless
// intermediate values (e.g. road=0 + grass=4 gives mud=2 mid-triangle).
// The texture stores one ID per cell with nearest-neighbour sampling, and
// the shader jitters the world-space lookup with FBM noise so cell-aligned
// boundaries become irregular and organic.
//
// This is a raw ShaderMaterial, so scene lights never reach it. Its uniforms
// are populated from renderEnvironment.ts, the same source as WorldView.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';
import { activeQuality, buildTerrainFragment, type QualitySettings } from './quality.js';
import { effectiveFogNear, RENDER_ENVIRONMENT } from './renderEnvironment.js';

const VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // Triplanar projection and lighting both operate in world space. The
  // built-in normalMatrix includes the view transform, so using it here made
  // the projection weights rotate with the camera. Near an overhead view a
  // flat patch then selected a side projection whose Y coordinate barely
  // changes, collapsing the grass map into long streaks.
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;
varying vec3 vNormal;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uAmbientIntensity;
uniform float uGrassBrightness;
uniform float uMacroTintStrength;
uniform float uTerrainTriplanarStrength;
uniform float uTerrainNormalStrength;
uniform float uTerrainShading;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;

uniform sampler2D uSurfaceMap;
uniform float uTerrainSize;
#ifdef TERRAIN_TEXTURES
uniform sampler2D uRoadAlbedo, uRoadNormalRoughness;
uniform sampler2D uDirtAlbedo, uDirtNormalRoughness;
uniform sampler2D uMudAlbedo, uMudNormalRoughness;
uniform sampler2D uDeepMudAlbedo, uDeepMudNormalRoughness;
uniform sampler2D uGrassAlbedo, uGrassNormalRoughness;
uniform sampler2D uGravelAlbedo, uGravelNormalRoughness;
uniform sampler2D uConcreteAlbedo, uConcreteNormalRoughness;
#endif
// uTerrainSize is the square world size in metres.

#ifdef TERRAIN_DETAIL_FADE
uniform float uDetailNear;        // m: full grain closer than this
uniform float uDetailFar;         // m: no grain past this
#endif

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
  // TERRAIN_OCTAVES comes from the quality prelude. GLSL ES 1.00 needs a
  // constant loop bound, which is why it is a #define and not a uniform.
  for (int i = 0; i < TERRAIN_OCTAVES; i++) {
    v += a * vnoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

// The procedural palette below is authored as ordinary sRGB colour values,
// just like the albedo image files used by the high quality tier. Texture
// sampling decodes those files to linear light automatically; the fallback
// needs the same decode explicitly before it enters the lighting equation.
// Without it, mid-range grass values such as 0.50 are treated as linear 0.50
// instead of sRGB 0.50 (linear ~0.21), producing fluorescent ground even when
// renderer tone mapping is disabled.
vec3 proceduralSRGBToLinear(vec3 value) {
  vec3 low = value / 12.92;
  vec3 high = pow((value + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, vec3(lessThanEqual(value, vec3(0.04045))));
}

// DETAIL(p, d) is the high-frequency grain tap, faded out with distance.
//
// Most screen pixels in a driving game are distant ground, where pebble and
// blade noise is well below a pixel — so skipping it there is the cheapest
// large saving in this shader. It fades toward 0.5 (vnoise's mean) rather
// than 0, so the ground does not change brightness as the band is crossed.
//
// Without TERRAIN_DETAIL_FADE the macro expands to a bare vnoise call, so the
// high tier compiles the exact expression it always did — no mix, no branch,
// no uniform read, and therefore no chance of a one-ulp difference showing up
// in the committed desktop screenshots.
#ifdef TERRAIN_DETAIL_FADE
float detailNoise(vec2 p, float d) {
  if (d <= 0.0) return 0.5;
  return mix(0.5, vnoise(p), d);
}
#define DETAIL(pp, d) detailNoise((pp), (d))
#else
#define DETAIL(pp, d) vnoise(pp)
#endif

vec3 proceduralColor(int s, vec2 p, float detail) {
  // Branch IDs are interpolated from Physics.Surface rather than written
  // as literals: this function is the one surface lookup that CAN'T fold
  // into SURFACE_INFO (each branch is a procedural texture, not a
  // colour), so the enum values are injected instead. Renumbering the
  // enum then repaints correctly rather than silently painting grass on
  // the road.
  //
  // Each surface mixes a low-frequency colour variation (broad patches)
  // with a high-frequency detail (grain / pebbles / blades).
  if (s == ${Physics.Surface.Road}) {
    // Road: compacted gravel-dirt with streaks along the +X axis.
    float n = fbm(vec2(p.x * 0.4, p.y * 1.6));
    float pebble = step(0.78, DETAIL(p * 9.0, detail));
    vec3 base = mix(vec3(0.42, 0.40, 0.38), vec3(0.60, 0.56, 0.50), n);
    return mix(base, vec3(0.30, 0.28, 0.25), pebble * 0.5);
  }
  if (s == ${Physics.Surface.Dirt}) {
    // Dirt: tan with brown variation.
    float n = vnoise(p * 0.6);
    float g = DETAIL(p * 7.0, detail);
    vec3 base = mix(vec3(0.42, 0.30, 0.16), vec3(0.66, 0.52, 0.32), n);
    return base * (0.85 + g * 0.30);
  }
  if (s == ${Physics.Surface.Mud}) {
    // Mud: readable wet brown with broad darker streaks.
    float n = vnoise(p * 0.45);
    float wet = DETAIL(p * 1.7 + 13.0, detail);
    vec3 base = mix(vec3(0.24, 0.16, 0.09), vec3(0.44, 0.30, 0.18), n);
    return base * (0.90 + wet * 0.34);
  }
  if (s == ${Physics.Surface.DeepMud}) {
    // Deep mud stays distinct without collapsing to black in shade.
    float n = vnoise(p * 0.5 + 7.0);
    return mix(vec3(0.16, 0.095, 0.05), vec3(0.33, 0.215, 0.12), n);
  }
  if (s == ${Physics.Surface.Grass}) {
    // Grass: green with darker patches and the occasional yellow blade.
    float macro = vnoise(p * 0.5);
    float blade = DETAIL(p * 14.0, detail);
    float yellow = step(0.80, vnoise(p * 0.25 + 3.0));
    vec3 base = mix(vec3(0.16, 0.30, 0.11), vec3(0.32, 0.50, 0.20), macro);
    base = mix(base, vec3(0.55, 0.50, 0.20), yellow * 0.35);
    return base * (0.78 + blade * 0.34);
  }
  if (s == ${Physics.Surface.Gravel}) {
    // Gravel: cool gray-brown with high-contrast pebble noise.
    float pebble = DETAIL(p * 9.0, detail);
    float macro = vnoise(p * 0.7);
    vec3 base = mix(vec3(0.34, 0.32, 0.30), vec3(0.58, 0.52, 0.48), macro);
    return base * (0.50 + pebble * 0.95);
  }
  if (s == ${Physics.Surface.Concrete}) {
    // Concrete: dark asphalt-ish grey with very fine grain + slight
    // patch variation and a thin "expansion joint" line every few
    // metres so the eye reads it as paving rather than flat colour.
    float grain = DETAIL(p * 18.0, detail);
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

struct TerrainMaterial { vec3 albedo; vec3 normal; float roughness; };

#ifdef TERRAIN_TEXTURES
vec4 projectMap(sampler2D map, vec3 p, vec3 weights) {
  vec4 planar = texture2D(map, p.xz);
#ifdef TERRAIN_TRIPLANAR
  vec4 x = texture2D(map, p.zy);
  vec4 y = texture2D(map, p.xz);
  vec4 z = texture2D(map, p.xy);
  vec4 triplanar = x * weights.x + y * weights.y + z * weights.z;
  return mix(planar, triplanar, uTerrainTriplanarStrength);
#else
  return planar;
#endif
}
TerrainMaterial texturedMaterial(sampler2D albedoMap, sampler2D normalRoughnessMap,
                                 vec3 worldP,
                                 vec3 weights, vec3 fallback) {
  vec3 p = worldP * 0.22;
  vec4 a = projectMap(albedoMap, p, weights);
  vec4 nr = projectMap(normalRoughnessMap, p, weights);
  TerrainMaterial m;
  // Transparent 1x1 placeholders remain bound until an image succeeds, so a
  // missing/slow asset falls back independently without a shader rebuild.
  float macroTint = 0.82 + 0.36 * vnoise(worldP.xz * 0.035);
  float tint = mix(1.0, macroTint, uMacroTintStrength);
  m.albedo = mix(fallback, a.rgb * tint, a.a);
  m.roughness = mix(0.82, nr.a, a.a);
  m.normal = normalize(vNormal);
#ifdef TERRAIN_NORMAL_MAPS
  vec3 n = nr.xyz * 2.0 - 1.0;
  vec3 nx = vec3(n.z, n.y, n.x);
  vec3 ny = vec3(n.x, n.z, n.y);
  vec3 nz = vec3(n.x, n.y, n.z);
  vec3 mapped = normalize(nx * weights.x + ny * weights.y + nz * weights.z);
  m.normal = normalize(mix(m.normal, mapped, a.a * uTerrainNormalStrength));
#endif
  return m;
}
#endif

TerrainMaterial sampleMaterial(int s, vec3 worldP, float detail) {
  TerrainMaterial m;
  vec3 fallback = proceduralSRGBToLinear(proceduralColor(s, worldP.xz, detail));
  m.albedo = fallback; m.normal = normalize(vNormal); m.roughness = 0.82;
#ifdef TERRAIN_TEXTURES
  vec3 weights = pow(abs(normalize(vNormal)), vec3(4.0));
  weights /= max(dot(weights, vec3(1.0)), 0.0001);
  if (s == ${Physics.Surface.Road}) return texturedMaterial(uRoadAlbedo,uRoadNormalRoughness,worldP,weights,fallback);
  if (s == ${Physics.Surface.Dirt}) return texturedMaterial(uDirtAlbedo,uDirtNormalRoughness,worldP,weights,fallback);
  if (s == ${Physics.Surface.Mud}) return texturedMaterial(uMudAlbedo,uMudNormalRoughness,worldP,weights,fallback);
  if (s == ${Physics.Surface.DeepMud}) return texturedMaterial(uDeepMudAlbedo,uDeepMudNormalRoughness,worldP,weights,fallback);
  if (s == ${Physics.Surface.Grass}) {
    TerrainMaterial grass = texturedMaterial(uGrassAlbedo,uGrassNormalRoughness,worldP,weights,fallback);
    grass.albedo *= uGrassBrightness;
    return grass;
  }
  if (s == ${Physics.Surface.Gravel}) return texturedMaterial(uGravelAlbedo,uGravelNormalRoughness,worldP,weights,fallback);
  if (s == ${Physics.Surface.Concrete}) return texturedMaterial(uConcreteAlbedo,uConcreteNormalRoughness,worldP,weights,fallback);
#endif
  // Grass occupies large, mostly sun-facing areas, so expose its albedo as a
  // separate art-direction control. This stays before lighting and therefore
  // remains valid under every tone-mapping option in the debug panel.
  if (s == ${Physics.Surface.Grass}) m.albedo *= 0.75 * (uGrassBrightness / 1.12);
  return m;
}

void main() {
  vec2 wp = vWorldPos.xz;

  // Distance first, because everything below is gated on it. Same values as
  // when this lived at the bottom — only the statement order moved.
  float dist = length(vWorldPos - cameraPosition);
  float fogFactor = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);

#ifdef TERRAIN_DETAIL_FADE
  // Fully fogged ground contributes under 1.5% of its own colour, and
  // uFogColor is the same constant the sky's horizon uses, so there is
  // nothing to compute out here.
  if (fogFactor > 0.985) {
    gl_FragColor = vec4(uFogColor, 1.0);
    return;
  }
  float detail = 1.0 - smoothstep(uDetailNear, uDetailFar, dist);
#else
  float detail = 1.0;
#endif

  // Jitter the surface lookup with low-frequency noise so cell-aligned
  // boundaries (the heightfield grid) become irregular instead of grid
  // lines. ~3m of displacement at a noise scale that produces 5-8m
  // wavelengths breaks up the seams without losing the broad layout.
  float jx = fbm(wp * 0.18) - 0.5;
  float jz = fbm(wp * 0.18 + 71.0) - 0.5;
  vec2 lookup = wp + vec2(jx, jz) * 4.5;

  vec2 uv = lookup / uTerrainSize + 0.5;
  // texture2D returns a normalised [0,1] value; we stored the byte ID as
  // the R channel of an unsigned-byte texture, so multiply by 255.
  float surfRaw = texture2D(uSurfaceMap, uv).r * 255.0;
  int sid = int(surfRaw + 0.5);

  TerrainMaterial material = sampleMaterial(sid, vWorldPos, detail);
  vec3 albedo = material.albedo;

#ifdef TERRAIN_BLEND2
  // Soften the boundary further with a fine secondary jitter.
  //
  // The most expensive lines in this shader: an unconditional vnoise, plus a
  // second dependent texture fetch and a whole second surfaceColor() on the
  // third or so of fragments that pass the threshold — all to smooth surface
  // edges. Dropped at low tier; the edges stay where the primary jitter put
  // them, just slightly crisper.
  float blend = vnoise(wp * 1.3);
  if (blend > 0.65) {
    vec2 lookup2 = wp + vec2(jx, jz) * 7.0;
    vec2 uv2 = lookup2 / uTerrainSize + 0.5;
    int sid2 = int(texture2D(uSurfaceMap, uv2).r * 255.0 + 0.5);
    if (sid != sid2) {
      TerrainMaterial material2 = sampleMaterial(sid2, vWorldPos, detail);
      float edgeMix = smoothstep(0.65, 0.8, blend);
      albedo = mix(albedo, material2.albedo, edgeMix);
      material.normal = normalize(mix(material.normal, material2.normal, edgeMix));
      material.roughness = mix(material.roughness, material2.roughness, edgeMix);
    }
  }
#endif

  // Sampled micro-normal Lambert plus a roughness-controlled sun highlight.
  vec3 N = normalize(material.normal);
  vec3 L = normalize(uSunDir);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 H = normalize(L + V);
  float diff = max(dot(N, L), 0.0);
  float shininess = mix(72.0, 5.0, material.roughness);
  float specular = pow(max(dot(N, H), 0.0), shininess) * (1.0 - material.roughness) * 0.35;
  float hemiMix = N.y * 0.5 + 0.5;
  vec3 ambient = mix(uGroundAmbient, uSkyAmbient, hemiMix) * uAmbientIntensity;
  vec3 shaded = albedo * (ambient + uSunColor * diff) + uSunColor * specular;
  vec3 lit = mix(albedo, shaded, uTerrainShading);

  // Linear fog matching THREE.Fog.
  vec3 final = mix(lit, uFogColor, fogFactor);

  gl_FragColor = vec4(final, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function makeTerrainMaterial(
  terrain: Physics.TerrainData,
  quality: QualitySettings = activeQuality(),
): THREE.ShaderMaterial {
  const env = RENDER_ENVIRONMENT;
  const sunDir = new THREE.Vector3(env.sun.position.x, env.sun.position.y, env.sun.position.z).normalize();

  // Pack the surface map into an 8-bit single-channel texture. Three.js
  // doesn't expose a clean `R8` format on WebGL 1, so we use Luminance
  // (.r works on both WebGL 1 and 2 and we only sample .r in the shader).
  const n = terrain.resolution;
  // Three.js dropped Luminance in newer revisions; use RedFormat which
  // is supported when WebGL 2 is active (Vite default in modern Chrome).
  // Fall back to a 4-channel texture if not.
  const dataRgba = new Uint8Array(n * n * 4);
  packSurfaces(terrain.surfaces, dataRgba, n, { r0: 0, c0: 0, rows: n, cols: n });
  const surfaceMap = new THREE.DataTexture(dataRgba, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  surfaceMap.magFilter = THREE.NearestFilter;
  surfaceMap.minFilter = THREE.NearestFilter;
  surfaceMap.colorSpace = THREE.NoColorSpace;
  surfaceMap.needsUpdate = true;

  const materialMaps = quality.terrainTextureResolution > 0 ? loadTerrainTextures() : {};
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(env.sun.color).multiplyScalar(env.sun.intensity) },
      uSkyAmbient: { value: new THREE.Color(env.hemisphere.skyColor) },
      uGroundAmbient: { value: new THREE.Color(env.hemisphere.groundColor) },
      uAmbientIntensity: { value: env.shaderAmbientIntensity },
      uGrassBrightness: { value: env.grassBrightness },
      uMacroTintStrength: { value: env.terrainMacroTint },
      uTerrainTriplanarStrength: { value: env.terrainTriplanarStrength },
      uTerrainNormalStrength: { value: env.terrainNormalStrength },
      uTerrainShading: { value: env.terrainShading },
      uFogColor: { value: new THREE.Color(env.fog.color) },
      uFogNear: { value: effectiveFogNear() },
      uFogFar: { value: env.fog.far },
      uSurfaceMap: { value: surfaceMap },
      uTerrainSize: { value: terrain.size },
      // Unused (and undeclared in the GLSL) unless the tier asks for the
      // fade. Three ignores uniforms the program does not declare.
      uDetailNear: { value: quality.terrainDetailNear },
      uDetailFar: { value: quality.terrainDetailFar },
      ...materialMaps,
    },
    vertexShader: VERT,
    fragmentShader: buildTerrainFragment(quality, FRAG),
  });
  return material;
}

export function refreshTerrainEnvironment(material: THREE.ShaderMaterial): void {
  const env = RENDER_ENVIRONMENT;
  (material.uniforms.uSunColor!.value as THREE.Color)
    .set(env.sun.color).multiplyScalar(env.sun.intensity);
  (material.uniforms.uSkyAmbient!.value as THREE.Color).set(env.hemisphere.skyColor);
  (material.uniforms.uGroundAmbient!.value as THREE.Color).set(env.hemisphere.groundColor);
  material.uniforms.uAmbientIntensity!.value = env.shaderAmbientIntensity;
  material.uniforms.uGrassBrightness!.value = env.grassBrightness;
  material.uniforms.uMacroTintStrength!.value = env.terrainMacroTint;
  material.uniforms.uTerrainTriplanarStrength!.value = env.terrainTriplanarStrength;
  material.uniforms.uTerrainNormalStrength!.value = env.terrainNormalStrength;
  material.uniforms.uTerrainShading!.value = env.terrainShading;
  material.uniforms.uFogNear!.value = effectiveFogNear();
}

const TERRAIN_SURFACES = ['road', 'dirt', 'mud', 'deep-mud', 'grass', 'gravel', 'concrete'] as const;
const TERRAIN_CHANNELS = ['albedo', 'normal-roughness'] as const;

function terrainTextureUrl(surface: (typeof TERRAIN_SURFACES)[number], channel: (typeof TERRAIN_CHANNELS)[number]): string {
  const extension = channel === 'albedo' ? 'png' : 'svg';
  return `/assets/terrain/${surface}-${channel}.${extension}`;
}

function loadTerrainTextures(): Record<string, { value: THREE.Texture }> {
  const loader = new THREE.TextureLoader();
  const uniforms: Record<string, { value: THREE.Texture }> = {};
  for (const surface of TERRAIN_SURFACES) {
    for (const channel of TERRAIN_CHANNELS) {
      // Alpha zero is the shader's missing-asset sentinel. TextureLoader
      // updates this same object when the request succeeds; an error simply
      // leaves the procedural fallback active.
      const texture = new THREE.DataTexture(new Uint8Array([128, 128, 255, 0]), 1, 1, THREE.RGBAFormat);
      texture.needsUpdate = true;
      const uniformName = `u${surface.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join('')}${channel[0]!.toUpperCase()}${channel.slice(1)}`;
      const uniform = { value: texture as THREE.Texture };
      uniforms[uniformName] = uniform;
      loader.load(terrainTextureUrl(surface, channel), (image) => {
        image.wrapS = image.wrapT = THREE.RepeatWrapping;
        image.magFilter = THREE.LinearFilter;
        image.minFilter = THREE.LinearMipmapLinearFilter;
        if (channel === 'albedo') image.colorSpace = THREE.SRGBColorSpace;
        texture.dispose();
        uniform.value = image;
      });
    }
  }
  return uniforms;
}

/** Every GPU texture owned by a terrain material, including uSurfaceMap. */
export function terrainTexturesOf(mat: THREE.ShaderMaterial): THREE.Texture[] {
  return Object.values(mat.uniforms)
    .map((uniform) => uniform.value)
    .filter((value): value is THREE.Texture => value instanceof THREE.Texture);
}

/** Copy surface IDs into the texture's RGBA buffer, R channel only.
 *
 *  Shared by the initial build and the editor's in-place repaint so there
 *  is exactly one statement of "the ID lives in .r" — the shader's
 *  `texture2D(uSurfaceMap, uv).r * 255.0` is the other half of it. */
export function packSurfaces(
  surfaces: Uint8Array,
  out: Uint8Array,
  n: number,
  rect: Physics.GridRect,
): void {
  const r1 = Math.min(n, rect.r0 + rect.rows);
  const c1 = Math.min(n, rect.c0 + rect.cols);
  for (let r = Math.max(0, rect.r0); r < r1; r++) {
    for (let c = Math.max(0, rect.c0); c < c1; c++) {
      const i = r * n + c;
      out[i * 4] = surfaces[i] ?? Physics.Surface.Dirt;
    }
  }
}

/** The surface-ID texture is only reachable through the uniform; both the
 *  repaint path and dispose() need it. */
export function surfaceTextureOf(mat: THREE.ShaderMaterial): THREE.DataTexture | undefined {
  return mat.uniforms.uSurfaceMap?.value as THREE.DataTexture | undefined;
}
