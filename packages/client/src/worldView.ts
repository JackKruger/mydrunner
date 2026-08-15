// The world as seen: renderer, lighting, sky, terrain, obstacles,
// landmarks. Everything that is the same whether you are driving through
// the map or editing it.
//
// Extracted from Scene so the level editor renders the world the game
// actually ships rather than a lookalike. The lighting here is not
// decoration: terrainShader.ts is a raw ShaderMaterial that reimplements
// Lambert and fog with its own copies of the sun direction and fog range,
// so a second scene built by hand would light the ground differently from
// everything standing on it, and nothing would catch it but a screenshot.
//
// Deliberately does NOT own a camera or a render loop — the game drives a
// ChaseCamera from snapshots and the editor drives a fly camera from
// input. Both pass their own camera to render().

import * as THREE from 'three';
import { Maps, Physics } from '@mydrunner/shared';
import { TerrainMesh } from './terrain.js';
import { WaterMesh } from './water.js';
import { Obstacles } from './obstacles/index.js';
import { LandmarkMeshes } from './landmarks.js';
import { MarkerMeshes, type MarkerViewOptions } from './markers.js';
import { Sky } from './sky.js';
import { disposeObject3D } from './three/dispose.js';
import { activeQuality, type QualitySettings } from './quality.js';
import { GroundCover } from './groundCover.js';
import {
  createOutdoorEnvironment,
  effectiveFogNear,
  RENDER_ENVIRONMENT,
  type RenderTuningKey,
  type RenderTuningTarget,
} from './renderEnvironment.js';

/** What the world is made of. The game composes this from the terrain
 *  handshake; the editor composes it from the map being edited. */
export interface WorldVisuals {
  terrain: Physics.TerrainData;
  obstacles: readonly Physics.Obstacle[];
  landmarks: Physics.Landmarks;
  /** Authored markers. Optional because the menu panorama and the tests
   *  compose a world from the generator, which authors none. */
  markers?: readonly Maps.Marker[];
}

export interface WorldViewOptions {
  /** Draw every authored marker kind and its trigger radius. The editor
   *  turns this on; the game shows only the markers it simulates. */
  markerPreview?: boolean;
}

export class WorldView implements RenderTuningTarget {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();

  private sky: Sky;
  private terrainMeshRef: TerrainMesh | null = null;
  private waterMeshRef: WaterMesh | null = null;
  private terrainPlaceholder: THREE.Mesh | null = null;
  private obstacles: Obstacles | null = null;
  private landmarks: LandmarkMeshes | null = null;
  private markers: MarkerMeshes | null = null;
  private groundCover: GroundCover | null = null;
  private currentTerrain: Physics.TerrainData | null = null;
  private readonly quality: QualitySettings;
  readonly stencilSupported: boolean;
  private readonly markerOptions: MarkerViewOptions;
  private readonly disposeEnvironment: () => void;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly fog: THREE.Fog;

  /** `quality` defaults to the resolved tier so the game gets it for free.
   *  The editor passes QUALITY.high explicitly — it exists to show the world
   *  as the game ships it, so it must not render a reduced version of it. */
  constructor(
    canvasParent: HTMLElement,
    quality: QualitySettings = activeQuality(),
    options: WorldViewOptions = {},
  ) {
    this.quality = quality;
    this.markerOptions = { preview: options.markerPreview === true };
    // MSAA off at low tier. On a tile-based mobile GPU the resolve is a
    // bandwidth cost on every frame, and at pixelRatioCap 1.0 the crispness
    // it was buying has already been given up.
    this.renderer = new THREE.WebGLRenderer({ antialias: quality.antialias, stencil: true });
    this.renderer.outputColorSpace = RENDER_ENVIRONMENT.outputColorSpace;
    this.renderer.toneMapping = RENDER_ENVIRONMENT.toneMapping;
    this.renderer.toneMappingExposure = RENDER_ENVIRONMENT.exposure;
    this.stencilSupported = this.renderer.getContextAttributes()?.stencil ?? false;
    // Cap pixel ratio. Uncapped on a 2x or 3x display the GPU pays 4-9x
    // the fragment cost - the difference between 60 FPS and 20 FPS on
    // mid-tier mobile + integrated GPUs. 1.5 is a good compromise: still
    // crisper than CSS pixels, well under the cliff. The low tier drops to
    // 1.0, which is a 2.25x cut to every fragment shader in the frame and
    // the single largest lever in the whole quality table.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // Off at low tier. The depth pass re-renders every casting mesh inside a
    // fixed 200 m box every frame no matter where the player is — the biggest
    // single draw-call cost in the scene. Note the terrain does NOT receive
    // shadows either way: its raw ShaderMaterial has no shadowmap chunks, so
    // terrain.ts's receiveShadow is inert. What is lost is scenery and
    // vehicle self-shadowing, which is a visible change, not a free one.
    this.renderer.shadowMap.enabled = quality.shadows;
    // High tier uses the wider soft-PCF kernel. Low tier retains the basic
    // selection even though its shadow pass is disabled, preserving its
    // existing zero-cost behaviour if shadows remain off.
    this.renderer.shadowMap.type = quality.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    canvasParent.appendChild(this.renderer.domElement);

    const environment = createOutdoorEnvironment(this.renderer);
    this.scene.environment = environment.texture;
    this.disposeEnvironment = environment.dispose;

    // Procedural sky dome replaces the flat background colour. Fog still
    // matches the horizon tint so distant terrain melts into the sky.
    this.fog = new THREE.Fog(RENDER_ENVIRONMENT.fog.color, effectiveFogNear(), RENDER_ENVIRONMENT.fog.far);
    this.scene.fog = this.fog;
    this.sky = new Sky(quality);
    this.scene.add(this.sky.mesh);

    const sun = new THREE.DirectionalLight(RENDER_ENVIRONMENT.sun.color, RENDER_ENVIRONMENT.sun.intensity);
    this.sun = sun;
    sun.position.set(RENDER_ENVIRONMENT.sun.position.x, RENDER_ENVIRONMENT.sun.position.y, RENDER_ENVIRONMENT.sun.position.z);
    // Both flags matter: leaving the light configured to cast while the
    // shadow map is disabled still costs the shadow-camera bookkeeping.
    sun.castShadow = quality.shadows;
    // 1024² instead of 2048². Shadows still readable on a 200 m × 200 m
    // shadow camera frustum (~20 cm per shadow texel) and the GPU pays
    // a quarter of the depth-pass fragment cost.
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -100;
    sun.shadow.camera.right = 100;
    sun.shadow.camera.top = 100;
    sun.shadow.camera.bottom = -100;
    // Bigger shadow bias - PCFShadowMap can produce light "acne" near
    // edges with the larger texel pitch.
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);
    this.hemisphere = new THREE.HemisphereLight(
      RENDER_ENVIRONMENT.hemisphere.skyColor,
      RENDER_ENVIRONMENT.hemisphere.groundColor,
      RENDER_ENVIRONMENT.hemisphere.intensity,
    );
    this.scene.add(this.hemisphere);

    // Placeholder ground until the world arrives. Replaced by setWorld().
    const placeholder = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x556b2f }),
    );
    placeholder.rotation.x = -Math.PI / 2;
    placeholder.receiveShadow = true;
    this.scene.add(placeholder);
    this.terrainPlaceholder = placeholder;
  }

  /** Non-null once setWorld has run. The editor's brushes write through
   *  this to push height and surface edits without a full rebuild. */
  get terrainMesh(): TerrainMesh | null {
    return this.terrainMeshRef;
  }

  /** Null on a map with no water at all — the common case, and worth not
   *  drawing a full-grid transparent plane for. The editor's water brush
   *  writes through this, and calls refreshWater() when a dry map gains
   *  its first cell of water. */
  get waterMesh(): WaterMesh | null {
    return this.waterMeshRef;
  }

  getRenderTuning(key: RenderTuningKey): number {
    switch (key) {
      case 'exposure': return RENDER_ENVIRONMENT.exposure;
      case 'sunIntensity': return RENDER_ENVIRONMENT.sun.intensity;
      case 'hemisphereIntensity': return RENDER_ENVIRONMENT.hemisphere.intensity;
      case 'shaderAmbientIntensity': return RENDER_ENVIRONMENT.shaderAmbientIntensity;
      case 'grassBrightness': return RENDER_ENVIRONMENT.grassBrightness;
      case 'terrainMacroTint': return RENDER_ENVIRONMENT.terrainMacroTint;
      case 'terrainTriplanarStrength': return RENDER_ENVIRONMENT.terrainTriplanarStrength;
      case 'terrainNormalStrength': return RENDER_ENVIRONMENT.terrainNormalStrength;
      case 'terrainShading': return RENDER_ENVIRONMENT.terrainShading;
      case 'fogAmount': return RENDER_ENVIRONMENT.fog.amount;
    }
  }

  setRenderTuning(key: RenderTuningKey, value: number): void {
    switch (key) {
      case 'exposure': RENDER_ENVIRONMENT.exposure = value; break;
      case 'sunIntensity': RENDER_ENVIRONMENT.sun.intensity = value; break;
      case 'hemisphereIntensity': RENDER_ENVIRONMENT.hemisphere.intensity = value; break;
      case 'shaderAmbientIntensity': RENDER_ENVIRONMENT.shaderAmbientIntensity = value; break;
      case 'grassBrightness': RENDER_ENVIRONMENT.grassBrightness = value; break;
      case 'terrainMacroTint': RENDER_ENVIRONMENT.terrainMacroTint = value; break;
      case 'terrainTriplanarStrength': RENDER_ENVIRONMENT.terrainTriplanarStrength = value; break;
      case 'terrainNormalStrength': RENDER_ENVIRONMENT.terrainNormalStrength = value; break;
      case 'terrainShading': RENDER_ENVIRONMENT.terrainShading = value; break;
      case 'fogAmount': RENDER_ENVIRONMENT.fog.amount = value; break;
    }
    this.renderer.toneMappingExposure = RENDER_ENVIRONMENT.exposure;
    this.sun.intensity = RENDER_ENVIRONMENT.sun.intensity;
    this.hemisphere.intensity = RENDER_ENVIRONMENT.hemisphere.intensity;
    this.fog.near = effectiveFogNear();
    this.terrainMeshRef?.refreshRenderEnvironment();
    this.waterMeshRef?.refreshRenderEnvironment();
  }

  /** Full teardown and rebuild of terrain, obstacles and landmarks. Safe
   *  to call repeatedly — the game calls it on every welcome (reconnects
   *  included), the editor whenever a change alters the whole world. */
  setWorld(v: WorldVisuals): void {
    this.currentTerrain = v.terrain;
    if (this.terrainPlaceholder) {
      this.scene.remove(this.terrainPlaceholder);
      (this.terrainPlaceholder.material as THREE.Material).dispose();
      this.terrainPlaceholder.geometry.dispose();
      this.terrainPlaceholder = null;
    }
    if (this.terrainMeshRef) {
      this.scene.remove(this.terrainMeshRef.mesh);
      this.terrainMeshRef.dispose();
    }
    this.terrainMeshRef = new TerrainMesh(v.terrain, this.quality, this.stencilSupported);
    this.scene.add(this.terrainMeshRef.mesh);

    this.refreshWater(v.terrain);
    this.refreshObstacles(v.obstacles);
    this.refreshLandmarks(v.landmarks);
    this.refreshMarkers(v.markers ?? [], v.terrain);
  }

  /** Build, drop or rebuild the water surface for a terrain.
   *
   *  Separate from setWorld because the editor can turn a dry map wet (or
   *  wet map dry) with one brush stroke, and that is the only case that
   *  needs the mesh to appear or disappear — an ordinary stroke on an
   *  already-wet map goes through WaterMesh.updateWater instead. */
  refreshWater(terrain: Physics.TerrainData): void {
    const wanted = Physics.hasWater(terrain);
    if (this.waterMeshRef) {
      this.scene.remove(this.waterMeshRef.mesh);
      this.waterMeshRef.dispose();
      this.waterMeshRef = null;
    }
    if (!wanted) return;
    this.waterMeshRef = new WaterMesh(terrain, this.quality);
    this.scene.add(this.waterMeshRef.mesh);
  }

  /** Rebuild just the obstacle meshes — placing or deleting an object
   *  does not touch the heightfield. */
  refreshObstacles(list: readonly Physics.Obstacle[]): void {
    if (this.obstacles) {
      this.scene.remove(this.obstacles.group);
      disposeObject3D(this.obstacles.group);
    }
    this.obstacles = new Obstacles(list, this.quality);
    this.scene.add(this.obstacles.group);
    if (this.currentTerrain) this.refreshGroundCover(this.currentTerrain, list);
  }

  /** Re-run after terrain or authored-object rebuilds in the editor. */
  refreshGroundCover(terrain: Physics.TerrainData, obstacles: readonly Physics.Obstacle[]): void {
    if (this.groundCover) {
      this.scene.remove(this.groundCover.group);
      this.groundCover.dispose();
    }
    this.groundCover = new GroundCover(terrain, obstacles, this.quality);
    this.scene.add(this.groundCover.group);
  }

  refreshLandmarks(landmarks: Physics.Landmarks): void {
    if (this.landmarks) {
      this.scene.remove(this.landmarks.group);
      disposeObject3D(this.landmarks.group);
    }
    this.landmarks = new LandmarkMeshes(landmarks);
    this.scene.add(this.landmarks.group);
  }

  /** Rebuild the marker visuals. Its own entry point because the editor
   *  places and deletes markers without touching anything else in the
   *  world, and the bay paint is seated on sampled ground — so a sculpt
   *  under a bay has to be able to re-seat it. */
  refreshMarkers(markers: readonly Maps.Marker[], terrain: Physics.TerrainData): void {
    if (this.markers) {
      this.scene.remove(this.markers.group);
      this.markers.dispose();
    }
    this.markers = new MarkerMeshes(markers, terrain, this.markerOptions);
    this.scene.add(this.markers.group);
  }

  /** The obstacle group, for editor picking (meshes carry obstacleId in
   *  userData). Null before setWorld. */
  get obstacleGroup(): THREE.Group | null {
    return this.obstacles?.group ?? null;
  }

  /** The marker group. Not picked against — markers are selected by
   *  proximity to the ground hit, because bay paint is a decal you can
   *  park a rock on — but the e2e suite asserts against what it holds. */
  get markerGroup(): THREE.Group | null {
    return this.markers?.group ?? null;
  }

  /** Nearest-neighbour ground height. Used by the chase camera's floor
   *  clamp and the editor's fly-camera floor — both want "roughly where
   *  is the ground", not an interpolated value. */
  heightAt(x: number, z: number): number {
    if (!this.terrainMeshRef) return 0;
    const t = this.terrainMeshRef.terrain;
    const n = t.resolution;
    const u = (x / t.size + 0.5) * (n - 1);
    const v = (z / t.size + 0.5) * (n - 1);
    if (u < 0 || u > n - 1 || v < 0 || v > n - 1) return 0;
    const c = Math.round(u);
    const r = Math.round(v);
    return t.heights[r * n + c] ?? 0;
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  /** Keeps the sky dome centred on the camera, then draws. Both callers
   *  need the sky follow, so it belongs here rather than in each loop. */
  render(camera: THREE.Camera): void {
    this.sky.update(camera);
    // The one place per frame holding both the camera and the obstacle set.
    // A no-op unless the tier asks for culling.
    this.obstacles?.updateVisibility(camera.position.x, camera.position.z);
    this.waterMeshRef?.update();
    this.markers?.update();
    this.renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.currentTerrain = null;
    if (this.groundCover) {
      this.scene.remove(this.groundCover.group);
      this.groundCover.dispose();
      this.groundCover = null;
    }
    if (this.terrainMeshRef) {
      this.scene.remove(this.terrainMeshRef.mesh);
      this.terrainMeshRef.dispose();
      this.terrainMeshRef = null;
    }
    if (this.waterMeshRef) {
      this.scene.remove(this.waterMeshRef.mesh);
      this.waterMeshRef.dispose();
      this.waterMeshRef = null;
    }
    if (this.obstacles) {
      this.scene.remove(this.obstacles.group);
      disposeObject3D(this.obstacles.group);
      this.obstacles = null;
    }
    if (this.landmarks) {
      this.scene.remove(this.landmarks.group);
      disposeObject3D(this.landmarks.group);
      this.landmarks = null;
    }
    if (this.markers) {
      this.scene.remove(this.markers.group);
      this.markers.dispose();
      this.markers = null;
    }
    disposeObject3D(this.sky.mesh);
    this.scene.environment = null;
    this.disposeEnvironment();
    this.renderer.dispose();
  }
}
