// Three.js scene + per-player vehicle visuals + interpolation buffer.
// Holds the last few server snapshots and renders them ~RENDER_DELAY_MS in
// the past so we always have two snapshots to interpolate between.

import * as THREE from 'three';
import { VEHICLE, type WorldSnapshot, type PlayerId } from '@mydrunner/shared';
import { RENDER_DELAY_MS } from './net.js';
import { TerrainMesh } from './terrain.js';

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
  private cameraYaw = 0;
  private terrain: TerrainMesh | null = null;
  private terrainPlaceholder: THREE.Mesh | null = null;
  private cameraMode: 'chase' | 'hood' | 'free' = 'chase';

  constructor(canvasParent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    canvasParent.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xb8d0e2);
    this.scene.fog = new THREE.Fog(0xb8d0e2, 120, 320);

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      500,
    );
    this.camera.position.set(0, 6, 12);

    const sun = new THREE.DirectionalLight(0xfff4dd, 1.4);
    sun.position.set(50, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xb8d0e2, 0x66553c, 0.6));

    // Placeholder ground until terrain handshake arrives. Replaced in setTerrain().
    const placeholder = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x556b2f }),
    );
    placeholder.rotation.x = -Math.PI / 2;
    placeholder.receiveShadow = true;
    this.scene.add(placeholder);
    this.terrainPlaceholder = placeholder;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  setLocalPlayer(id: PlayerId): void {
    this.localId = id;
  }

  setTerrain(seed: number, size: number, resolution: number): void {
    if (this.terrainPlaceholder) {
      this.scene.remove(this.terrainPlaceholder);
      (this.terrainPlaceholder.material as THREE.Material).dispose();
      this.terrainPlaceholder.geometry.dispose();
      this.terrainPlaceholder = null;
    }
    if (this.terrain) {
      this.scene.remove(this.terrain.mesh);
      this.terrain.mesh.geometry.dispose();
      (this.terrain.mesh.material as THREE.Material).dispose();
    }
    this.terrain = new TerrainMesh(seed, size, resolution);
    this.scene.add(this.terrain.mesh);
  }

  applyRuts(cells: { i: number; dy: number }[]): void {
    if (!this.terrain) return;
    for (const c of cells) this.terrain.applyRut(c.i, c.dy);
    this.terrain.flush();
  }

  cycleCameraMode(): void {
    this.cameraMode = this.cameraMode === 'chase' ? 'hood' : this.cameraMode === 'hood' ? 'free' : 'chase';
  }

  pushSnapshot(snap: WorldSnapshot, recvAtMs: number): void {
    this.buffer.push({ snap, recvAtMs });
    const cutoff = recvAtMs - 1000;
    while (this.buffer.length > 2 && this.buffer[0]!.recvAtMs < cutoff) {
      this.buffer.shift();
    }
  }

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

  /** Override the local vehicle visual transform - used by client-side
   *  prediction so the local truck doesn't lag the snapshot buffer. */
  setLocalVehiclePose(pos: { x: number; y: number; z: number }, rot: { x: number; y: number; z: number; w: number }, wheels: { steer: number; spin: number; suspensionLength: number }[]): void {
    if (!this.localId) return;
    const v = this.ensureVehicle(this.localId, true);
    v.group.position.set(pos.x, pos.y, pos.z);
    v.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    for (let i = 0; i < 4; i++) {
      const wp = VEHICLE.wheelPositions[i]!;
      const w = v.wheels[i]!;
      const ws = wheels[i];
      const susp = ws ? ws.suspensionLength : VEHICLE.suspensionRestLength;
      w.position.set(wp.x, wp.y - (susp - VEHICLE.suspensionRestLength), wp.z);
      w.rotation.set(ws ? ws.spin : 0, ws ? ws.steer : 0, 0);
    }
    this.cameraTarget.copy(v.group.position);
    // Track yaw for camera follow.
    const e = new THREE.Euler().setFromQuaternion(v.group.quaternion, 'YXZ');
    this.cameraYaw = e.y;
  }

  render(nowMs: number): void {
    const renderAtMs = nowMs - RENDER_DELAY_MS;
    const pair = this.pickPair(renderAtMs);
    const present: Set<PlayerId> = new Set();

    if (pair) {
      const { a, b, t } = pair;
      const bMap = new Map(b.snap.players.map((p) => [p.id, p]));
      for (const pa of a.snap.players) {
        const pb = bMap.get(pa.id) ?? pa;
        present.add(pa.id);
        const isLocal = pa.id === this.localId;
        const vis = this.ensureVehicle(pa.id, isLocal);

        // Local vehicle is overridden by setLocalVehiclePose() once prediction
        // is active; only update remotes here.
        if (!isLocal) {
          vis.group.position.set(
            pa.vehicle.position.x + (pb.vehicle.position.x - pa.vehicle.position.x) * t,
            pa.vehicle.position.y + (pb.vehicle.position.y - pa.vehicle.position.y) * t,
            pa.vehicle.position.z + (pb.vehicle.position.z - pa.vehicle.position.z) * t,
          );
          const qa = new THREE.Quaternion(pa.vehicle.rotation.x, pa.vehicle.rotation.y, pa.vehicle.rotation.z, pa.vehicle.rotation.w);
          const qb = new THREE.Quaternion(pb.vehicle.rotation.x, pb.vehicle.rotation.y, pb.vehicle.rotation.z, pb.vehicle.rotation.w);
          qa.slerp(qb, t);
          vis.group.quaternion.copy(qa);

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
        }

        if (isLocal && !this.localOverridden) {
          // Fall back to snapshot interp for the camera target if prediction
          // is not active.
          this.cameraTarget.set(
            pa.vehicle.position.x + (pb.vehicle.position.x - pa.vehicle.position.x) * t,
            pa.vehicle.position.y + (pb.vehicle.position.y - pa.vehicle.position.y) * t,
            pa.vehicle.position.z + (pb.vehicle.position.z - pa.vehicle.position.z) * t,
          );
        }
      }
    }

    // Camera follows local vehicle in the chosen mode.
    if (this.localId) {
      this.updateCamera();
    }

    this.removeMissing(present);
    this.renderer.render(this.scene, this.camera);
  }

  private localOverridden = false;
  markLocalOverridden(): void { this.localOverridden = true; }

  private updateCamera(): void {
    const target = this.cameraTarget;
    if (this.cameraMode === 'chase') {
      const offset = new THREE.Vector3(
        -Math.sin(this.cameraYaw) * 9,
        5,
        -Math.cos(this.cameraYaw) * 9,
      );
      const desired = target.clone().add(offset);
      // Make sure the camera doesn't dip below terrain when going down a hill.
      const minY = (this.terrain ? this.terrainHeightAt(desired.x, desired.z) : 0) + 1.0;
      if (desired.y < minY) desired.y = minY;
      this.camera.position.lerp(desired, 0.15);
      const lookTarget = target.clone();
      lookTarget.y += 0.5;
      this.camera.lookAt(lookTarget);
    } else if (this.cameraMode === 'hood') {
      // Sit just above the chassis roof, looking forward in the car's heading.
      const fwd = new THREE.Vector3(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw));
      this.camera.position.copy(target).add(new THREE.Vector3(fwd.x * 0.2, 1.4, fwd.z * 0.2));
      const lookAt = target.clone().add(new THREE.Vector3(fwd.x * 10, 1.0, fwd.z * 10));
      this.camera.lookAt(lookAt);
    } else {
      // free: stationary high overview
      this.camera.position.set(0, 60, 60);
      this.camera.lookAt(0, 0, 0);
    }
  }

  /** Sample terrain height at world (x, z). Used by the camera so it
   *  doesn't bury under hills. */
  private terrainHeightAt(x: number, z: number): number {
    if (!this.terrain) return 0;
    const t = this.terrain.terrain;
    const n = t.resolution;
    const u = (x / t.size + 0.5) * (n - 1);
    const v = (z / t.size + 0.5) * (n - 1);
    if (u < 0 || u > n - 1 || v < 0 || v > n - 1) return 0;
    const c = Math.round(u);
    const r = Math.round(v);
    return t.heights[r * n + c] ?? 0;
  }
}
