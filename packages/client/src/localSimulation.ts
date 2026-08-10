// Client-owned vehicle simulation.
//
// The browser is the sole authority for its truck. Network snapshots are
// never fed back into this world: they exist only to render remote players.
// Physics advances at a fixed rate while state(alpha) interpolates the two
// most recent completed steps for a smooth render pose at any display rate.

import {
  BUTTON_RESET,
  VEHICLE,
  WINCH,
  Maps,
  Physics,
  createStockBuild,
  type PlayerInput,
  type VehicleBuild,
  type VehicleState,
  type WinchLinkSnapshot,
  type WinchMotor,
  type WinchRuntimeUpdate,
} from '@mydrunner/shared';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { RemoteCollisionState } from './scene.js';

export interface LocalSimulationState {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  wheels: {
    steer: number; spin: number; suspensionLength: number;
    tireDeflection: number; tireContactNormal: { x: number; y: number; z: number };
  }[];
  axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }];
}

function makeState(): LocalSimulationState {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    wheels: [
      { steer: 0, spin: 0, suspensionLength: 0, tireDeflection: 0, tireContactNormal: { x: 0, y: 1, z: 0 } },
      { steer: 0, spin: 0, suspensionLength: 0, tireDeflection: 0, tireContactNormal: { x: 0, y: 1, z: 0 } },
      { steer: 0, spin: 0, suspensionLength: 0, tireDeflection: 0, tireContactNormal: { x: 0, y: 1, z: 0 } },
      { steer: 0, spin: 0, suspensionLength: 0, tireDeflection: 0, tireContactNormal: { x: 0, y: 1, z: 0 } },
    ],
    axles: [
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ],
  };
}

function copyVehicleState(from: VehicleState, to: LocalSimulationState): void {
  to.position.x = from.position.x;
  to.position.y = from.position.y;
  to.position.z = from.position.z;
  to.rotation.x = from.rotation.x;
  to.rotation.y = from.rotation.y;
  to.rotation.z = from.rotation.z;
  to.rotation.w = from.rotation.w;
  for (let i = 0; i < 4; i++) {
    const src = from.wheels[i];
    const dst = to.wheels[i]!;
    if (!src) continue;
    dst.steer = src.steer;
    dst.spin = src.spin;
    dst.suspensionLength = src.suspensionLength;
    dst.tireDeflection = src.tireDeflection;
    dst.tireContactNormal.x = src.tireContactNormal.x;
    dst.tireContactNormal.y = src.tireContactNormal.y;
    dst.tireContactNormal.z = src.tireContactNormal.z;
  }
  const axles = from.axles;
  to.axles[0].rideY = axles[0].rideY;
  to.axles[0].rollAngle = axles[0].rollAngle;
  to.axles[1].rideY = axles[1].rideY;
  to.axles[1].rollAngle = axles[1].rollAngle;
}

function copyState(from: LocalSimulationState, to: LocalSimulationState): void {
  to.position.x = from.position.x;
  to.position.y = from.position.y;
  to.position.z = from.position.z;
  to.rotation.x = from.rotation.x;
  to.rotation.y = from.rotation.y;
  to.rotation.z = from.rotation.z;
  to.rotation.w = from.rotation.w;
  for (let i = 0; i < 4; i++) {
    const src = from.wheels[i]!;
    const dst = to.wheels[i]!;
    dst.steer = src.steer;
    dst.spin = src.spin;
    dst.suspensionLength = src.suspensionLength;
    dst.tireDeflection = src.tireDeflection;
    dst.tireContactNormal.x = src.tireContactNormal.x;
    dst.tireContactNormal.y = src.tireContactNormal.y;
    dst.tireContactNormal.z = src.tireContactNormal.z;
  }
  for (let i = 0; i < 2; i++) {
    to.axles[i]!.rideY = from.axles[i]!.rideY;
    to.axles[i]!.rollAngle = from.axles[i]!.rollAngle;
  }
}

function slerpQuat(
  a: LocalSimulationState['rotation'],
  b: LocalSimulationState['rotation'],
  t: number,
  out: LocalSimulationState['rotation'],
): void {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (dot > 0.9995) {
    out.x = a.x + (bx - a.x) * t;
    out.y = a.y + (by - a.y) * t;
    out.z = a.z + (bz - a.z) * t;
    out.w = a.w + (bw - a.w) * t;
  } else {
    const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
    const sinTheta = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sinTheta;
    const wb = Math.sin(t * theta) / sinTheta;
    out.x = a.x * wa + bx * wb;
    out.y = a.y * wa + by * wb;
    out.z = a.z * wa + bz * wb;
    out.w = a.w * wa + bw * wb;
  }
  const len = Math.hypot(out.x, out.y, out.z, out.w) || 1;
  out.x /= len;
  out.y /= len;
  out.z /= len;
  out.w /= len;
}

interface RemoteProxy {
  id: string;
  build: VehicleBuild;
  buildRevision: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  targetPosition: { x: number; y: number; z: number };
  targetRotation: { x: number; y: number; z: number; w: number };
  recvAtMs: number;
  enabled: boolean;
  linVel: { x: number; y: number; z: number };
  angVel: { x: number; y: number; z: number };
}

// Snapshot timestamps are sampled by the render loop. On a software-rendered
// or heavily loaded client a valid frame can be more than 500 ms apart, so a
// sub-second cutoff made live players briefly non-collidable. Two seconds is
// still short enough to shed a proxy promptly during a genuine network stall.
const REMOTE_PROXY_STALE_MS = 2_000;

export class LocalSimulation {
  private world: Physics.World;
  private vehicle: Physics.VehicleLike;
  private spawn: { position: { x: number; y: number; z: number }; yaw: number };
  private lastSteppedSeq = 0;
  private readonly previous = makeState();
  private readonly current = makeState();
  private readonly rendered = makeState();
  private readonly remoteProxies = new Map<string, RemoteProxy>();
  private workshopMode = false;
  private readonly localPlayerId: string;
  private winchLinks: WinchLinkSnapshot[] = [];
  private winchMotor: WinchMotor = 0;
  private winchRuntimeState: Physics.WinchRuntimeState | null = null;
  private winchRuntimeLinkId: string | null = null;
  private pendingWinchBreak: string | null = null;
  private rutSequence = 0;
  private lastRutStampStep = -1000;
  private rutSide = 0;
  private readonly rutReplica: Physics.RutSessionReplica;

  constructor(
    map: Maps.MapWorld,
    spawn: { position: { x: number; y: number; z: number }; yaw?: number },
    build: VehicleBuild = createStockBuild(),
    localPlayerId = 'local',
  ) {
    this.localPlayerId = localPlayerId;
    this.rutReplica = new Physics.RutSessionReplica(map.terrain.size, localPlayerId);
    this.world = new Physics.World({ map, ruts: this.rutReplica });
    this.spawn = { position: { ...spawn.position }, yaw: spawn.yaw ?? 0 };
    this.vehicle = this.world.spawnVehicle('local', this.spawn, build);
    this.vehicle.body.enableCcd(true);
    this.syncRenderStates();
  }

  dispose(): void {
    this.world.dispose();
  }

  /** Advance the canonical owner simulation by one fixed input tick. */
  step(input: PlayerInput): void {
    if (input.seq <= this.lastSteppedSeq) return;
    copyState(this.current, this.previous);
    if (this.workshopMode) {
      this.lastSteppedSeq = input.seq;
      copyVehicleState(this.vehicle.getState(), this.current);
      return;
    }
    if ((input.buttons & BUTTON_RESET) !== 0) {
      this.vehicle.resetTo(this.spawn);
    } else {
      this.vehicle.setInput(input);
      this.prepareRemoteProxies(performance.now());
      this.applyWinchLoads();
      this.world.step();
      this.ejectIfOutsideWorld();
    }
    this.lastSteppedSeq = input.seq;
    copyVehicleState(this.vehicle.getState(), this.current);
    if ((input.buttons & BUTTON_RESET) !== 0) copyState(this.current, this.previous);
  }

  setWinchLinks(links: readonly WinchLinkSnapshot[]): void {
    this.winchLinks = links.map((link) => ({ ...link, target: link.target.kind === 'obstacle'
      ? { ...link.target, anchor: { ...link.target.anchor } }
      : { ...link.target } }));
    const owned = this.winchLinks.find((link) => link.ownerId === this.localPlayerId);
    if (!owned) {
      this.winchRuntimeState = null;
      this.winchRuntimeLinkId = null;
      this.winchMotor = 0;
    } else if (owned.id !== this.winchRuntimeLinkId) {
      this.winchRuntimeLinkId = owned.id;
      this.winchRuntimeState = {
        cableLength: owned.cableLength,
        tension: owned.tension,
        overloadTime: 0,
        broken: false,
      };
    }
  }

  setWinchMotor(motor: WinchMotor): void {
    this.winchMotor = this.winchRuntimeState ? motor : 0;
  }

  winchRuntime(): WinchRuntimeUpdate | undefined {
    if (!this.winchRuntimeState || !this.winchRuntimeLinkId) return undefined;
    return {
      linkId: this.winchRuntimeLinkId,
      cableLength: this.winchRuntimeState.cableLength,
      motor: this.winchMotor,
      tension: this.winchRuntimeState.tension,
    };
  }

  consumeWinchBreak(): string | null {
    const linkId = this.pendingWinchBreak;
    this.pendingWinchBreak = null;
    return linkId;
  }

  winchTelemetry(): { attached: boolean; cableLength: number; tension: number; motor: WinchMotor; status: string } {
    const owned = this.winchLinks.find((link) => link.ownerId === this.localPlayerId);
    if (!owned || !this.winchRuntimeState) return { attached: false, cableLength: 0, tension: 0, motor: 0, status: '' };
    const tension = this.winchRuntimeState.tension;
    return {
      attached: true,
      cableLength: this.winchRuntimeState.cableLength,
      tension,
      motor: this.winchMotor,
      status: tension >= WINCH.breakForce * 0.99 ? 'OVERLOAD'
        : this.winchMotor === 1 && tension >= WINCH.ratedPull * 0.98 ? 'STALLED'
          : tension > 0 ? 'TAUT' : 'SLACK',
    };
  }

  resetTo(spawn: { position: { x: number; y: number; z: number }; yaw: number }): void {
    this.vehicle.resetTo(spawn);
    this.syncRenderStates();
  }

  enterWorkshop(pose: { position: { x: number; y: number; z: number }; yaw: number }): void {
    this.workshopMode = true;
    this.spawn = { position: { ...pose.position }, yaw: pose.yaw };
    this.vehicle.resetTo(pose);
    this.vehicle.repair?.();
    this.syncRenderStates();
  }

  exitWorkshop(): void {
    this.workshopMode = false;
  }

  applyBuild(build: VehicleBuild, pose: { position: { x: number; y: number; z: number }; yaw: number }): void {
    this.world.removeVehicle('local');
    this.spawn = { position: { ...pose.position }, yaw: pose.yaw };
    this.vehicle = this.world.spawnVehicle('local', this.spawn, build);
    this.vehicle.body.enableCcd(true);
    this.vehicle.repair?.();
    this.syncRenderStates();
  }

  repair(): void {
    this.vehicle.repair?.();
  }

  get spawnPose(): { position: { x: number; y: number; z: number }; yaw: number } {
    return this.spawn;
  }

  /** Full-precision canonical state used for owner telemetry and upload. */
  vehicleState(): VehicleState {
    return this.vehicle.getState();
  }

  /**
   * Install the remote chassis poses the Scene actually drew last frame.
   * Proxies absent from the visual set are removed immediately, so player
   * lifecycle and collision lifecycle cannot drift apart.
   */
  syncRemoteVehicles(states: readonly RemoteCollisionState[], nowMs: number): void {
    const present = new Set<string>();
    for (const state of states) {
      present.add(state.id);
      let proxy = this.remoteProxies.get(state.id);
      if (proxy && proxy.buildRevision !== state.buildRevision) {
        this.removeRemoteProxy(state.id, proxy);
        proxy = undefined;
      }
      if (!proxy) {
        proxy = this.createRemoteProxy(state);
        this.remoteProxies.set(state.id, proxy);
      }
      proxy.targetPosition.x = state.position.x;
      proxy.targetPosition.y = state.position.y;
      proxy.targetPosition.z = state.position.z;
      proxy.targetRotation.x = state.rotation.x;
      proxy.targetRotation.y = state.rotation.y;
      proxy.targetRotation.z = state.rotation.z;
      proxy.targetRotation.w = state.rotation.w;
      proxy.linVel = { ...state.linVel };
      proxy.angVel = { ...state.angVel };
      proxy.recvAtMs = state.recvAtMs;
      const fresh = !state.workshopMode && nowMs - state.recvAtMs <= REMOTE_PROXY_STALE_MS;
      if (!fresh && proxy.enabled) {
        proxy.collider.setEnabled(false);
        proxy.enabled = false;
      }
      if (fresh && !proxy.enabled) {
        proxy.body.setTranslation(proxy.targetPosition, true);
        proxy.body.setRotation(proxy.targetRotation, true);
        proxy.collider.setEnabled(true);
        proxy.enabled = true;
      }
    }
    for (const [id, proxy] of this.remoteProxies) {
      if (!present.has(id)) this.removeRemoteProxy(id, proxy);
    }
  }

  /** Diagnostics for integration tests and the development console. */
  get remoteProxyCount(): number {
    return this.remoteProxies.size;
  }

  get activeRemoteProxyCount(): number {
    let count = 0;
    for (const proxy of this.remoteProxies.values()) if (proxy.enabled) count += 1;
    return count;
  }

  telemetry(): {
    speed: number; rpm: number; gear: number; throttle: number;
    drivetrain: VehicleState['drivetrain']; damage: VehicleState['damage']; notice: string | null;
  } {
    const s = this.vehicle.getState();
    return {
      speed: Math.hypot(s.linVel.x, s.linVel.z),
      rpm: s.rpm,
      gear: s.gear,
      throttle: s.throttle,
      drivetrain: s.drivetrain,
      damage: s.damage,
      notice: this.vehicle.consumeDrivetrainNotice?.() ?? null,
    };
  }

  /** Water state of the owned truck, for the HUD and the spray effects.
   *
   *  Read from the owner simulation rather than from a snapshot because
   *  it is deliberately not on the wire — the local truck is the only one
   *  whose flood state anyone needs to a tick's accuracy. */
  waterStatus(): Physics.WaterStatus {
    return this.vehicle.waterStatus?.() ?? {
      submerged: 0,
      wheelDepths: [0, 0, 0, 0],
      intakeSubmerged: false,
      drowned: false,
      flood: 0,
    };
  }

  pressureStatus(): Physics.PressureStatus {
    return this.vehicle.pressureStatus?.() ?? {
      currentPsi: 34, nominalPsi: 34, minPsi: 20, maxPsi: 42,
      adjusting: 0, reason: null,
    };
  }

  createRutStampCandidate(): Physics.PredictedRutStamp | null {
    // Seven fixed ticks (116.7 ms) leaves delivery jitter headroom under the
    // server's strict 10 Hz receipt-time gate; a six-tick cadence can arrive
    // a fraction under 100 ms and strand an unacknowledged predicted stamp.
    if (this.lastSteppedSeq - this.lastRutStampStep < 7) return null;
    const telemetry = this.vehicle.debugTelemetry?.();
    if (!telemetry) return null;
    let selected: Physics.WheelDebugTelemetry | null = null;
    for (let wheelIndex = this.rutSide; wheelIndex < telemetry.wheels.length; wheelIndex += 2) {
      const wheel = telemetry.wheels[wheelIndex]!;
      const soil = Physics.surfaceInfo(wheel.surface).traction.soil;
      if (!wheel.contact || soil === 'none' || Math.abs(wheel.slipRatio) < 0.15 || wheel.normalLoad < 100) continue;
      if (!selected || wheel.slipWork > selected.slipWork) selected = wheel;
    }
    if (!selected) return null;
    this.rutSide = 1 - this.rutSide;
    const q = telemetry.rotation;
    const forwardX = 2 * (q.x * q.z + q.w * q.y);
    const forwardZ = 1 - 2 * (q.x * q.x + q.y * q.y);
    const pressure = this.pressureStatus();
    const footprintScale = Math.sqrt(pressure.nominalPsi / Math.max(4, pressure.currentPsi));
    const maxSink = Physics.surfaceInfo(selected.surface).traction.soil === 'deep-mud' ? 0.38 : 0.18;
    const disturbance = Math.min(1, selected.sinkDepth / maxSink);
    const work = Math.min(1, selected.slipWork / 4_000);
    const pressureDepthScale = (pressure.currentPsi / pressure.nominalPsi) ** 0.35;
    const wheelWidth = Physics.geomFor(this.vehicle.build).wheelWidth;
    const stamp: Physics.PredictedRutStamp = {
      ownerSequence: ++this.rutSequence,
      x: selected.contactPoint.x,
      z: selected.contactPoint.z,
      heading: Math.atan2(forwardX, forwardZ),
      radiusLong: Math.min(1.5, Math.max(0.25, telemetry.wheelRadius * 0.75 * footprintScale)),
      radiusLat: Math.min(0.8, Math.max(0.125, wheelWidth * 0.55 * footprintScale)),
      depth: Math.min(0.04, Math.max(0.001,
        selected.normalLoad / 12_000
          * Math.abs(selected.slipRatio)
          * pressureDepthScale
          * (0.35 + disturbance * 0.65)
          * (0.2 + work * 0.8)
          * 0.012)),
    };
    this.rutReplica.predict(stamp);
    this.lastRutStampStep = this.lastSteppedSeq;
    return stamp;
  }

  applyRutTile(tile: Physics.RutTilePayload): void {
    this.rutReplica.applyTile(tile);
  }

  applyRutStamps(stamps: readonly Physics.RutStamp[]): void {
    this.rutReplica.applyAuthoritative(stamps);
  }

  resolveRutStamp(ownerSequence: number, accepted: boolean, globalSequence?: number): void {
    this.rutReplica.resolve(ownerSequence, accepted, globalSequence);
  }

  /** High-rate owner-only values consumed by the `?dev` tuning UI. */
  debugTelemetry(): Physics.VehicleDebugTelemetry | null {
    return this.vehicle.debugTelemetry?.() ?? null;
  }

  /** Smooth render state between the two completed physics ticks. */
  state(alpha = 1): LocalSimulationState {
    const t = Math.max(0, Math.min(1, alpha));
    const a = this.previous;
    const b = this.current;
    const out = this.rendered;
    out.position.x = a.position.x + (b.position.x - a.position.x) * t;
    out.position.y = a.position.y + (b.position.y - a.position.y) * t;
    out.position.z = a.position.z + (b.position.z - a.position.z) * t;
    slerpQuat(a.rotation, b.rotation, t, out.rotation);
    for (let i = 0; i < 4; i++) {
      const aw = a.wheels[i]!;
      const bw = b.wheels[i]!;
      const ow = out.wheels[i]!;
      ow.steer = aw.steer + (bw.steer - aw.steer) * t;
      ow.spin = aw.spin + (bw.spin - aw.spin) * t;
      ow.suspensionLength = aw.suspensionLength + (bw.suspensionLength - aw.suspensionLength) * t;
      ow.tireDeflection = aw.tireDeflection + (bw.tireDeflection - aw.tireDeflection) * t;
      const nx = aw.tireContactNormal.x + (bw.tireContactNormal.x - aw.tireContactNormal.x) * t;
      const ny = aw.tireContactNormal.y + (bw.tireContactNormal.y - aw.tireContactNormal.y) * t;
      const nz = aw.tireContactNormal.z + (bw.tireContactNormal.z - aw.tireContactNormal.z) * t;
      const nl = Math.hypot(nx, ny, nz) || 1;
      ow.tireContactNormal.x = nx / nl;
      ow.tireContactNormal.y = ny / nl;
      ow.tireContactNormal.z = nz / nl;
    }
    for (let i = 0; i < 2; i++) {
      const aa = a.axles[i]!;
      const ba = b.axles[i]!;
      const oa = out.axles[i]!;
      oa.rideY = aa.rideY + (ba.rideY - aa.rideY) * t;
      oa.rollAngle = aa.rollAngle + (ba.rollAngle - aa.rollAngle) * t;
    }
    return out;
  }

  private syncRenderStates(): void {
    copyVehicleState(this.vehicle.getState(), this.current);
    copyState(this.current, this.previous);
    copyState(this.current, this.rendered);
  }

  private createRemoteProxy(state: RemoteCollisionState): RemoteProxy {
    const geom = Physics.geomFor(state.build);
    const ext = geom.chassisHalfExtents;
    const radius = VEHICLE.chassisColliderRadius;
    const colliderHalfHeight = (geom.spec.collisionRoofY + ext.y) * 0.5;
    const colliderOffsetY = -ext.y + colliderHalfHeight;
    const body = this.world.world.createRigidBody(
      this.world.rapier.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(state.position.x, state.position.y, state.position.z)
        .setRotation(state.rotation),
    );
    const collider = this.world.world.createCollider(
      this.world.rapier.ColliderDesc.roundCuboid(
        ext.x - radius,
        colliderHalfHeight - radius,
        ext.z - radius,
        radius,
      )
        .setTranslation(0, colliderOffsetY, 0)
        .setFriction(0.2)
        .setRestitution(0.02)
        .setCollisionGroups(Physics.COLLISION_GROUP_REMOTE_PROXY),
      body,
    );
    return {
      id: state.id,
      build: state.build,
      buildRevision: state.buildRevision,
      body,
      collider,
      targetPosition: { ...state.position },
      targetRotation: { ...state.rotation },
      recvAtMs: state.recvAtMs,
      enabled: true,
      linVel: { ...state.linVel },
      angVel: { ...state.angVel },
    };
  }

  private applyWinchLoads(): void {
    const localState = this.vehicle.getState();
    const localGeom = Physics.geomFor(this.vehicle.build);
    for (const link of this.winchLinks) {
      const owns = link.ownerId === this.localPlayerId;
      const targets = link.target.kind === 'vehicle' && link.target.playerId === this.localPlayerId;
      if (!owns && !targets) continue;

      const source = owns
        ? endpointForState(localState, localGeom.recoveryPoints.fairlead)
        : this.remoteEndpoint(link.ownerId, 'fairlead');
      const target = link.target.kind === 'obstacle'
        ? { position: link.target.anchor, velocity: { x: 0, y: 0, z: 0 } }
        : targets
          ? endpointForState(localState, localGeom.recoveryPoints[link.target.point])
          : this.remoteEndpoint(link.target.playerId, link.target.point);
      if (!source || !target) continue;
      const cableLength = owns && this.winchRuntimeState && this.winchRuntimeLinkId === link.id
        ? this.winchRuntimeState.cableLength : link.cableLength;
      const force = Physics.computeWinchForce(source, target, cableLength);
      if (owns && this.winchRuntimeState && this.winchRuntimeLinkId === link.id) {
        this.winchRuntimeState = Physics.stepWinchRuntime(this.winchRuntimeState, this.winchMotor, force.demand);
        if (this.winchRuntimeState.broken) {
          this.pendingWinchBreak = link.id;
          this.winchMotor = 0;
        }
      }
      if (force.tension <= 0) continue;
      const sign = owns ? 1 : -1;
      this.vehicle.queueExternalPointLoad({
        point: owns ? source.position : target.position,
        force: {
          x: force.direction.x * force.tension * sign,
          y: force.direction.y * force.tension * sign,
          z: force.direction.z * force.tension * sign,
        },
      });
    }
  }

  private remoteEndpoint(id: string, point: 'fairlead' | 'front' | 'rear'): Physics.WinchEndpoint | null {
    const proxy = this.remoteProxies.get(id);
    if (!proxy?.enabled) return null;
    const local = Physics.geomFor(proxy.build).recoveryPoints[point];
    return {
      position: Physics.transformPoint(local, proxy.targetPosition, proxy.targetRotation),
      velocity: Physics.pointVelocity(local, proxy.targetRotation, proxy.linVel, proxy.angVel),
    };
  }

  private prepareRemoteProxies(nowMs: number): void {
    for (const proxy of this.remoteProxies.values()) {
      if (nowMs - proxy.recvAtMs > REMOTE_PROXY_STALE_MS) {
        if (proxy.enabled) {
          proxy.collider.setEnabled(false);
          proxy.enabled = false;
        }
        continue;
      }
      if (!proxy.enabled) continue;
      proxy.body.setNextKinematicTranslation(proxy.targetPosition);
      proxy.body.setNextKinematicRotation(proxy.targetRotation);
    }
  }

  private removeRemoteProxy(id: string, proxy: RemoteProxy): void {
    this.world.world.removeRigidBody(proxy.body);
    this.remoteProxies.delete(id);
  }

  /** Preserve the old playful map-edge safety net, now at the owner. */
  private ejectIfOutsideWorld(): void {
    const t = this.vehicle.body.translation();
    const half = this.world.terrain.size * 0.5;
    const offX = Math.abs(t.x) > half;
    const offZ = Math.abs(t.z) > half;
    if (!offX && !offZ) return;
    const len = Math.hypot(t.x, t.z) || 1;
    this.vehicle.body.setLinvel(
      { x: (-t.x / len) * 40, y: 35, z: (-t.z / len) * 40 },
      true,
    );
    this.vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (t.y < -8) {
      this.vehicle.body.setTranslation({ x: t.x, y: 5, z: t.z }, true);
    }
  }
}

function endpointForState(
  state: VehicleState,
  local: { x: number; y: number; z: number },
): Physics.WinchEndpoint {
  return {
    position: Physics.transformPoint(local, state.position, state.rotation),
    velocity: Physics.pointVelocity(local, state.rotation, state.linVel, state.angVel),
  };
}
