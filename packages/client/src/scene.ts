// Three.js scene + per-player vehicle visuals + interpolation buffer.
// Holds the last few server snapshots and renders them ~RENDER_DELAY_MS in
// the past so we always have two snapshots to interpolate between.

import * as THREE from 'three';
import {
  Maps,
  Physics,
  createStockBuild,
  type VehicleBuild,
  type PlayerSnapshot,
  type VehicleState,
  type WorldSnapshot,
  type PlayerId,
  type WinchLinkSnapshot,
} from '@mydrunner/shared';
import type { WinchAttachTarget } from '@mydrunner/shared/net';
import { RENDER_DELAY_MS } from './net.js';
import { buildCarMesh, colorHash, type TireDeformer } from './carMesh.js';
import type { SuspensionVisual } from './suspensionVisual.js';
import { createNameplate, disposeNameplate } from './nameplate.js';
import { VehicleEffects } from './vehicleEffects.js';
import { ChaseCamera, type CameraMode } from './camera.js';
import { Minimap, type MinimapPlayer } from './minimap.js';
import { WorldView } from './worldView.js';
import { disposeObject3D } from './three/dispose.js';
import { WinchView } from './winchView.js';
import { VehicleDebugView } from './vehicleDebugView.js';

const TWO_PI = Math.PI * 2;

/** Minimap redraw interval. Not in constants.ts: nothing outside this file
 *  reads it and it tunes a HUD repaint, not physics or networking. */
const MINIMAP_INTERVAL_MS = 100;

interface SnapshotEntry {
  recvAtMs: number;
  snap: WorldSnapshot;
}

/** The local truck's pose as the client-owned simulation last reported it. */
interface LocalOverride {
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number; w: number };
  wheels: {
    steer: number; spin: number; suspensionLength: number;
    tireDeflection: number; tireContactNormal: { x: number; y: number; z: number };
  }[];
  axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }];
}

/** The exact remote pose rendered this frame, reused by physics proxies. */
export interface RemoteCollisionState {
  id: PlayerId;
  build: VehicleBuild;
  buildRevision: number;
  workshopMode: boolean;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  linVel: { x: number; y: number; z: number };
  angVel: { x: number; y: number; z: number };
  recvAtMs: number;
}

interface VehicleVisual {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  tires: TireDeformer[];
  /** Solid-axle group meshes [front, rear]. Posed each frame from the
   *  vehicle's axle DOFs (rideY + rollAngle). Wheels are children of
   *  these groups, so moving the axle moves both wheels as one rigid
   *  beam - the visual signature of solid-axle articulation. */
  axles: [THREE.Group, THREE.Group];
  suspension: SuspensionVisual;
  nameplate: THREE.Sprite | null;
  nameplateText: string;
  build: VehicleBuild;
  buildRevision: number;
  recovery: { fairlead: THREE.Object3D; front: THREE.Object3D; rear: THREE.Object3D };
}

export interface WinchPick {
  target: WinchAttachTarget;
  point: { x: number; y: number; z: number };
  label: string;
}

export class Scene {
  readonly view: WorldView;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private cam: ChaseCamera;
  /** A separate camera for the main menu's live map panorama. Keeping it
   *  independent means the chase camera still starts from a clean state when
   *  the player enters the world. */
  private readonly menuCamera: THREE.PerspectiveCamera;
  private readonly menuCameraPath = new THREE.CatmullRomCurve3([
    // Trail entrance, mountain south face, summit, north valley, river.
    // These are deliberately broad establishing views rather than a fly-by
    // close to the ground, so spline interpolation cannot clip the terrain.
    new THREE.Vector3(10, 34, -92),
    new THREE.Vector3(116, 62, -30),
    new THREE.Vector3(142, 84, 92),
    new THREE.Vector3(52, 94, 152),
    new THREE.Vector3(-92, 48, 132),
    new THREE.Vector3(-132, 28, -42),
    new THREE.Vector3(-72, 20, -112),
  ], true, 'catmullrom', 0.22);
  private readonly menuLookPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(58, 14, -10),
    new THREE.Vector3(74, 38, 100),
    new THREE.Vector3(68, 48, 112),
    new THREE.Vector3(8, 12, 62),
    new THREE.Vector3(-38, 4, 22),
    new THREE.Vector3(-45, 1, -58),
    new THREE.Vector3(-32, 1, -76),
  ], true, 'catmullrom', 0.22);
  private readonly _menuCameraPos = new THREE.Vector3();
  private readonly _menuCameraLook = new THREE.Vector3();
  private buffer: SnapshotEntry[] = [];
  private vehicles = new Map<PlayerId, VehicleVisual>();
  private localId: PlayerId | null = null;
  private localBuild: VehicleBuild = createStockBuild();
  private localBuildRevision = 1;
  private effects: VehicleEffects;
  private minimap = new Minimap();
  private lastFrameTimeMs = 0;
  private _minimapBuf: MinimapPlayer[] = [];
  // Pre-allocated render-loop scratch buffers — avoids per-frame GC pressure.
  private _aMap = new Map<PlayerId, PlayerSnapshot>();
  private _qa = new THREE.Quaternion();
  private _qb = new THREE.Quaternion();
  private _tireNormal = new THREE.Vector3();
  private _tireInverseQ = new THREE.Quaternion();
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
  private _localState: VehicleState | null = null;
  private _present = new Set<PlayerId>();
  private _remoteCollisionStates: RemoteCollisionState[] = [];
  private _winchBuf: WinchLinkSnapshot[] = [];
  private readonly _winchSourceVec = new THREE.Vector3();
  private readonly _winchTargetVec = new THREE.Vector3();
  private lastMinimapMs = 0;
  private readonly winchView = new WinchView();
  private vehicleDebugView: VehicleDebugView | null = null;
  private readonly winchRaycaster = new THREE.Raycaster();
  private mapWorld: Maps.MapWorld | null = null;
  private localWinches: WinchLinkSnapshot[] = [];

  constructor(canvasParent: HTMLElement) {
    // Renderer, lighting, sky, terrain, obstacles and landmarks all live
    // in WorldView so the level editor renders the same world this does.
    this.view = new WorldView(canvasParent);
    this.renderer = this.view.renderer;
    this.scene = this.view.scene;

    this.cam = new ChaseCamera(window.innerWidth / window.innerHeight);
    this.camera = this.cam.camera;
    this.menuCamera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 700);

    this.effects = new VehicleEffects();
    this.scene.add(this.effects.group);
    this.scene.add(this.winchView.group);

    window.addEventListener('resize', () => {
      this.cam.setAspect(window.innerWidth / window.innerHeight);
      this.menuCamera.aspect = window.innerWidth / window.innerHeight;
      this.menuCamera.updateProjectionMatrix();
      this.view.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // Diagnostic accessors used by the screenshot e2e test - keep them
  // available so the test continues to read camera state without
  // reaching into private internals.
  get cameraYaw(): number { return this.cam.yaw; }
  get cameraTarget(): THREE.Vector3 { return this.cam.target; }
  get cameraMode(): CameraMode { return this.cam.mode; }

  setLocalPlayer(id: PlayerId, build: VehicleBuild = createStockBuild(), buildRevision = 1): void {
    this.localId = id;
    this.localBuild = build;
    this.localBuildRevision = buildRevision;
  }

  setVehicleDebugEnabled(enabled: boolean): void {
    if (enabled && !this.vehicleDebugView) {
      this.vehicleDebugView = new VehicleDebugView();
      this.scene.add(this.vehicleDebugView.group);
    }
    if (this.vehicleDebugView) this.vehicleDebugView.group.visible = enabled;
  }

  updateVehicleDebug(telemetry: Physics.VehicleDebugTelemetry): void {
    this.vehicleDebugView?.update(telemetry);
  }

  /** Install the world visuals from the map composed once in main.ts.
   *
   *  Takes the composed obstacles rather than regenerating them from the
   *  terrain: on an authored map that would drop the placed objects and
   *  bring back the deleted ones, and the truck would collide with rocks
   *  nobody could see. */
  setWorld(map: Maps.MapWorld): void {
    this.mapWorld = map;
    const terrain = map.terrain;
    this.view.setWorld({
      terrain,
      obstacles: map.obstacles,
      landmarks: map.landmarks,
      markers: map.markers,
    });
    this.minimap.setTerrain(terrain);
    this.effects.setTerrain(terrain);
    this.cam.setTerrain({ heightAt: (x, z) => this.view.heightAt(x, z) });
  }

  setLocalWinchLinks(links: readonly WinchLinkSnapshot[]): void {
    this.localWinches = [...links];
  }

  /** Draw the real map behind the main menu along a slow, closed panorama.
   *  `animate=false` holds the opening composition for reduced-motion users. */
  renderMenuPanorama(nowMs: number, startedAtMs: number, animate = true): void {
    const PANORAMA_LOOP_MS = 96_000;
    const t = animate ? ((Math.max(0, nowMs - startedAtMs) % PANORAMA_LOOP_MS) / PANORAMA_LOOP_MS) : 0;
    this.menuCameraPath.getPointAt(t, this._menuCameraPos);
    this.menuLookPath.getPointAt(t, this._menuCameraLook);
    this.menuCamera.position.copy(this._menuCameraPos);
    this.menuCamera.lookAt(this._menuCameraLook);
    this.view.render(this.menuCamera);
  }

  setWinchTarget(point: { x: number; y: number; z: number } | null, valid = false): void {
    this.winchView.setTarget(point, valid);
  }

  pickWinchTarget(): WinchPick | null {
    if (!this.localId || !this.mapWorld) return null;
    this.winchRaycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.winchRaycaster.far = 80;
    const roots: THREE.Object3D[] = [];
    if (this.view.obstacleGroup) roots.push(this.view.obstacleGroup);
    if (this.view.terrainMesh) roots.push(this.view.terrainMesh.mesh);
    for (const [id, visual] of this.vehicles) if (id !== this.localId) roots.push(visual.group);
    const hits = this.winchRaycaster.intersectObjects(roots, true);
    const source = this.localPosition();
    if (!source || hits.length === 0) return null;
    const hit = hits[0]!;
    let node: THREE.Object3D | null = hit.object;
    while (node) {
      const obstacleId = node.userData.obstacleId as string | undefined;
      if (obstacleId) {
        const obstacle = this.mapWorld.obstacles.find((entry) => entry.id === obstacleId);
        const anchor = obstacle ? Physics.winchAnchorForObstacle(obstacle, source) : null;
        if (!anchor || Math.hypot(anchor.x - source.x, anchor.y - source.y, anchor.z - source.z) > 30) return null;
        return { target: { kind: 'obstacle', obstacleId }, point: anchor, label: obstacle!.kind };
      }
      const playerId = node.userData.playerId as string | undefined;
      if (playerId) {
        const visual = this.vehicles.get(playerId);
        if (!visual) return null;
        const localHit = visual.group.worldToLocal(hit.point.clone());
        const point = localHit.z >= 0 ? 'front' : 'rear';
        const worldPoint = visual.recovery[point].getWorldPosition(new THREE.Vector3());
        if (worldPoint.distanceTo(new THREE.Vector3(source.x, source.y, source.z)) > 30) return null;
        return { target: { kind: 'vehicle', playerId, point }, point: worldPoint, label: `vehicle ${point}` };
      }
      node = node.parent;
    }
    return null;
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

  private ensureVehicle(
    id: PlayerId,
    isLocal: boolean,
    build: VehicleBuild,
    buildRevision: number,
  ): VehicleVisual {
    let v = this.vehicles.get(id);
    if (v && v.buildRevision === buildRevision) return v;
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
    const built = buildCarMesh(build, isLocal, colorHash(id));
    this.scene.add(built.group);
    v = {
      group: built.group,
      wheels: built.wheels,
      tires: built.tires,
      axles: built.axles,
      suspension: built.suspension,
      nameplate: null,
      nameplateText: '',
      build,
      buildRevision,
      recovery: built.recovery,
    };
    v.group.userData.playerId = id;
    this.vehicles.set(id, v);
    return v;
  }

  /** Add or update the nameplate above a vehicle. Local player gets none -
   *  no point labeling yourself. */
  private setNameplate(v: VehicleVisual, name: string, isLocal: boolean): void {
    if (v.nameplateText === name) return;
    // The local truck intentionally has no sprite, but the game-menu roster
    // still needs its real call sign rather than the generic "Driver" label.
    v.nameplateText = name;
    if (isLocal) return;
    if (v.nameplate) {
      v.group.remove(v.nameplate);
      disposeNameplate(v.nameplate);
    }
    const sprite = createNameplate(name);
    // Sit above the roof rack.
    sprite.position.set(0, Physics.geomFor(v.build).chassisHalfExtents.y * 2 + 1.4, 0);
    v.group.add(sprite);
    v.nameplate = sprite;
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
    wheels: {
      steer: number; spin: number; suspensionLength: number;
      tireDeflection: number; tireContactNormal: { x: number; y: number; z: number };
    }[],
    axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }],
  ): void {
    this._localOverride = { pos, rot, wheels, axles };
  }

  /** The owner simulation's canonical state.
   *
   *  Only used offline: effects normally ride the snapshot stream, which
   *  carries the local player back too, so online needs nothing extra.
   *  In preview there is no stream at all and this is the only source of
   *  the velocities and wheel contacts the effects read. */
  setLocalVehicleState(state: VehicleState): void {
    this._localState = state;
  }

  /** Pose the two axle groups from per-axle (rideY, rollAngle) state.
   *
   *  Suspension rays and physical wheel travel both use chassis-local Y, so
   *  spring extension must remain in that same frame. The old world-down
   *  correction divided extension by cos(pitch), pushing wheels progressively
   *  through the ground on even modest slopes. Mud sink is intentionally a
   *  world-vertical visual effect, so only that offset needs conversion. */
  private poseAxles(
    v: VehicleVisual,
    axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }],
  ): void {
    const geom = Physics.geomFor(v.build);
    const q = v.group.quaternion;
    // World-Y component of the chassis's local-Y (up) axis.
    const chassisUp = Physics.rotateVecByQuat(
      { x: 0, y: 1, z: 0 },
      { x: q.x, y: q.y, z: q.z, w: q.w },
    );
    // Bound only the cosmetic sink conversion while heavily tilted/inverted.
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
        ag.centerLocalY - springExt - sink / upY,
        ag.centerLocalZ,
      );
      // Roll about chassis-forward (local +Z). YXZ ordering keeps the
      // small-angle visual stable - rollAngle is the dominant DOF.
      v.axles[i]!.rotation.set(0, 0, ax.rollAngle);
    }
    v.suspension.update();
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
      // Render the steering rack's simulated angle so keyboard input shows
      // the same progressive travel that the tyre forces actually use.
      const steer = ws ? ws.steer : 0;
      wheel.rotation.set(ws ? ws.spin : 0, -steer, 0);
      if (ws) this.deformTire(vis, i, ws.tireDeflection, ws.tireContactNormal);
    }
    this._localAxlesLast[0]!.rideY = ov.axles[0].rideY;
    this._localAxlesLast[0]!.rollAngle = ov.axles[0].rollAngle;
    this._localAxlesLast[1]!.rideY = ov.axles[1].rideY;
    this._localAxlesLast[1]!.rollAngle = ov.axles[1].rollAngle;
  }

  private deformTire(
    vis: VehicleVisual,
    index: number,
    deflection: number,
    chassisNormal: { x: number; y: number; z: number },
  ): void {
    this._tireNormal.set(chassisNormal.x, chassisNormal.y, chassisNormal.z);
    this._tireInverseQ.copy(vis.axles[index < 2 ? 0 : 1]!.quaternion).invert();
    this._tireNormal.applyQuaternion(this._tireInverseQ);
    this._tireInverseQ.copy(vis.wheels[index]!.quaternion).invert();
    this._tireNormal.applyQuaternion(this._tireInverseQ).normalize();
    vis.tires[index]!.update(deflection, this._tireNormal);
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
        const vis = this.ensureVehicle(pb.id, isLocal, pb.build, pb.buildRevision);
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

        // Interpolate axle DOFs from the snapshot pair.
        for (let i = 0; i < 2; i++) {
          const a0 = pa.vehicle.axles[i]!, a1 = pb.vehicle.axles[i]!;
          this._axleBuf[i]!.rideY = a0.rideY + (a1.rideY - a0.rideY) * t;
          this._axleBuf[i]!.rollAngle = a0.rollAngle + (a1.rollAngle - a0.rollAngle) * t;
        }
        this.poseAxles(vis, this._axleBuf);

        for (let i = 0; i < 4; i++) {
          const wheel = vis.wheels[i]!;
          const wa = pa.vehicle.wheels[i];
          const wb = pb.vehicle.wheels[i];
          const steer = wa ? wa.steer : 0;
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
          if (wa && wb) {
            const nx = wa.tireContactNormal.x + (wb.tireContactNormal.x - wa.tireContactNormal.x) * t;
            const ny = wa.tireContactNormal.y + (wb.tireContactNormal.y - wa.tireContactNormal.y) * t;
            const nz = wa.tireContactNormal.z + (wb.tireContactNormal.z - wa.tireContactNormal.z) * t;
            const nl = Math.hypot(nx, ny, nz) || 1;
            this.deformTire(vis, i,
              wa.tireDeflection + (wb.tireDeflection - wa.tireDeflection) * t,
              { x: nx / nl, y: ny / nl, z: nz / nl });
          }
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
            build: pb.build,
            buildRevision: pb.buildRevision,
            workshopMode: pb.workshopMode,
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
      const vis = this.ensureVehicle(this.localId, true, this.localBuild, this.localBuildRevision);
      present.add(this.localId);
      this.applyLocalOverride(vis, ov);
      this._localSteer = ov.wheels[0]?.steer ?? 0;
      this.finishLocal(vis);
      // Effects hang off snapshot arrival, and there are no snapshots
      // here — without this you could author a river in the editor, hit
      // Preview, drive through it and see no spray at all.
      if (this._localState) {
        this.effects.spawnLocal(this.localBuild, this._localState, vis.group, nowMs);
      }
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

    // Ground-response visuals (mud, dust or smoke from spinning wheels) read the
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
      entry.label = v.nameplateText || (entry.isLocal ? 'Driver' : id);
      mi += 1;
    }
    this._minimapBuf.length = mi;
    // The minimap is a filtered canvas-2D blit plus per-player path work, and
    // the browser recomposites that layer every time it is touched. A dot
    // moving at 15 m/s crosses one minimap pixel in ~120 ms, so redrawing at
    // display rate bought nothing; MINIMAP_INTERVAL_MS keeps it well ahead of
    // what the eye can resolve at a fraction of the cost.
    if (nowMs - this.lastMinimapMs >= MINIMAP_INTERVAL_MS) {
      this.lastMinimapMs = nowMs;
      this.minimap.update(this._minimapBuf);
    }

    const renderedLinks = this._winchBuf;
    renderedLinks.length = 0;
    for (const entry of pair?.b.snap.winches ?? []) renderedLinks.push(entry);
    for (const link of this.localWinches) {
      if (!renderedLinks.some((entry) => entry.id === link.id)) renderedLinks.push(link);
    }
    this.winchView.update(renderedLinks, this._winchEndpoint);
    this.view.render(this.camera);
  }

  /** Bound once rather than re-created per frame at the WinchView call site.
   *
   *  Writes into one of two scratch vectors chosen by `end`: WinchView holds
   *  the source and target simultaneously to lay out the cable, so a single
   *  shared vector would make both ends the same point. */
  private readonly _winchEndpoint = (link: WinchLinkSnapshot, end: 'source' | 'target'): THREE.Vector3 | null => {
    const out = end === 'source' ? this._winchSourceVec : this._winchTargetVec;
    if (end === 'source') return this.vehicles.get(link.ownerId)?.recovery.fairlead.getWorldPosition(out) ?? null;
    if (link.target.kind === 'obstacle') return out.set(link.target.anchor.x, link.target.anchor.y, link.target.anchor.z);
    return this.vehicles.get(link.target.playerId)?.recovery[link.target.point].getWorldPosition(out) ?? null;
  };

  /** The TerrainData the world was built from, or null before the
   *  handshake. */
  private get terrainData(): Physics.TerrainData | null {
    return this.view.terrainMesh?.terrain ?? null;
  }
}
