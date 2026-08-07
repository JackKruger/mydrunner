// Three.js scene + per-player vehicle visuals + interpolation buffer.
// Holds the last few server snapshots and renders them ~RENDER_DELAY_MS in
// the past so we always have two snapshots to interpolate between.

import * as THREE from 'three';
import {
  VEHICLE,
  Maps,
  Physics,
  DEFAULT_CAR_KIND,
  type CarKind,
  type PlayerSnapshot,
  type WorldSnapshot,
  type PlayerId,
} from '@mydrunner/shared';
import { RENDER_DELAY_MS } from './net.js';
import { buildCarMesh, colorHash } from './carMesh.js';
import { createNameplate, disposeNameplate } from './nameplate.js';
import { VehicleEffects } from './vehicleEffects.js';
import { ChaseCamera } from './camera.js';
import { Minimap, type MinimapPlayer } from './minimap.js';
import { WorldView } from './worldView.js';
import { disposeObject3D } from './three/dispose.js';

const TWO_PI = Math.PI * 2;

interface SnapshotEntry {
  recvAtMs: number;
  snap: WorldSnapshot;
}

/** The local truck's pose as the client-owned simulation last reported it. */
interface LocalOverride {
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number; w: number };
  wheels: { steer: number; spin: number; suspensionLength: number }[];
  axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }];
}

/** The exact remote pose rendered this frame, reused by physics proxies. */
export interface RemoteCollisionState {
  id: PlayerId;
  carKind: CarKind;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  linVel: { x: number; y: number; z: number };
  angVel: { x: number; y: number; z: number };
  recvAtMs: number;
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
}

export class Scene {
  readonly view: WorldView;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private cam: ChaseCamera;
  private buffer: SnapshotEntry[] = [];
  private vehicles = new Map<PlayerId, VehicleVisual>();
  private localId: PlayerId | null = null;
  private localCarKind: CarKind = DEFAULT_CAR_KIND;
  private effects: VehicleEffects;
  private minimap = new Minimap();
  private lastFrameTimeMs = 0;
  private _minimapBuf: MinimapPlayer[] = [];
  // Pre-allocated render-loop scratch buffers — avoids per-frame GC pressure.
  private _aMap = new Map<PlayerId, PlayerSnapshot>();
  private _qa = new THREE.Quaternion();
  private _qb = new THREE.Quaternion();
  private _axleBuf: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }] = [
    { rideY: 0, rollAngle: 0 },
    { rideY: 0, rollAngle: 0 },
  ];
  // Last rendered state for the local player. Kept around for the
  // surface-name HUD lookup, debug-panel axle readout, and e2e assertions.
  private _localPos = { x: 0, y: 0, z: 0 };
  private _localSteer = 0;
  private _localAxlesLast: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }] = [
    { rideY: 0, rollAngle: 0 },
    { rideY: 0, rollAngle: 0 },
  ];
  private _localHasState = false;
  // Immediate visual override for the local front-wheel steer angle. The
  // physics steering rack still ramps toward lock; showing the sampled
  // input immediately makes that mechanical response readable.
  private _localInputSteer = 0;
  private _present = new Set<PlayerId>();
  private _remoteCollisionStates: RemoteCollisionState[] = [];

  constructor(canvasParent: HTMLElement) {
    // Renderer, lighting, sky, terrain, obstacles and landmarks all live
    // in WorldView so the level editor renders the same world this does.
    this.view = new WorldView(canvasParent);
    this.renderer = this.view.renderer;
    this.scene = this.view.scene;

    this.cam = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.camera = this.cam.camera;

    this.effects = new VehicleEffects();
    this.scene.add(this.effects.group);

    window.addEventListener('resize', () => {
      this.cam.setAspect(window.innerWidth / window.innerHeight);
      this.view.setSize(window.innerWidth, window.innerHeight);
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

  /** Install the world visuals from the map composed once in main.ts.
   *
   *  Takes the composed obstacles rather than regenerating them from the
   *  terrain: on an authored map that would drop the placed objects and
   *  bring back the deleted ones, and the truck would collide with rocks
   *  nobody could see. */
  setWorld(map: Maps.MapWorld): void {
    const terrain = map.terrain;
    this.view.setWorld({
      terrain,
      obstacles: map.obstacles,
      landmarks: map.landmarks,
    });
    this.minimap.setTerrain(terrain);
    this.effects.setTerrain(terrain);
    this.cam.setTerrain({ heightAt: (x, z) => this.view.heightAt(x, z) });
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
      disposeObject3D(v.group);
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
        disposeObject3D(v.group);
        this.vehicles.delete(id);
      }
    }
  }

  /** Read-only accessors used by the HUD (surface-under-truck lookup),
   *  the debug panel (axle DOF readout), and e2e tests. All sourced from
   *  the pose the vehicle was actually rendered with this frame - the
   *  owner-simulation override for the local truck when active, snapshot
   *  interpolation/extrapolation otherwise. */
  localPosition(): { x: number; y: number; z: number } | null {
    return this._localHasState ? this._localPos : null;
  }
  localSteer(): number {
    return this._localSteer;
  }
  localAxles(): [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }] | null {
    return this._localHasState ? this._localAxlesLast : null;
  }
  /** Remote chassis poses exactly as drawn on the previous render pass. */
  remoteCollisionStates(): readonly RemoteCollisionState[] {
    return this._remoteCollisionStates;
  }
  /** Push the latest sampled input steer (range -1..1) so the local
   *  truck's front wheels can show the player's intent immediately. */
  setLocalInputSteer(steer: number): void {
    this._localInputSteer = Math.max(-1, Math.min(1, steer)) * VEHICLE.maxSteer;
  }

  /** Debug-only: lock the camera at fixed world coordinates looking at
   *  a fixed target. Pass null to clear and resume normal chase/sky
   *  cam behaviour. Used by the map-review screenshot script. */
  private _reviewCamPos: { x: number; y: number; z: number } | null = null;
  private _reviewCamLook: { x: number; y: number; z: number } | null = null;
  setReviewView(
    pos: { x: number; y: number; z: number } | null,
    lookAt?: { x: number; y: number; z: number },
  ): void {
    this._reviewCamPos = pos;
    this._reviewCamLook = pos ? (lookAt ?? { x: 0, y: 0, z: 0 }) : null;
  }

  /** Override the local truck's visuals from the owner simulation. When
   *  set, render() skips snapshot interp/extrapolation for the local
   *  truck and uses these values directly. Reset on disconnect by
   *  passing null. */
  private _localOverride: LocalOverride | null = null;
  setLocalVehiclePose(
    pos: { x: number; y: number; z: number },
    rot: { x: number; y: number; z: number; w: number },
    wheels: { steer: number; spin: number; suspensionLength: number }[],
    axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }],
  ): void {
    this._localOverride = { pos, rot, wheels, axles };
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
      const sink = this.effects.axleSink(v.group, {
        centerLocalY: ag.centerLocalY,
        centerLocalZ: ag.centerLocalZ,
      });
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

  /** Pose the local truck from the owner-simulation override.
   *
   *  Shared by the snapshot path, where it overwrites the interpolated
   *  pose, and the preview path, where it is the only pose there is.
   *  Extracted rather than copied: two versions of this would drift, and
   *  the drift would show up as the preview handling differently from the
   *  game it is previewing. */
  private applyLocalOverride(vis: VehicleVisual, ov: LocalOverride): void {
    vis.group.position.set(ov.pos.x, ov.pos.y, ov.pos.z);
    vis.group.quaternion.set(ov.rot.x, ov.rot.y, ov.rot.z, ov.rot.w);
    this._qa.set(ov.rot.x, ov.rot.y, ov.rot.z, ov.rot.w);
    this.poseAxles(vis, ov.axles);
    for (let i = 0; i < 4; i++) {
      const wheel = vis.wheels[i]!;
      const ws = ov.wheels[i];
      // Front wheels take the most recent input steer so the player gets
      // immediate visual feedback; rears come from the sim.
      const steer = i < 2 ? this._localInputSteer : (ws ? ws.steer : 0);
      wheel.rotation.set(ws ? ws.spin : 0, -steer, 0);
    }
    this._localAxlesLast[0]!.rideY = ov.axles[0].rideY;
    this._localAxlesLast[0]!.rollAngle = ov.axles[0].rollAngle;
    this._localAxlesLast[1]!.rideY = ov.axles[1].rideY;
    this._localAxlesLast[1]!.rollAngle = ov.axles[1].rollAngle;
  }

  /** Point the camera at whatever pose was just written, and publish the
   *  read-only accessors the HUD, debug panel and e2e suite consume. */
  private finishLocal(vis: VehicleVisual): void {
    this.cam.follow(
      vis.group.position,
      { x: this._qa.x, y: this._qa.y, z: this._qa.z, w: this._qa.w },
    );
    this._localPos.x = vis.group.position.x;
    this._localPos.y = vis.group.position.y;
    this._localPos.z = vis.group.position.z;
    this._localHasState = true;
  }

  render(nowMs: number): void {
    const renderAtMs = nowMs - RENDER_DELAY_MS;
    const pair = this.pickPair(renderAtMs);
    const present = this._present;
    present.clear();
    this._remoteCollisionStates.length = 0;

    if (pair) {
      const { a, b, t } = pair;
      // Iterate the NEWER snapshot and look the older one up, not the
      // other way round. Membership has to come from `b`: a player who
      // appears in `b` but not `a` was never created at all under the old
      // ordering, and since `present` fed removeMissing() from `a` they
      // stayed invisible - normally for one snapshot (~33 ms), but for the
      // whole stall in pickPair's clamp branch, where the buffer stops
      // advancing. A player in `a` but not `b` has left, and now correctly
      // stops rendering instead of freezing at their last pose.
      this._aMap.clear();
      for (const p of a.snap.players) this._aMap.set(p.id, p);
      for (const pb of b.snap.players) {
        // No `a` entry means this player just joined: interpolate from
        // their own `b` pose, i.e. render them there.
        const pa = this._aMap.get(pb.id) ?? pb;
        present.add(pb.id);
        const isLocal = pb.id === this.localId;
        const vis = this.ensureVehicle(pb.id, isLocal, pb.carKind);
        this.setNameplate(vis, pb.name, isLocal);

        // Snapshot interpolation pass: every vehicle is first posed from
        // the snapshot pair at RENDER_DELAY_MS in the past. For remote
        // vehicles this is final. For the LOCAL truck it is overwritten
        // below by the owner override (or, before the simulation's
        // first state arrives, by extrapolation from the latest snapshot).
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
          // spin arrives wrapped to [0, 2pi) (see messages.ts SPIN_SCALE
          // packing), so lerp along the shortest wrapped arc. A naive lerp
          // sweeps backwards through a full revolution every time the value
          // wraps - at speed that read as the wheels stuttering in reverse.
          let spin = 0;
          if (wa && wb) {
            let d = (wb.spin - wa.spin) % TWO_PI;
            if (d > Math.PI) d -= TWO_PI;
            if (d < -Math.PI) d += TWO_PI;
            spin = wa.spin + d * t;
          }
          wheel.rotation.set(spin, -steer, 0);
        }

        if (isLocal) {
          // If the owner simulation has pushed an override this frame,
          // use it directly: the local truck's pose comes from the
          // local Rapier sim, NOT from snapshot interp/extrapolation.
          // Otherwise fall back to extrapolating from the latest
          // snapshot (used briefly before the first local state
          // arrives).
          const ov = this._localOverride;
          if (ov) {
            this.applyLocalOverride(vis, ov);
          } else {
            // Fall back to extrapolation from the latest snapshot.
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
              const q = me.vehicle.rotation;
              const w = me.vehicle.angVel;
              let nx = q.x + 0.5 * dt * ( w.x * q.w + w.y * q.z - w.z * q.y);
              let ny = q.y + 0.5 * dt * (-w.x * q.z + w.y * q.w + w.z * q.x);
              let nz = q.z + 0.5 * dt * ( w.x * q.y - w.y * q.x + w.z * q.w);
              let nw = q.w + 0.5 * dt * (-w.x * q.x - w.y * q.y - w.z * q.z);
              const len = Math.hypot(nx, ny, nz, nw) || 1;
              nx /= len; ny /= len; nz /= len; nw /= len;
              vis.group.quaternion.set(nx, ny, nz, nw);
              this._qa.set(nx, ny, nz, nw);
            }
            this._localAxlesLast[0]!.rideY = this._axleBuf[0]!.rideY;
            this._localAxlesLast[0]!.rollAngle = this._axleBuf[0]!.rollAngle;
            this._localAxlesLast[1]!.rideY = this._axleBuf[1]!.rideY;
            this._localAxlesLast[1]!.rollAngle = this._axleBuf[1]!.rollAngle;
          }
          this._localSteer = pa.vehicle.wheels[0]?.steer ?? 0;
          this.finishLocal(vis);
        } else {
          const latestRecvAtMs = this.buffer[this.buffer.length - 1]!.recvAtMs;
          this._remoteCollisionStates.push({
            id: pb.id,
            carKind: pb.carKind,
            position: {
              x: vis.group.position.x,
              y: vis.group.position.y,
              z: vis.group.position.z,
            },
            rotation: {
              x: vis.group.quaternion.x,
              y: vis.group.quaternion.y,
              z: vis.group.quaternion.z,
              w: vis.group.quaternion.w,
            },
            linVel: {
              x: pa.vehicle.linVel.x + (pb.vehicle.linVel.x - pa.vehicle.linVel.x) * t,
              y: pa.vehicle.linVel.y + (pb.vehicle.linVel.y - pa.vehicle.linVel.y) * t,
              z: pa.vehicle.linVel.z + (pb.vehicle.linVel.z - pa.vehicle.linVel.z) * t,
            },
            angVel: {
              x: pa.vehicle.angVel.x + (pb.vehicle.angVel.x - pa.vehicle.angVel.x) * t,
              y: pa.vehicle.angVel.y + (pb.vehicle.angVel.y - pa.vehicle.angVel.y) * t,
              z: pa.vehicle.angVel.z + (pb.vehicle.angVel.z - pa.vehicle.angVel.z) * t,
            },
            recvAtMs: latestRecvAtMs,
          });
        }
      }
    } else if (this.localId && this._localOverride) {
      // No snapshot stream at all — the offline preview, driving the local
      // Rapier sim with no server. Same visual, same pose code, same
      // camera; only where the pose came from differs. Without this branch
      // nothing is ever drawn: ensureVehicle and cam.follow used to be
      // reachable only by iterating a snapshot's player list.
      const ov = this._localOverride;
      const vis = this.ensureVehicle(this.localId, true, this.localCarKind);
      present.add(this.localId);
      this.applyLocalOverride(vis, ov);
      this._localSteer = ov.wheels[0]?.steer ?? 0;
      this.finishLocal(vis);
    }

    // Camera follows local vehicle in the chosen mode, unless a debug
    // review-view is set (used by the map-review screenshot script to
    // position the camera at fixed world coordinates that are not tied
    // to the local truck).
    if (this.localId) {
      this.cam.apply();
    }
    if (this._reviewCamPos) {
      this.camera.position.set(this._reviewCamPos.x, this._reviewCamPos.y, this._reviewCamPos.z);
      this.camera.lookAt(this._reviewCamLook!.x, this._reviewCamLook!.y, this._reviewCamLook!.z);
    }

    // `present` holds only the local truck in preview mode and there is
    // never anything else to remove — but gating on `pair` alone would be a
    // trap for whoever adds a second vehicle to an offline mode later.
    if (pair || present.size > 0) this.removeMissing(present);

    // Ground-response visuals (mud thrown by spinning wheels) read the
    // poses just written above, so they show exactly what is on screen.
    // VehicleEffects owns the snapshot-arrival gate.
    const frameDt = this.lastFrameTimeMs > 0 ? nowMs - this.lastFrameTimeMs : 16;
    this.lastFrameTimeMs = nowMs;
    if (pair) {
      this.effects.spawnFromSnapshot(
        pair.b.snap,
        pair.b.recvAtMs,
        (id) => this.vehicles.get(id)?.group ?? null,
      );
    }
    this.effects.update(frameDt);

    // Minimap dots come from the posed visuals, so they show exactly what
    // the player sees (owner simulation locally, interpolation remotely).
    // Entries are recycled to keep the render loop allocation-free.
    let mi = 0;
    for (const [id, v] of this.vehicles) {
      const q = v.group.quaternion;
      let entry = this._minimapBuf[mi];
      if (!entry) {
        entry = { x: 0, z: 0, yaw: 0, isLocal: false };
        this._minimapBuf[mi] = entry;
      }
      entry.x = v.group.position.x;
      entry.z = v.group.position.z;
      entry.yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
      entry.isLocal = id === this.localId;
      mi += 1;
    }
    this._minimapBuf.length = mi;
    this.minimap.update(this._minimapBuf);

    this.view.render(this.camera);
  }

  /** The TerrainData the world was built from, or null before the
   *  handshake. */
  private get terrainData(): Physics.TerrainData | null {
    return this.view.terrainMesh?.terrain ?? null;
  }
}
