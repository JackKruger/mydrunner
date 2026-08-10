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
import { Physics } from '@mydrunner/shared';
import { TerrainMesh } from './terrain.js';
import { WaterMesh } from './water.js';
import { Obstacles } from './obstacles/index.js';
import { LandmarkMeshes } from './landmarks.js';
import { Sky } from './sky.js';
import { disposeObject3D } from './three/dispose.js';
import { activeQuality, type QualitySettings } from './quality.js';

/** Sun direction, fog colour and fog range are duplicated in
 *  terrainShader.ts's uniforms. Retune one, retune the other. */
const FOG_COLOR = 0xd6e2ec;
const FOG_NEAR = 180;
const FOG_FAR = 480;
const SUN_POS = { x: 50, y: 80, z: 30 };

/** What the world is made of. The game composes this from the terrain
 *  handshake; the editor composes it from the map being edited. */
export interface WorldVisuals {
  terrain: Physics.TerrainData;
  obstacles: readonly Physics.Obstacle[];
  landmarks: Physics.Landmarks;
}

export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();

  private sky: Sky;
  private terrainMeshRef: TerrainMesh | null = null;
  private waterMeshRef: WaterMesh | null = null;
  private terrainPlaceholder: THREE.Mesh | null = null;
  private obstacles: Obstacles | null = null;
  private landmarks: LandmarkMeshes | null = null;
  private readonly quality: QualitySettings;

  /** `quality` defaults to the resolved tier so the game gets it for free.
   *  The editor passes QUALITY.high explicitly — it exists to show the world
   *  as the game ships it, so it must not render a reduced version of it. */
  constructor(canvasParent: HTMLElement, quality: QualitySettings = activeQuality()) {
    this.quality = quality;
    // MSAA off at low tier. On a tile-based mobile GPU the resolve is a
    // bandwidth cost on every frame, and at pixelRatioCap 1.0 the crispness
    // it was buying has already been given up.
    this.renderer = new THREE.WebGLRenderer({ antialias: quality.antialias });
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
    // PCFSoft is the default and is several samples per fragment on the
    // shadow-casting pass. PCF (basic) halves that with barely visible
    // quality loss at our shadow map resolution.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    canvasParent.appendChild(this.renderer.domElement);

    // Procedural sky dome replaces the flat background colour. Fog still
    // matches the horizon tint so distant terrain melts into the sky.
    this.scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);
    this.sky = new Sky(quality);
    this.scene.add(this.sky.mesh);

    const sun = new THREE.DirectionalLight(0xfff4dd, 1.4);
    sun.position.set(SUN_POS.x, SUN_POS.y, SUN_POS.z);
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
    this.scene.add(new THREE.HemisphereLight(0xb8d0e2, 0x66553c, 0.6));

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

  /** Full teardown and rebuild of terrain, obstacles and landmarks. Safe
   *  to call repeatedly — the game calls it on every welcome (reconnects
   *  included), the editor whenever a change alters the whole world. */
  setWorld(v: WorldVisuals): void {
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
    this.terrainMeshRef = new TerrainMesh(v.terrain, this.quality);
    this.scene.add(this.terrainMeshRef.mesh);

    this.refreshWater(v.terrain);
    this.refreshObstacles(v.obstacles);
    this.refreshLandmarks(v.landmarks);
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
  }

  refreshLandmarks(landmarks: Physics.Landmarks): void {
    if (this.landmarks) {
      this.scene.remove(this.landmarks.group);
      disposeObject3D(this.landmarks.group);
    }
    this.landmarks = new LandmarkMeshes(landmarks);
    this.scene.add(this.landmarks.group);
  }

  /** The obstacle group, for editor picking (meshes carry obstacleId in
   *  userData). Null before setWorld. */
  get obstacleGroup(): THREE.Group | null {
    return this.obstacles?.group ?? null;
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
    this.renderer.render(this.scene, camera);
  }

  dispose(): void {
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
    disposeObject3D(this.sky.mesh);
    this.renderer.dispose();
  }
}
