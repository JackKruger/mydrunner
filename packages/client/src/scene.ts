// Three.js scene + per-player vehicle visuals + interpolation buffer.
// Holds the last few server snapshots and renders them ~RENDER_DELAY_MS in
// the past so we always have two snapshots to interpolate between.

import * as THREE from 'three';
import {
  VEHICLE,
  CAMERA,
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
  private buffer: SnapshotEntry[] = [];
  private vehicles = new Map<PlayerId, VehicleVisual>();
  private localId: PlayerId | null = null;
  private localCarKind: CarKind = DEFAULT_CAR_KIND;
  private cameraTarget = new THREE.Vector3();
  private cameraYaw = 0;
  /** Spring-damper velocity of cameraYaw - drives both the catch-up motion
   *  and the lateral "swing" offset in chase mode. */
  private cameraYawVel = 0;
  private lastCamUpdateMs = 0;
  /** Smoothed chassis pitch (rad). Positive = nose up. Drives the chase
   *  camera's lookAt height so the view angles up driving uphill / down
   *  driving downhill. Lerped (not spring) - we want it to lag the car
   *  smoothly, not overshoot. */
  private cameraPitch = 0;
  private terrain: TerrainMesh | null = null;
  private terrainPlaceholder: THREE.Mesh | null = null;
  private obstacles: Obstacles | null = null;
  private cameraMode: 'chase' | 'hood' | 'free' = 'chase';
  private particles: ParticleSystem;
  private lastFrameTimeMs = 0;

  constructor(canvasParent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    canvasParent.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xb8d0e2);
    this.scene.fog = new THREE.Fog(0xb8d0e2, 180, 480);

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
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

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
    if (this.obstacles) this.scene.remove(this.obstacles.group);
    this.obstacles = new Obstacles(seed, size, resolution);
    this.scene.add(this.obstacles.group);
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
    // Position target tracks the car directly with a light lerp - kills
    // chassis-wobble high-frequency jitter without lag. Yaw uses an
    // under-damped spring so the camera swings through corners instead
    // of locking rigidly to heading; the resulting cameraYawVel feeds
    // a lateral offset in updateCamera() that pushes outside the turn.
    this.cameraTarget.lerp(v.group.position, 0.4);
    // Forward vector (local +Z) rotated by quaternion gives the chassis
    // facing direction in world space. Yaw is atan2(fX, fZ); pitch is
    // asin(fY) (positive = nose up). Pitch is lerped, not sprung -
    // overshoot would be queasy here, unlike the corner swing.
    const fX = 2 * (rot.x * rot.z + rot.w * rot.y);
    const fY = 2 * (rot.y * rot.z - rot.w * rot.x);
    const fZ = 1 - 2 * (rot.x * rot.x + rot.y * rot.y);
    const targetPitch = Math.asin(Math.max(-1, Math.min(1, fY)));
    this.cameraPitch += (targetPitch - this.cameraPitch) * 0.18;
    const targetYaw = Math.atan2(fX, fZ);
    let dy = targetYaw - this.cameraYaw;
    if (dy > Math.PI) dy -= 2 * Math.PI;
    if (dy < -Math.PI) dy += 2 * Math.PI;

    const nowMs = performance.now();
    const dt = this.lastCamUpdateMs ? Math.min(0.05, (nowMs - this.lastCamUpdateMs) / 1000) : 1 / 60;
    this.lastCamUpdateMs = nowMs;
    const accel = CAMERA.chaseYawStiffness * dy - CAMERA.chaseYawDamping * this.cameraYawVel;
    this.cameraYawVel += accel * dt;
    this.cameraYaw += this.cameraYawVel * dt;
    if (this.cameraYaw > Math.PI) this.cameraYaw -= 2 * Math.PI;
    if (this.cameraYaw < -Math.PI) this.cameraYaw += 2 * Math.PI;
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

  private updateCamera(): void {
    const target = this.cameraTarget;
    if (this.cameraMode === 'chase') {
      const offset = new THREE.Vector3(
        -Math.sin(this.cameraYaw) * 8,
        3,
        -Math.cos(this.cameraYaw) * 8,
      );
      const desired = target.clone().add(offset);
      // Lateral swing: when the camera yaw is sweeping (cornering), push
      // sideways opposite the sweep direction so the camera ends up on
      // the outside of the turn. Negative sign because positive yaw rate
      // = turning right, and we want to push to the world-left.
      const swingMag = Math.max(
        -CAMERA.chaseSwingMax,
        Math.min(CAMERA.chaseSwingMax, -this.cameraYawVel * CAMERA.chaseSwingLateral),
      );
      desired.x += Math.cos(this.cameraYaw) * swingMag;
      desired.z += -Math.sin(this.cameraYaw) * swingMag;
      const minY = (this.terrain ? this.terrainHeightAt(desired.x, desired.z) : 0) + 1.5;
      if (desired.y < minY) desired.y = minY;
      this.camera.position.copy(desired);
      // Project the lookAt point ahead of the car along its (yawed) heading,
      // and lift/drop its height by tan(pitch) * lookAhead so the view
      // angles up driving uphill and down driving downhill. Pitch is
      // clamped because tan blows up near vertical.
      const lookAhead = 7;
      const clampedPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, this.cameraPitch));
      const fwdX = Math.sin(this.cameraYaw);
      const fwdZ = Math.cos(this.cameraYaw);
      const lookTarget = new THREE.Vector3(
        target.x + fwdX * lookAhead,
        target.y + 0.5 + lookAhead * Math.tan(clampedPitch),
        target.z + fwdZ * lookAhead,
      );
      this.camera.lookAt(lookTarget);
    } else if (this.cameraMode === 'hood') {
      // Sit just above the chassis roof, looking forward in the car's heading.
      const fwd = new THREE.Vector3(Math.sin(this.cameraYaw), 0, Math.cos(this.cameraYaw));
      this.camera.position.copy(target).add(new THREE.Vector3(fwd.x * 0.2, 1.4, fwd.z * 0.2));
      const lookAt = target.clone().add(new THREE.Vector3(fwd.x * 10, 1.0, fwd.z * 10));
      this.camera.lookAt(lookAt);
    } else {
      // free: high "sky cam" trailing the local player. Sits well above
      // and behind so the camera stays steady while the car drives -
      // useful for spotting routes and seeing the car relative to the
      // landscape.
      const fwdX = Math.sin(this.cameraYaw);
      const fwdZ = Math.cos(this.cameraYaw);
      this.camera.position.set(
        target.x - fwdX * 30,
        target.y + 40,
        target.z - fwdZ * 30,
      );
      this.camera.lookAt(target);
    }
  }

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
