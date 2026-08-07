// Client-owned vehicle simulation.
//
// The browser is the sole authority for its truck. Network snapshots are
// never fed back into this world: they exist only to render remote players.
// Physics advances at a fixed rate while state(alpha) interpolates the two
// most recent completed steps for a smooth render pose at any display rate.

import {
  VEHICLE,
  Maps,
  Physics,
  type CarKind,
  type PlayerInput,
  type VehicleState,
} from '@mydrunner/shared';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { RemoteCollisionState } from './scene.js';

export interface LocalSimulationState {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  wheels: { steer: number; spin: number; suspensionLength: number }[];
  axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }];
}

function makeState(): LocalSimulationState {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    wheels: [
      { steer: 0, spin: 0, suspensionLength: 0 },
      { steer: 0, spin: 0, suspensionLength: 0 },
      { steer: 0, spin: 0, suspensionLength: 0 },
      { steer: 0, spin: 0, suspensionLength: 0 },
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
  }
  const axles = from.axles;
  if (axles) {
    to.axles[0].rideY = axles[0].rideY;
    to.axles[0].rollAngle = axles[0].rollAngle;
    to.axles[1].rideY = axles[1].rideY;
    to.axles[1].rollAngle = axles[1].rollAngle;
  }
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
  carKind: CarKind;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  targetPosition: { x: number; y: number; z: number };
  targetRotation: { x: number; y: number; z: number; w: number };
  recvAtMs: number;
  enabled: boolean;
}

const REMOTE_PROXY_STALE_MS = 500;

export class LocalSimulation {
  private world: Physics.World;
  private vehicle: Physics.VehicleLike;
  private spawn: { position: { x: number; y: number; z: number }; yaw: number };
  private lastSteppedSeq = 0;
  private readonly previous = makeState();
  private readonly current = makeState();
  private readonly rendered = makeState();
  private readonly remoteProxies = new Map<string, RemoteProxy>();

  constructor(
    map: Maps.MapWorld,
    spawn: { position: { x: number; y: number; z: number }; yaw?: number },
    carKind: CarKind = 'patrol',
  ) {
    this.world = new Physics.World({ map });
    this.spawn = { position: { ...spawn.position }, yaw: spawn.yaw ?? 0 };
    this.vehicle = this.world.spawnVehicle('local', this.spawn, carKind);
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
    if ((input.buttons & 1) !== 0) {
      this.vehicle.resetTo(this.spawn);
    } else {
      this.vehicle.setInput(input);
      this.prepareRemoteProxies(performance.now());
      this.world.step();
      this.ejectIfOutsideWorld();
    }
    this.lastSteppedSeq = input.seq;
    copyVehicleState(this.vehicle.getState(), this.current);
    if ((input.buttons & 1) !== 0) copyState(this.current, this.previous);
  }

  resetTo(spawn: { position: { x: number; y: number; z: number }; yaw: number }): void {
    this.vehicle.resetTo(spawn);
    this.syncRenderStates();
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
      if (proxy && proxy.carKind !== state.carKind) {
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
      proxy.recvAtMs = state.recvAtMs;
      const fresh = nowMs - state.recvAtMs <= REMOTE_PROXY_STALE_MS;
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

  telemetry(): { speed: number; rpm: number; gear: number; throttle: number } {
    const s = this.vehicle.getState();
    return {
      speed: Math.hypot(s.linVel.x, s.linVel.z),
      rpm: s.rpm,
      gear: s.gear,
      throttle: s.throttle,
    };
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
    const geom = Physics.geomFor(state.carKind);
    const ext = geom.chassisHalfExtents;
    const radius = VEHICLE.chassisColliderRadius;
    const colliderHalfHeight = (VEHICLE.cabinRoofY + ext.y) * 0.5;
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
      carKind: state.carKind,
      body,
      collider,
      targetPosition: { ...state.position },
      targetRotation: { ...state.rotation },
      recvAtMs: state.recvAtMs,
      enabled: true,
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
    const offX = Math.abs(t.x) > half - 6;
    const offZ = Math.abs(t.z) > half - 6;
    const fellThrough = t.y < -8;
    if (!offX && !offZ && !fellThrough) return;
    const len = Math.hypot(t.x, t.z) || 1;
    this.vehicle.body.setLinvel(
      { x: (-t.x / len) * 40, y: 35, z: (-t.z / len) * 40 },
      true,
    );
    this.vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (fellThrough) {
      this.vehicle.body.setTranslation({ x: t.x, y: 5, z: t.z }, true);
    }
  }
}
