// Graphics quality tiers.
//
// One table, two presets, resolved once at startup. This is the third
// instance of the "one lookup per concept" convention after SURFACE_INFO and
// OBJECT_INFO: a `Record<QualityTier, QualitySettings>` means adding a knob is
// a compile error until both tiers name it, and it keeps `if (isMobile)` out
// of the twenty files that would otherwise grow one.
//
// The tier is a RENDER decision only. Nothing here reaches physics, the wire
// protocol, the tick rate or any tunable — a low-tier client simulates exactly
// what a high-tier one does, and the determinism test still guards that.
//
// Two hazards worth knowing before extending this:
//
//   Do NOT add a `precision: 'mediump'` field for the raw ShaderMaterials.
//   terrainShader scales world coordinates (+/-160 m) by up to 18 and hash21
//   then multiplies by 456, so intermediates reach ~1.3e6. mediump is fp16 on
//   Mali/Adreno/Apple (max 65504), which overflows to inf and makes fract()
//   undefined — and desktop GL treats mediump as fp32, so it would look
//   perfect on every machine you can test and be garbage on a phone. Cut the
//   number of noise taps instead.
//
//   `obstacleCullFloorM` is a gameplay invariant, not a tuning knob. See the
//   comment on the field.

import { loadStartOptions } from './startScreen.js';

export type QualityTier = 'high' | 'low';

export interface QualitySettings {
  tier: QualityTier;
  /** Upper bound on devicePixelRatio. The single highest-leverage field here:
   *  1.5 -> 1.0 is a 2.25x cut to every fragment shader in the frame. */
  pixelRatioCap: number;
  /** MSAA. A WebGLRenderer constructor argument, so it cannot change on a
   *  live context — see resolveQuality's note about reload scope. */
  antialias: boolean;
  /** The shadow depth pass. Off at low tier: it re-renders every casting mesh
   *  inside a fixed 200 m box every frame regardless of where the player is,
   *  and it is the largest single draw-call cost in the scene. */
  shadows: boolean;
  /** Use the wider PCF kernel when shadows are enabled. Low tier keeps its
   *  existing no-shadow path and therefore pays no cost for this setting. */
  softShadows: boolean;
  /** FBM octaves in the terrain surface shader. */
  terrainOctaves: number;
  /** The second surface lookup that softens cell-aligned surface boundaries.
   *  Costs a dependent texture fetch plus a whole extra surfaceColor() call on
   *  roughly a third of ground fragments. */
  terrainSecondaryBlend: boolean;
  /** Distance band (m) over which high-frequency terrain detail fades out.
   *  High tier pushes both past the far plane so `detail` is always 1 and the
   *  image is bit-identical to the shader before this existed. */
  terrainDetailNear: number;
  terrainDetailFar: number;
  /** FBM octaves in the cloud layer. */
  cloudOctaves: number;
  /** The second, finer cloud FBM. Doubles the sky's noise cost on its own. */
  cloudFineLayer: boolean;
  /** FBM octaves in the water surface shader. */
  waterOctaves: number;
  /** Ripple-derived surface normal (two extra FBM taps for the gradient).
   *  The flow-aligned wave fronts survive without it, so a river still reads
   *  as moving and a pond still reads as still. */
  waterRippleNormal: boolean;
  /** Foam filament and breakup detail: two more FBM taps, pure decoration. */
  waterFilaments: boolean;
  /** Hide small distant scenery. Never applies inside obstacleCullFloorM. */
  obstacleCull: boolean;
  /** No object closer than this is EVER hidden.
   *
   *  Winch anchoring raycasts the obstacle group (scene.ts pickWinchTarget)
   *  and THREE.Raycaster skips subtrees with visible === false, so culling
   *  something reachable by a cable would change what the player can do, not
   *  just what they can see. The anchor check rejects targets past 30 m and
   *  the raycaster's far is 80, so this sits clear of both. A unit test pins
   *  it above the winch reach. */
  obstacleCullFloorM: number;
  /** Particle pool size, and whether the pool is one InstancedMesh (1 draw
   *  call) rather than N transparent meshes. */
  maxParticles: number;
  particleInstancing: boolean;
  /** Cosmetic tyre-track ring buffer size. */
  trackSegments: number;
  /** Full-resolution coil springs on the undercarriage: ~640 triangles each,
   *  four per truck, mostly hidden behind a wheel. */
  detailedSuspension: boolean;
  /** Radial tyre segments; deformation stays enabled on both tiers. */
  tireSegments: number;
  /** Menu panorama redraw rate. It renders the whole world behind the start
   *  menu, which on a phone is a thermal warm-up before the player has
   *  pressed anything. */
  menuPanoramaHz: number;
  /** Cosmetic ground-cover samples per terrain cell (before biome filters). */
  groundCoverDensity: number;
  /** Maximum camera distance at which ground cover is drawn. */
  groundCoverDrawDistance: number;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  // Exactly the behaviour that shipped before this module existed. The
  // committed desktop screenshots are the proof, and a shader-source test
  // asserts the high-tier GLSL still contains what it used to.
  high: {
    tier: 'high',
    pixelRatioCap: 1.5,
    antialias: true,
    shadows: true,
    softShadows: true,
    terrainOctaves: 3,
    terrainSecondaryBlend: true,
    // Past the far plane, so `detail` is 1 everywhere the camera can see.
    terrainDetailNear: 1e9,
    terrainDetailFar: 2e9,
    cloudOctaves: 5,
    cloudFineLayer: true,
    waterOctaves: 3,
    waterRippleNormal: true,
    waterFilaments: true,
    obstacleCull: false,
    obstacleCullFloorM: 60,
    maxParticles: 160,
    particleInstancing: false,
    trackSegments: 8192,
    detailedSuspension: true,
    tireSegments: 36,
    menuPanoramaHz: 60,
    groundCoverDensity: 1,
    groundCoverDrawDistance: 115,
  },
  low: {
    tier: 'low',
    pixelRatioCap: 1,
    antialias: false,
    shadows: false,
    softShadows: false,
    terrainOctaves: 2,
    terrainSecondaryBlend: false,
    terrainDetailNear: 45,
    terrainDetailFar: 110,
    cloudOctaves: 3,
    cloudFineLayer: false,
    waterOctaves: 2,
    waterRippleNormal: false,
    waterFilaments: false,
    obstacleCull: true,
    obstacleCullFloorM: 60,
    maxParticles: 64,
    particleInstancing: true,
    trackSegments: 2048,
    detailedSuspension: false,
    tireSegments: 20,
    menuPanoramaHz: 20,
    groundCoverDensity: 0.38,
    groundCoverDrawDistance: 62,
  },
};

function parseTier(value: string | null | undefined): QualityTier | null {
  return value === 'low' || value === 'high' ? value : null;
}

/** Device heuristic, used when neither the URL nor the saved option decides.
 *
 *  `(pointer: coarse)` alone is not enough — it matches touchscreen laptops
 *  and 2-in-1s, which are not fill-bound. Requiring a small viewport too keeps
 *  those on the high tier. touchInput's isTouchDevice() deliberately stays
 *  separate: it answers "should I mount pedals", not "is this GPU slow". */
export function detectTier(): QualityTier {
  const uaData = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === 'boolean') return uaData.mobile ? 'low' : 'high';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const small = Math.min(window.innerWidth, window.innerHeight) <= 900;
  return coarse && small ? 'low' : 'high';
}

/** Resolve the tier: URL param, then the saved option, then the device.
 *
 *  `?q=low` / `?q=high` follows the existing `?auto=1` / `?car=` / `?dev`
 *  pattern, and is what the e2e low-tier run and a player A/B-ing on their own
 *  phone both use. */
export function resolveTier(): QualityTier {
  const fromUrl = parseTier(new URLSearchParams(location.search).get('q'));
  if (fromUrl) return fromUrl;
  const stored = loadStartOptions().graphics;
  if (stored !== 'auto') return stored;
  return detectTier();
}

let active: QualitySettings | null = null;

/** The tier for this page load.
 *
 *  Memoised because it must not change under a live renderer: `antialias` is a
 *  context-creation flag and the shadow/pixel-ratio decisions are made in the
 *  WorldView constructor, which main.ts runs at module scope. Changing the
 *  saved option therefore applies on the next load, and the options UI says so. */
export function activeQuality(): QualitySettings {
  if (!active) active = QUALITY[resolveTier()];
  return active;
}

/** Force a tier. The editor pins itself to 'high' with this — it exists to
 *  show the world as the game ships it, and it also builds Obstacles directly
 *  for its placement ghost, outside any WorldView. Tests use it too. */
export function setQualityTier(tier: QualityTier): void {
  active = QUALITY[tier];
}

/** Drop the memo so the next activeQuality() re-resolves. Tests only. */
export function resetQuality(): void {
  active = null;
}

/** GLSL `#define` prelude for the raw ShaderMaterials.
 *
 *  Preprocessor directives rather than JS string surgery: the driver
 *  validates them, so a typo is a shader compile error the smoke test catches
 *  (it asserts zero console errors, and three reports a failed link through
 *  console.error) instead of a silently wrong branch.
 *
 *  Note there is deliberately no precision define here — see the header. */
export function glslPrelude(q: QualitySettings): string {
  const lines = [
    `#define TERRAIN_OCTAVES ${q.terrainOctaves}`,
    `#define CLOUD_OCTAVES ${q.cloudOctaves}`,
    `#define WATER_OCTAVES ${q.waterOctaves}`,
  ];
  // Derived from the numbers rather than the tier name, so the table stays
  // the single source of truth: push the band past the far plane and the fade
  // machinery compiles out entirely.
  if (q.terrainDetailFar < 1e6) lines.push('#define TERRAIN_DETAIL_FADE 1');
  if (q.terrainSecondaryBlend) lines.push('#define TERRAIN_BLEND2 1');
  if (q.cloudFineLayer) lines.push('#define CLOUD_FINE 1');
  if (q.waterRippleNormal) lines.push('#define WATER_RIPPLE_NORMAL 1');
  if (q.waterFilaments) lines.push('#define WATER_FILAMENTS 1');
  return `${lines.join('\n')}\n`;
}

// Fragment-source builders. Each is exported so a unit test can assert what
// the high tier compiles WITHOUT a GPU — that test is the proof that the
// desktop image did not move when the low tier was added.
//
// `#define`s legally precede the `precision` statement each source opens with:
// preprocessor directives may appear before any declaration.

export function buildTerrainFragment(q: QualitySettings, source: string): string {
  return glslPrelude(q) + source;
}

export function buildSkyFragment(q: QualitySettings, source: string): string {
  return glslPrelude(q) + source;
}

export function buildWaterFragment(q: QualitySettings, source: string): string {
  return glslPrelude(q) + source;
}
