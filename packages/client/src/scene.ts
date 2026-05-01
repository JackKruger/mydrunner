// Three.js scene + per-player vehicle visuals + interpolation buffer.
// Holds the last few server snapshots and renders them ~RENDER_DELAY_MS in
// the past so we always have two snapshots to interpolate between.

import * as THREE from 'three';
import {
  VEHICLE,
  Physics,
  DEFAULT_CAR_KIND,
  type CarKind,
  type WorldSnapshot,
  type PlayerId,
} from '@mydrunner/shared';
import { RENDER_DELAY_MS } from './net.js';
import { TerrainMesh } from './terrain.js';
import { buildCarMesh, colorHash } from './carMesh.js';
import { createNameplate, disposeNameplate } from './nameplate.js';
import { ParticleSystem } from './particles.js';
import { Obstacles } from './obstacles.js';
import { LandmarkMeshes } from './landmarks.js';
import { ChaseCamera } from './camera.js';
import { Sky } from './sky.js';

interface SnapshotEntry {
  recvAtMs: number;
  snap: WorldSnapshot;
}

interface VehicleVisual {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  nameplate: THREE.Sprite | null;
  nameplateText: string;
  carKind: CarKind;
  /** Last known wheel spin per wheel - used to derive spin rate. */
  lastSpin: number[];
  /** Tracking time of the previous snapshot used to compute spin rate. */
  lastSpinAtMs: number;
}

export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private cam: ChaseCamera;
  private buffer: SnapshotEntry[] = [];
  private vehicles = new Map<PlayerId, VehicleVisual>();
  private localId: PlayerId | null = null;
  private localCarKind: CarKind = DEFAULT_CAR_KIND;
  private terrain: TerrainMesh | null = null;
  private terrainPlaceholder: THREE.Mesh | null = null;
  private obstacles: Obstacles | null = null;
  private landmarks: LandmarkMeshes | null = null;
  private particles: ParticleSystem;
  private sky: Sky;
  private lastFrameTimeMs = 0;

  constructor(canvasParent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    canvasParent.appendChild(this.renderer.domElement);

    // Procedural sky dome replaces the flat background colour. Fog still
    // matches the horizon tint so distant terrain melts into the sky.
    this.scene.fog = new THREE.Fog(0xd6e2ec, 180, 480);
    this.sky = new Sky();
    this.scene.add(this.sky.mesh);

    this.cam = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.camera = this.cam.camera;

    const sun = new THREE.DirectionalLight(0xfff4dd, 1.4);
    sun.position.set(50, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -100;
    sun.shadow.camera.right = 100;
    sun.shadow.camera.top = 100;
    sun.shadow.camera.bottom = -100;
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

    this.particles = new ParticleSystem();
    this.scene.add(this.particles.group);

    window.addEventListener('resize', () => {
      this.cam.setAspect(window.innerWidth / window.innerHeight);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // Diagnostic accessors used by the screenshot e2e test - keep them
  // available so the test continues to read camera state without
  // reaching into private internals.
  get cameraYaw(): number { return this.cam.yaw; }
  get cameraTarget(): THREE.Vector3 { return this.cam.target; }
  get cameraMode(): 'chase' | 'hood' | 'free' { return this.cam.mode; }

  setLocalPlayer(id: PlayerId, carKind: CarKind = DEFAULT_CAR_KIND): void {
    this.localId = id;
    this.localCarKind = carKind;
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
    this.cam.setTerrain({ heightAt: (x, z) => this.terrainHeightAt(x, z) });
    if (this.obstacles) this.scene.remove(this.obstacles.group);
    this.obstacles = new Obstacles(seed, size, resolution);
    this.scene.add(this.obstacles.group);
    if (this.landmarks) this.scene.remove(this.landmarks.group);
    // Re-derive the landmark spec deterministically from the same seed
    // the server used; saves a wire round-trip for static structures.
    const t = Physics.generateTerrain({ seed, size, resolution });
    this.landmarks = new LandmarkMeshes(Physics.landmarksFor(t));
    this.scene.add(this.landmarks.group);
  }

  applyRuts(cells: { i: number; dy: number }[]): void {
    if (!this.terrain) return;
    for (const c of cells) this.terrain.applyRut(c.i, c.dy);
    this.terrain.flush();
  }

  cycleCameraMode(): void {
    this.cam.cycleMode();
  }

  /** Forward pointer-drag input to the chase camera. Drag accumulates
   *  yaw/pitch offsets; on release the camera springs back. */
  cameraDragBegin(): void { this.cam.beginDrag(); }
  cameraDrag(dyaw: number, dpitch: number): void { this.cam.drag(dyaw, dpitch); }
  cameraDragEnd(): void { this.cam.endDrag(); }

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

  private ensureVehicle(id: PlayerId, isLocal: boolean, kind: CarKind): VehicleVisual {
    let v = this.vehicles.get(id);
    if (v && v.carKind === kind) return v;
    if (v) {
      // Player swapped car kind mid-session - rebuild the mesh under the
      // same id so the visual matches snapshot state. Keep nameplate state.
      this.scene.remove(v.group);
      if (v.nameplate) {
        v.group.remove(v.nameplate);
        disposeNameplate(v.nameplate);
      }
      this.vehicles.delete(id);
    }
    const built = buildCarMesh(kind, isLocal, colorHash(id));
    this.scene.add(built.group);
    v = {
      group: built.group,
      wheels: built.wheels,
      nameplate: null,
      nameplateText: '',
      carKind: kind,
      lastSpin: [0, 0, 0, 0],
      lastSpinAtMs: 0,
    };
    this.vehicles.set(id, v);
    return v;
  }

  /** Add or update the nameplate above a vehicle. Local player gets none -
   *  no point labeling yourself. */
  private setNameplate(v: VehicleVisual, name: string, isLocal: boolean): void {
    if (isLocal) return;
    if (v.nameplateText === name) return;
    if (v.nameplate) {
      v.group.remove(v.nameplate);
      disposeNameplate(v.nameplate);
    }
    const sprite = createNameplate(name);
    // Sit above the roof rack.
    sprite.position.set(0, VEHICLE.chassisHalfExtents.y * 2 + 1.4, 0);
    v.group.add(sprite);
    v.nameplate = sprite;
    v.nameplateText = name;
  }

  private removeMissing(snapPlayers: Set<PlayerId>): void {
    for (const id of [...this.vehicles.keys()]) {
      if (!snapPlayers.has(id)) {
        const v = this.vehicles.get(id)!;
        if (v.nameplate) disposeNameplate(v.nameplate);
        this.scene.remove(v.group);
        this.vehicles.delete(id);
      }
    }
  }

  /** Override the local vehicle visual transform - used by client-side
   *  prediction so the local truck doesn't lag the snapshot buffer. */
  setLocalVehiclePose(pos: { x: number; y: number; z: number }, rot: { x: number; y: number; z: number; w: number }, wheels: { steer: number; spin: number; suspensionLength: number }[]): void {
    if (!this.localId) return;
    const v = this.ensureVehicle(this.localId, true, this.localCarKind);
    v.group.position.set(pos.x, pos.y, pos.z);
    v.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    for (let i = 0; i < 4; i++) {
      const wp = VEHICLE.wheelPositions[i]!;
      const w = v.wheels[i]!;
      const ws = wheels[i];
      const susp = ws ? ws.suspensionLength : VEHICLE.suspensionRestLength;
      const sink = this.wheelSinkAt(v.group, wp);
      // Wheel center = chassis-connection-point + suspensionDir * suspensionLength.
      // suspensionDir is (0,-1,0), so wheel center y = wp.y - susp.
      // (Earlier code had wp.y - (susp - rest) which assumed wp was the
      // wheel center at rest - that's not what Rapier expects, and
      // produced a ~restLength visual hover.)
      w.position.set(wp.x, wp.y - susp - sink, wp.z);
      // Negate steer for the mesh: snapshot.steer carries player-intent
      // sign (positive = right). With Three.js's right-hand Y-up frame,
      // positive rotation.y rotates +Z forward toward -X (left), so the
      // mesh needs the opposite sign to visually match driver intent.
      w.rotation.set(ws ? ws.spin : 0, ws ? -ws.steer : 0, 0);
    }
    // Hand the chase camera the latest chassis pose; it owns the yaw
    // spring + pitch lerp internally.
    this.cam.follow(v.group.position, rot);
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
        const vis = this.ensureVehicle(pa.id, isLocal, pa.carKind);
        this.setNameplate(vis, pa.name, isLocal);

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
            const sink = this.wheelSinkAt(vis.group, wp);
            // wp.y is the chassis-connection point (chassis bottom edge);
            // wheel hangs below at the current suspension extension. The
            // earlier `wp.y - (susp - rest)` form assumed wp was the wheel
            // center at rest, which Rapier doesn't.
            wheel.position.set(wp.x, wp.y - susp - sink, wp.z);
            const steer = wa ? wa.steer : 0;
            const spin = wa && wb ? wa.spin + (wb.spin - wa.spin) * t : 0;
            wheel.rotation.set(spin, -steer, 0);
          }
        }

        if (isLocal && !this.localOverridden) {
          // Fallback when client-side prediction is not active: snap the
          // camera target to the interpolated snapshot position.
          this.cam.snapTarget({
            x: pa.vehicle.position.x + (pb.vehicle.position.x - pa.vehicle.position.x) * t,
            y: pa.vehicle.position.y + (pb.vehicle.position.y - pa.vehicle.position.y) * t,
            z: pa.vehicle.position.z + (pb.vehicle.position.z - pa.vehicle.position.z) * t,
          });
        }
      }
    }

    // Camera follows local vehicle in the chosen mode.
    if (this.localId) {
      this.cam.apply();
    }

    this.removeMissing(present);

    // Mud splatter: for each visible vehicle, look at the latest snapshot
    // pair to estimate per-wheel spin rate. If a wheel is spinning faster
    // than the chassis is moving and the surface beneath it is muddy,
    // throw particles. Pure visual; no networking impact.
    const frameDt = this.lastFrameTimeMs > 0 ? nowMs - this.lastFrameTimeMs : 16;
    this.lastFrameTimeMs = nowMs;
    if (pair && this.terrain) {
      this.spawnMudParticles(pair.b.snap, pair.b.recvAtMs);
    }
    this.particles.update(frameDt);
    this.sky.update(this.camera);

    this.renderer.render(this.scene, this.camera);
  }

  private spawnMudParticles(snap: WorldSnapshot, recvAtMs: number): void {
    const terrainData = this.terrain!.terrain;
    for (const p of snap.players) {
      const vis = this.vehicles.get(p.id);
      if (!vis) continue;
      // Vehicle ground speed (horizontal magnitude).
      const groundSpeed = Math.hypot(p.vehicle.linVel.x, p.vehicle.linVel.z);
      const dtMs = recvAtMs - vis.lastSpinAtMs;
      if (vis.lastSpinAtMs === 0 || dtMs <= 0) {
        for (let i = 0; i < 4; i++) vis.lastSpin[i] = p.vehicle.wheels[i]?.spin ?? 0;
        vis.lastSpinAtMs = recvAtMs;
        continue;
      }
      for (let i = 0; i < 4; i++) {
        const wheelSnap = p.vehicle.wheels[i];
        if (!wheelSnap || !wheelSnap.contact) continue;
        const lastSpin = vis.lastSpin[i] ?? 0;
        const spinRate = (wheelSnap.spin - lastSpin) / (dtMs / 1000); // rad/s
        vis.lastSpin[i] = wheelSnap.spin;
        const wheelLin = Math.abs(spinRate) * VEHICLE.wheelRadius;
        if (wheelLin <= groundSpeed + 1.5) continue; // not really slipping
        // World-space wheel contact point: rotate the local wheel position
        // (lowered slightly so particles emit near the ground) by the
        // chassis quaternion, then add the chassis world position.
        const wp = VEHICLE.wheelPositions[i]!;
        const t = vis.group.position;
        const q = vis.group.quaternion;
        const local = { x: wp.x, y: wp.y - VEHICLE.wheelRadius * 0.6, z: wp.z };
        const v = Physics.rotateVecByQuat(local, { x: q.x, y: q.y, z: q.z, w: q.w });
        const wx = t.x + v.x;
        const wy = t.y + v.y;
        const wz = t.z + v.z;

        const surf = Physics.sampleSurface(terrainData, wx, wz);
        if (surf !== Physics.Surface.Mud && surf !== Physics.Surface.DeepMud) continue;
        const color = surf === Physics.Surface.DeepMud ? 0x1a0d05 : 0x3a2618;
        // Spawn intensity scales with how much faster the wheel is than the ground.
        const excess = wheelLin - groundSpeed;
        const count = Math.min(3, Math.max(1, Math.floor(excess / 4)));
        for (let n = 0; n < count; n++) this.particles.emit(wx, wy, wz, color);
      }
      vis.lastSpinAtMs = recvAtMs;
    }
  }

  private localOverridden = false;
  markLocalOverridden(): void { this.localOverridden = true; }

  /** Compute how far below its physics-resolved position a wheel visual
   *  should drop because the ground beneath it is soft (mud). Pure
   *  visual; the chassis still rides at its physics-determined height.
   *  Returns 0 on road / dirt. */
  private wheelSinkAt(group: THREE.Group, wp: { x: number; y: number; z: number }): number {
    if (!this.terrain) return 0;
    const q = group.quaternion;
    const v = Physics.rotateVecByQuat(wp, { x: q.x, y: q.y, z: q.z, w: q.w });
    const surf = Physics.sampleSurface(
      this.terrain.terrain,
      group.position.x + v.x,
      group.position.z + v.z,
    );
    if (surf === Physics.Surface.Mud) return VEHICLE.wheelRadius * 0.18;
    if (surf === Physics.Surface.DeepMud) return VEHICLE.wheelRadius * 0.35;
    return 0;
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
