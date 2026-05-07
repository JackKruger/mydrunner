// Three.js scene + per-player vehicle visuals + interpolation buffer.
// Holds the last few server snapshots and renders them ~RENDER_DELAY_MS in
// the past so we always have two snapshots to interpolate between.

import * as THREE from 'three';
import {
  VEHICLE,
  Physics,
  DEFAULT_CAR_KIND,
  type CarKind,
  type PlayerSnapshot,
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
  /** Solid-axle group meshes [front, rear]. Posed each frame from the
   *  vehicle's axle DOFs (rideY + rollAngle). Wheels are children of
   *  these groups, so moving the axle moves both wheels as one rigid
   *  beam - the visual signature of solid-axle articulation. */
  axles: [THREE.Group, THREE.Group];
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
  // Pre-allocated render-loop scratch buffers — avoids per-frame GC pressure.
  private _bMap = new Map<PlayerId, PlayerSnapshot>();
  private _qa = new THREE.Quaternion();
  private _qb = new THREE.Quaternion();
  private _axleBuf: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }] = [
    { rideY: 0, rollAngle: 0 },
    { rideY: 0, rollAngle: 0 },
  ];
  // Last interpolated state for the local player. Kept around for the
  // surface-name HUD lookup, the debug-panel axle readout, and e2e
  // assertions - all of which used to read from prediction.state().
  private _localPos = { x: 0, y: 0, z: 0 };
  private _localSteer = 0;
  private _localAxlesLast: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }] = [
    { rideY: 0, rollAngle: 0 },
    { rideY: 0, rollAngle: 0 },
  ];
  private _localHasState = false;
  // Visual override for the local truck's front-wheel steer angle. The
  // server smooths input.steer toward maxSteer at TUNING.steerSpeed
  // (~327 ms full-lock); rendering only off the snapshot stream meant
  // the wheel mesh sat still for ~100-400 ms after a key press,
  // which read as "is my input being registered?". Driven directly
  // from input each render frame, the wheel snaps with the player and
  // the chassis follow-through (server steer ramp + tire bite) reads
  // as normal driving inertia rather than network lag.
  private _localInputSteer = 0;
  private _present = new Set<PlayerId>();

  constructor(canvasParent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Cap pixel ratio. Uncapped on a 2x or 3x display the GPU pays 4-9x
    // the fragment cost - the difference between 60 FPS and 20 FPS on
    // mid-tier mobile + integrated GPUs. 1.5 is a good compromise: still
    // crisper than CSS pixels, well under the cliff. Higher-end devices
    // can override at runtime if needed.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    // PCFSoft is the default and is several samples per fragment on the
    // shadow-casting pass. PCF (basic) halves that with barely visible
    // quality loss at our shadow map resolution.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    // 1024² instead of 2048². Shadows still readable on a 200 m × 200 m
    // shadow camera frustum (~20 cm per shadow texel) and the GPU pays
    // a quarter of the depth-pass fragment cost. The map-size drop is
    // pure win on integrated and mobile GPUs.
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
    // renderAtMs is past the newest snapshot (e.g. tab was backgrounded and
    // the clock ran ahead). Clamp to the last pair at t=1 so vehicles stay at
    // their last known positions rather than disappearing.
    const last = this.buffer[this.buffer.length - 1]!;
    const secondLast = this.buffer[this.buffer.length - 2]!;
    return { a: secondLast, b: last, t: 1 };
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
      axles: built.axles,
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

  /** Read-only accessors used by the HUD (surface-under-truck lookup),
   *  the debug panel (axle DOF readout), and e2e tests. All sourced from
   *  the most recent snapshot interpolation, so they are exactly the
   *  visual-frame state. */
  localPosition(): { x: number; y: number; z: number } | null {
    return this._localHasState ? this._localPos : null;
  }
  localSteer(): number {
    return this._localSteer;
  }
  localAxles(): [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }] | null {
    return this._localHasState ? this._localAxlesLast : null;
  }
  /** Read the LATEST raw snapshot's server-side state for the local
   *  player. Unlike localPosition()/localSteer() (which return
   *  interp/extrapolation outputs) this exposes the unfiltered wire
   *  values - used by the latency test to time when server-side state
   *  transitions (currentSteer, angVel.y) actually arrive on the client. */
  localServerState(): { steer: number; angVelY: number; yaw: number; recvAtMs: number } | null {
    if (!this.localId || this.buffer.length === 0) return null;
    const latest = this.buffer[this.buffer.length - 1]!;
    const me = latest.snap.players.find((p) => p.id === this.localId);
    if (!me) return null;
    const q = me.vehicle.rotation;
    const yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    return {
      steer: me.vehicle.wheels[0]?.steer ?? 0,
      angVelY: me.vehicle.angVel.y,
      yaw,
      recvAtMs: latest.recvAtMs,
    };
  }
  /** Push the latest sampled input steer (range -1..1) so the local
   *  truck's front wheels can snap to the player's intent visually
   *  even though the chassis pose still comes from snapshots. */
  setLocalInputSteer(steer: number): void {
    this._localInputSteer = Math.max(-1, Math.min(1, steer)) * VEHICLE.maxSteer;
  }

  /** Pose the two axle groups from per-axle (rideY, rollAngle) state.
   *
   *  The physics spring extends world-down (the raycasts use dir={0,-1,0}).
   *  To match that in the visual, the spring extension must be applied in
   *  world-Y, then converted back into the chassis-local frame. The chassis
   *  local-Y axis has world-Y component = up.y = cos(pitch). Dividing the
   *  world-down extension by up.y gives the chassis-local offset that
   *  produces exactly that world-Y displacement. Without this correction
   *  the axle extends along chassis-Y, which on any slope is shorter than
   *  world-down by a cos(θ) factor, causing wheels to visually float above
   *  the terrain.
   *
   *  The same division applies to the mud sink so it stays a world-vertical
   *  effect regardless of chassis roll/pitch. */
  private poseAxles(
    v: VehicleVisual,
    axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }],
  ): void {
    const geom = Physics.geomFor(v.carKind);
    const q = v.group.quaternion;
    // World-Y component of the chassis's local-Y (up) axis.
    const chassisUp = Physics.rotateVecByQuat(
      { x: 0, y: 1, z: 0 },
      { x: q.x, y: q.y, z: q.z, w: q.w },
    );
    // Clamp upY: the cos correction is meaningful for a chassis on a
    // slope (mild tilt), but blows up the visual spring length when the
    // chassis is heavily tilted or inverted. At upY=0.15 the spring
    // visually extended ~3.7 m below the attachment, making the wheels
    // appear detached from the body during a flip. Clamping at 0.7
    // preserves the slope correction up to ~45° tilt and bounds the
    // visual extension to ~0.8 m past that.
    const upY = Math.max(0.7, chassisUp.y);
    for (let i = 0; i < 2; i++) {
      const ag = i === 0 ? geom.front : geom.rear;
      const ax = axles[i]!;
      const sink = this.axleSinkAt(v.group, { centerLocalY: ag.centerLocalY, centerLocalZ: ag.centerLocalZ });
      const springExt = ag.suspensionRestLength - ax.rideY;
      v.axles[i]!.position.set(
        0,
        ag.centerLocalY - (springExt + sink) / upY,
        ag.centerLocalZ,
      );
      // Roll about chassis-forward (local +Z). YXZ ordering keeps the
      // small-angle visual stable - rollAngle is the dominant DOF.
      v.axles[i]!.rotation.set(0, 0, ax.rollAngle);
    }
  }

  render(nowMs: number): void {
    const renderAtMs = nowMs - RENDER_DELAY_MS;
    const pair = this.pickPair(renderAtMs);
    const present = this._present;
    present.clear();

    if (pair) {
      const { a, b, t } = pair;
      this._bMap.clear();
      for (const p of b.snap.players) this._bMap.set(p.id, p);
      for (const pa of a.snap.players) {
        const pb = this._bMap.get(pa.id) ?? pa;
        present.add(pa.id);
        const isLocal = pa.id === this.localId;
        const vis = this.ensureVehicle(pa.id, isLocal, pa.carKind);
        this.setNameplate(vis, pa.name, isLocal);

        // Server-authoritative rendering: every vehicle (local included)
        // is interpolated from the snapshot pair at the same RENDER_DELAY_MS
        // offset. The local truck lags real input by that delay, but in
        // exchange there is no client-side prediction loop, no reconcile
        // stutter, and the local truck cannot ever disagree with the server.
        vis.group.position.set(
          pa.vehicle.position.x + (pb.vehicle.position.x - pa.vehicle.position.x) * t,
          pa.vehicle.position.y + (pb.vehicle.position.y - pa.vehicle.position.y) * t,
          pa.vehicle.position.z + (pb.vehicle.position.z - pa.vehicle.position.z) * t,
        );
        this._qa.set(pa.vehicle.rotation.x, pa.vehicle.rotation.y, pa.vehicle.rotation.z, pa.vehicle.rotation.w);
        this._qb.set(pb.vehicle.rotation.x, pb.vehicle.rotation.y, pb.vehicle.rotation.z, pb.vehicle.rotation.w);
        this._qa.slerp(this._qb, t);
        vis.group.quaternion.copy(this._qa);

        // Interpolate axle DOFs from the snapshot pair. Falls back to
        // rest if the server omitted axles (legacy raycast vehicle).
        const axA = pa.vehicle.axles ?? null;
        const axB = pb.vehicle.axles ?? axA;
        this._axleBuf[0]!.rideY = 0; this._axleBuf[0]!.rollAngle = 0;
        this._axleBuf[1]!.rideY = 0; this._axleBuf[1]!.rollAngle = 0;
        if (axA && axB) {
          for (let i = 0; i < 2; i++) {
            const a0 = axA[i]!, a1 = axB[i]!;
            this._axleBuf[i]!.rideY = a0.rideY + (a1.rideY - a0.rideY) * t;
            this._axleBuf[i]!.rollAngle = a0.rollAngle + (a1.rollAngle - a0.rollAngle) * t;
          }
        }
        this.poseAxles(vis, this._axleBuf);

        for (let i = 0; i < 4; i++) {
          const wheel = vis.wheels[i]!;
          const wa = pa.vehicle.wheels[i];
          const wb = pb.vehicle.wheels[i];
          // Local truck's front wheels override snapshot steer with the
          // most recent input so the player gets immediate visual
          // feedback. Rear wheels and remote vehicles still come from
          // the snapshot.
          const useInputSteer = isLocal && i < 2;
          const steer = useInputSteer ? this._localInputSteer : (wa ? wa.steer : 0);
          const spin = wa && wb ? wa.spin + (wb.spin - wa.spin) * t : 0;
          wheel.rotation.set(spin, -steer, 0);
        }

        if (isLocal) {
          // Override the interpolated pose with linear extrapolation from
          // the LATEST snapshot. The interp pair we just used is ~100 ms
          // behind real time; for the local truck that delay reads as
          // "controls are unresponsive" because the user can see the
          // chassis lag their input. Extrapolating by linVel/angVel from
          // the freshest snapshot puts the chassis at "now" instead. The
          // dt cap (100 ms) prevents runaway when snapshots stall.
          //
          // Wheel spin and axles are left on the interp pair: the spin
          // delay is invisible at typical wheel speeds, and axle flex
          // smoothness reads better than freshness.
          const latest = this.buffer[this.buffer.length - 1]!;
          const me = latest.snap.players.find((p) => p.id === this.localId) ?? null;
          if (me) {
            const dt = Math.min(0.1, Math.max(0, (nowMs - latest.recvAtMs) / 1000));
            const lv = me.vehicle.linVel;
            vis.group.position.set(
              me.vehicle.position.x + lv.x * dt,
              me.vehicle.position.y + lv.y * dt,
              me.vehicle.position.z + lv.z * dt,
            );
            // Quaternion integration: dq/dt = 0.5 * (omega ⊗ q), where
            // omega is the angular velocity as a pure quaternion (0,wx,wy,wz).
            const q = me.vehicle.rotation;
            const w = me.vehicle.angVel;
            let nx = q.x + 0.5 * dt * ( w.x * q.w + w.y * q.z - w.z * q.y);
            let ny = q.y + 0.5 * dt * (-w.x * q.z + w.y * q.w + w.z * q.x);
            let nz = q.z + 0.5 * dt * ( w.x * q.y - w.y * q.x + w.z * q.w);
            let nw = q.w + 0.5 * dt * (-w.x * q.x - w.y * q.y - w.z * q.z);
            const len = Math.hypot(nx, ny, nz, nw) || 1;
            nx /= len; ny /= len; nz /= len; nw /= len;
            vis.group.quaternion.set(nx, ny, nz, nw);
            // Push the extrapolated quaternion into _qa so the camera
            // follow below sees the new pose, not the pre-extrapolation
            // slerp result.
            this._qa.set(nx, ny, nz, nw);
          }
          // Hand the (now extrapolated) chassis pose to the chase camera.
          this.cam.follow(vis.group.position, { x: this._qa.x, y: this._qa.y, z: this._qa.z, w: this._qa.w });
          this._localAxlesLast[0]!.rideY = this._axleBuf[0]!.rideY;
          this._localAxlesLast[0]!.rollAngle = this._axleBuf[0]!.rollAngle;
          this._localAxlesLast[1]!.rideY = this._axleBuf[1]!.rideY;
          this._localAxlesLast[1]!.rollAngle = this._axleBuf[1]!.rollAngle;
          this._localPos.x = vis.group.position.x;
          this._localPos.y = vis.group.position.y;
          this._localPos.z = vis.group.position.z;
          this._localSteer = pa.vehicle.wheels[0]?.steer ?? 0;
          this._localHasState = true;
        }
      }
    }

    // Camera follows local vehicle in the chosen mode.
    if (this.localId) {
      this.cam.apply();
    }

    if (pair) this.removeMissing(present);

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
      const wheelPositions = Physics.restWheelPositions(p.carKind);
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
        const wp = wheelPositions[i]!;
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

  /** Compute how far below its physics-resolved position an axle visual
   *  should drop because the ground beneath it is soft (mud). Both
   *  wheels of a solid axle share the beam, so the sink applies to the
   *  whole axle - one wheel digging in pulls its partner down too,
   *  matching the rigid coupling. Pure visual; chassis still rides at
   *  its physics-determined height. Returns 0 on road / dirt. */
  private axleSinkAt(group: THREE.Group, anchor: { centerLocalY: number; centerLocalZ: number }): number {
    if (!this.terrain) return 0;
    const q = group.quaternion;
    // Sample at the axle centre - in chassis-local that's (0, anchor.centerLocalY, anchor.centerLocalZ).
    const local = { x: 0, y: anchor.centerLocalY, z: anchor.centerLocalZ };
    const w = Physics.rotateVecByQuat(local, { x: q.x, y: q.y, z: q.z, w: q.w });
    const surf = Physics.sampleSurface(
      this.terrain.terrain,
      group.position.x + w.x,
      group.position.z + w.z,
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
