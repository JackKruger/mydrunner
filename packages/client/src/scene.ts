// Three.js scene + per-player vehicle visuals + interpolation buffer.
// Holds the last few server snapshots and renders them ~RENDER_DELAY_MS in
// the past so we always have two snapshots to interpolate between.

import * as THREE from 'three';
import { VEHICLE, type WorldSnapshot, type PlayerId } from '@mydrunner/shared';
import { RENDER_DELAY_MS } from './net.js';

interface SnapshotEntry {
  recvAtMs: number;
  snap: WorldSnapshot;
}

interface VehicleVisual {
  group: THREE.Group;
  wheels: THREE.Mesh[];
}

export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private buffer: SnapshotEntry[] = [];
  private vehicles = new Map<PlayerId, VehicleVisual>();
  private localId: PlayerId | null = null;
  private cameraTarget = new THREE.Vector3();

  constructor(canvasParent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    canvasParent.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x87a8c0);
    this.scene.fog = new THREE.Fog(0x87a8c0, 80, 250);

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      500,
    );
    this.camera.position.set(0, 6, 12);

    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(50, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    // Placeholder ground plane until the heightmap is replicated to the client.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x556b2f }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Grid for visual reference.
    const grid = new THREE.GridHelper(200, 40, 0x222222, 0x333333);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    this.scene.add(grid);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  setLocalPlayer(id: PlayerId): void {
    this.localId = id;
  }

  pushSnapshot(snap: WorldSnapshot, recvAtMs: number): void {
    this.buffer.push({ snap, recvAtMs });
    // Keep buffer to ~1s.
    const cutoff = recvAtMs - 1000;
    while (this.buffer.length > 2 && this.buffer[0]!.recvAtMs < cutoff) {
      this.buffer.shift();
    }
  }

  /** Find two snapshots straddling renderTime (in client clock ms). */
  private pickPair(renderAtMs: number): { a: SnapshotEntry; b: SnapshotEntry; t: number } | null {
    if (this.buffer.length < 2) return null;
    for (let i = this.buffer.length - 1; i >= 1; i--) {
      const b = this.buffer[i]!;
      const a = this.buffer[i - 1]!;
      if (a.recvAtMs <= renderAtMs && renderAtMs <= b.recvAtMs) {
        const t = (renderAtMs - a.recvAtMs) / Math.max(1e-6, b.recvAtMs - a.recvAtMs);
        return { a, b, t };
      }
    }
    // Past or future: clamp.
    if (renderAtMs < this.buffer[0]!.recvAtMs) return null;
    return null;
  }

  private ensureVehicle(id: PlayerId, isLocal: boolean): VehicleVisual {
    let v = this.vehicles.get(id);
    if (v) return v;
    const group = new THREE.Group();
    const ext = VEHICLE.chassisHalfExtents;
    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(ext.x * 2, ext.y * 2, ext.z * 2),
      new THREE.MeshStandardMaterial({ color: isLocal ? 0xd9531e : 0x3a78c2 }),
    );
    chassis.castShadow = true;
    group.add(chassis);

    const wheels: THREE.Mesh[] = [];
    const wheelGeo = new THREE.CylinderGeometry(VEHICLE.wheelRadius, VEHICLE.wheelRadius, VEHICLE.wheelWidth, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.castShadow = true;
      group.add(w);
      wheels.push(w);
    }
    this.scene.add(group);
    v = { group, wheels };
    this.vehicles.set(id, v);
    return v;
  }

  private removeMissing(snapPlayers: Set<PlayerId>): void {
    for (const id of [...this.vehicles.keys()]) {
      if (!snapPlayers.has(id)) {
        const v = this.vehicles.get(id)!;
        this.scene.remove(v.group);
        this.vehicles.delete(id);
      }
    }
  }

  render(nowMs: number): void {
    const renderAtMs = nowMs - RENDER_DELAY_MS;
    const pair = this.pickPair(renderAtMs);
    const present: Set<PlayerId> = new Set();

    if (pair) {
      const { a, b, t } = pair;
      // Index b players by id for matched interpolation.
      const bMap = new Map(b.snap.players.map((p) => [p.id, p]));
      for (const pa of a.snap.players) {
        const pb = bMap.get(pa.id) ?? pa;
        present.add(pa.id);
        const vis = this.ensureVehicle(pa.id, pa.id === this.localId);

        vis.group.position.set(
          pa.vehicle.position.x + (pb.vehicle.position.x - pa.vehicle.position.x) * t,
          pa.vehicle.position.y + (pb.vehicle.position.y - pa.vehicle.position.y) * t,
          pa.vehicle.position.z + (pb.vehicle.position.z - pa.vehicle.position.z) * t,
        );
        // Slerp rotation.
        const qa = new THREE.Quaternion(pa.vehicle.rotation.x, pa.vehicle.rotation.y, pa.vehicle.rotation.z, pa.vehicle.rotation.w);
        const qb = new THREE.Quaternion(pb.vehicle.rotation.x, pb.vehicle.rotation.y, pb.vehicle.rotation.z, pb.vehicle.rotation.w);
        qa.slerp(qb, t);
        vis.group.quaternion.copy(qa);

        // Position wheels. Local space relative to chassis.
        for (let i = 0; i < 4; i++) {
          const wp = VEHICLE.wheelPositions[i]!;
          const wheel = vis.wheels[i]!;
          const wa = pa.vehicle.wheels[i];
          const wb = pb.vehicle.wheels[i];
          const susp = wa && wb
            ? wa.suspensionLength + (wb.suspensionLength - wa.suspensionLength) * t
            : VEHICLE.suspensionRestLength;
          wheel.position.set(wp.x, wp.y - (susp - VEHICLE.suspensionRestLength), wp.z);
          const steer = wa ? wa.steer : 0;
          const spin = wa && wb ? wa.spin + (wb.spin - wa.spin) * t : 0;
          wheel.rotation.set(spin, steer, 0);
        }

        if (pa.id === this.localId) {
          this.cameraTarget.copy(vis.group.position);
        }
      }
    }

    // Camera follows local vehicle.
    if (this.localId) {
      const desired = this.cameraTarget
        .clone()
        .add(new THREE.Vector3(0, 5, 10));
      this.camera.position.lerp(desired, 0.1);
      this.camera.lookAt(this.cameraTarget);
    }

    this.removeMissing(present);
    this.renderer.render(this.scene, this.camera);
  }
}
