import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { disposeObject3D } from '../three/dispose.js';
import type { AssetDocument, AssetTransform } from './document.js';
import { makePartMesh } from './mesh.js';

export type TransformMode = 'translate' | 'rotate' | 'scale';

export interface ViewportCallbacks {
  select(id: string | null): void;
  transformStart(): void;
  transformChange(id: string, transform: AssetTransform): void;
  transformEnd(): void;
}

export class AssetViewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.02, 2000);
  private readonly orbit: OrbitControls;
  private readonly transform: TransformControls;
  private readonly assetRoot = new THREE.Group();
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private selectedId: string | null = null;
  private resizeObserver: ResizeObserver;
  private animationFrame = 0;
  private pointerDown = { x: 0, y: 0 };

  constructor(private readonly host: HTMLElement, private readonly callbacks: ViewportCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.host.append(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x1a1d1b);
    this.scene.fog = new THREE.Fog(0x1a1d1b, 35, 90);
    this.camera.position.set(6, 4.2, 7);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 0.8, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.075;

    this.scene.add(this.assetRoot);
    const hemi = new THREE.HemisphereLight(0xdde8df, 0x22251f, 1.8);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d2, 3.2);
    sun.position.set(8, 13, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    this.scene.add(sun);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x20241f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = '__ground';
    this.scene.add(ground);
    const grid = new THREE.GridHelper(40, 80, 0x5d6a5c, 0x343b34);
    grid.material.transparent = true;
    grid.material.opacity = 0.58;
    grid.position.y = 0.002;
    this.scene.add(grid);

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.82);
    this.transform.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean(event.value);
      this.orbit.enabled = !dragging;
      if (dragging) this.callbacks.transformStart();
      else this.callbacks.transformEnd();
    });
    this.transform.addEventListener('objectChange', () => {
      const object = this.transform.object;
      const id = object?.userData.assetPartId as string | undefined;
      if (!object || !id) return;
      this.callbacks.transformChange(id, {
        position: object.position.toArray(),
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
        scale: object.scale.toArray(),
      });
    });
    this.scene.add(this.transform.getHelper());

    this.renderer.domElement.addEventListener('pointerdown', (event) => {
      this.pointerDown = { x: event.clientX, y: event.clientY };
    });
    this.renderer.domElement.addEventListener('pointerup', (event) => {
      if (Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y) > 4) return;
      this.pick(event);
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.resize();
    this.animate();
  }

  setDocument(doc: AssetDocument): void {
    this.transform.detach();
    disposeObject3D(this.assetRoot);
    this.assetRoot.clear();
    this.meshes.clear();
    for (const part of doc.parts) {
      const mesh = makePartMesh(part);
      this.assetRoot.add(mesh);
      this.meshes.set(part.id, mesh);
    }
    this.setSelected(this.selectedId && this.meshes.has(this.selectedId) ? this.selectedId : null);
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.transform.detach();
    if (id) {
      const mesh = this.meshes.get(id);
      if (mesh) this.transform.attach(mesh);
    }
  }

  setMode(mode: TransformMode): void {
    this.transform.setMode(mode);
  }

  setSpace(space: 'local' | 'world'): void {
    this.transform.setSpace(space);
  }

  setSnap(enabled: boolean): void {
    this.transform.setTranslationSnap(enabled ? 0.1 : null);
    this.transform.setRotationSnap(enabled ? THREE.MathUtils.degToRad(15) : null);
    this.transform.setScaleSnap(enabled ? 0.1 : null);
  }

  frameAll(): void {
    const bounds = new THREE.Box3().setFromObject(this.assetRoot);
    if (bounds.isEmpty()) {
      this.camera.position.set(6, 4.2, 7);
      this.orbit.target.set(0, 0.8, 0);
      this.orbit.update();
      return;
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.62, 1.5);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(1, 0.72, 1).normalize().multiplyScalar(radius * 2.25));
    this.camera.near = Math.max(radius / 1000, 0.01);
    this.camera.far = Math.max(radius * 40, 100);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  private pick(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.meshes.values()], false)[0];
    this.callbacks.select((hit?.object.userData.assetPartId as string | undefined) ?? null);
  }

  private resize(): void {
    const width = Math.max(this.host.clientWidth, 1);
    const height = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.animationFrame = requestAnimationFrame(this.animate);
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.orbit.dispose();
    this.transform.dispose();
    disposeObject3D(this.assetRoot);
    this.renderer.dispose();
  }
}
