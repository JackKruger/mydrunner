// Ground-response visuals for every vehicle on screen: mud thrown by a
// spinning wheel, and the visual sink of an axle into soft ground.
//
// Extracted from Scene, which was 670 lines and owned the particle pool,
// the emit heuristics and the sink lookup on top of interpolation, camera
// handoff and the minimap. None of that is snapshot buffering, and a
// second effect family (water spray) would have made the biggest file in
// the client bigger still.
//
// Everything here is purely visual: no physics, no networking.

import * as THREE from 'three';
import {
  VEHICLE,
  Physics,
  type VehicleBuild,
  type PlayerId,
  type VehicleState,
  type WorldSnapshot,
} from '@mydrunner/shared';
import { ParticleSystem } from './particles.js';

/** The drawn pose of one vehicle. THREE.Group satisfies this structurally,
 *  which is the point — this module never learns what a VehicleVisual is. */
export interface EffectPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export type PoseLookup = (id: PlayerId) => EffectPose | null;

const MUD_COLOR = 0x3a2618;
const DEEP_MUD_COLOR = 0x1a0d05;
const SPRAY_COLOR = 0xd8e8ee;
const FOAM_COLOR = 0xf0f6f8;
const SMOKE_COLOR = 0x55585b;

/** A wheel must out-run the chassis by this much (m/s) before it is
 *  considered to be spinning rather than rolling. */
const SLIP_THRESHOLD = 1.5;

/** Preview-mode emit cadence, matching the online snapshot rate so the
 *  two look the same. */
const LOCAL_EMIT_INTERVAL_MS = 1000 / 30;

/** Below this ground speed a wheel in water makes ripples, not spray. */
const SPRAY_MIN_SPEED = 1.2;

/** Past this depth the wheel is submerged rather than ploughing, and a
 *  submerged wheel throws nothing — the spray comes off the waterline. */
const SPRAY_MAX_DEPTH = 0.9;

export class VehicleEffects {
  readonly group = new THREE.Group();
  private particles = new ParticleSystem();
  private terrain: Physics.TerrainData | null = null;
  private lastSnapMs = -1;
  private lastLocalMs = -1;

  constructor() {
    this.group.add(this.particles.group);
  }

  setTerrain(t: Physics.TerrainData | null): void {
    this.terrain = t;
  }

  /** Emit for one snapshot's worth of players.
   *
   *  The `recvAtMs` gate lives in here rather than at the call site on
   *  purpose: emission has to be driven by snapshot arrival, not by frame
   *  rate, or a 120 Hz client throws four times the particles of a 30 Hz
   *  one. Keeping the rule next to the emit code means a future caller
   *  cannot forget it. */
  spawnFromSnapshot(snap: WorldSnapshot, recvAtMs: number, poseOf: PoseLookup): void {
    if (!this.terrain || recvAtMs === this.lastSnapMs) return;
    this.lastSnapMs = recvAtMs;
    for (const p of snap.players) {
      const pose = poseOf(p.id);
      if (!pose) continue;
      this.spawnFor(p.build, p.vehicle, pose);
    }
  }

  /** Emit for the locally owned truck when there is no snapshot stream at
   *  all — the offline editor preview.
   *
   *  Without this the whole effects path is unreachable in preview mode,
   *  because it hangs off snapshot arrival. You could author a river,
   *  hit Preview, drive through it and see nothing.
   *
   *  Rate-limited on wall clock at the snapshot rate rather than gated on
   *  a snapshot, so preview emits at the same density the online game
   *  does instead of scaling with the display's frame rate. */
  spawnLocal(build: VehicleBuild, vehicle: VehicleState, pose: EffectPose, nowMs: number): void {
    if (!this.terrain) return;
    if (nowMs - this.lastLocalMs < LOCAL_EMIT_INTERVAL_MS) return;
    this.lastLocalMs = nowMs;
    this.spawnFor(build, vehicle, pose);
  }

  private spawnFor(build: VehicleBuild, vehicle: VehicleState, pose: EffectPose): void {
    this.spawnMud(build, vehicle, pose);
    this.spawnWater(build, vehicle, pose);
    this.spawnDamageSmoke(build, vehicle, pose);
  }

  private spawnDamageSmoke(build: VehicleBuild, vehicle: VehicleState, pose: EffectPose): void {
    if (vehicle.damage.engine > 0.48) return;
    const geom = Physics.geomFor(build);
    const bonnet = Physics.rotateVecByQuat(
      { x: 0, y: geom.chassisHalfExtents.y + 0.35, z: geom.chassisHalfExtents.z * 0.58 },
      { x: pose.quaternion.x, y: pose.quaternion.y, z: pose.quaternion.z, w: pose.quaternion.w },
    );
    const count = vehicle.damage.engine < 0.18 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      this.particles.emit(
        pose.position.x + bonnet.x,
        pose.position.y + bonnet.y,
        pose.position.z + bonnet.z,
        SMOKE_COLOR,
        { spread: 0.35, rise: 0.9, riseVar: 0.5, lifeMs: 700, lifeVarMs: 450, scale: 1.2 },
      );
    }
  }

  /** Wheel spray and the bow wave.
   *
   *  Derived entirely from the transmitted pose against the water height
   *  this client computes from the same map document, so remote trucks
   *  throw spray with no extra field on the wire. */
  private spawnWater(build: VehicleBuild, vehicle: VehicleState, pose: EffectPose): void {
    const terrain = this.terrain!;
    const geom = Physics.geomFor(build);
    const wheelPositions = Physics.restWheelPositions(build);
    const vx = vehicle.linVel.x;
    const vz = vehicle.linVel.z;
    const groundSpeed = Math.hypot(vx, vz);
    if (groundSpeed < SPRAY_MIN_SPEED) return;
    const t = pose.position;
    const q = pose.quaternion;

    for (let i = 0; i < 4; i++) {
      const wp = wheelPositions[i]!;
      const local = { x: wp.x, y: wp.y - geom.wheelRadius * 0.6, z: wp.z };
      const v = Physics.rotateVecByQuat(local, { x: q.x, y: q.y, z: q.z, w: q.w });
      const wx = t.x + v.x;
      const wz = t.z + v.z;
      const depth = Physics.sampleWaterDepth(terrain, wx, wz);
      if (depth <= 0.03) continue;

      const level = Physics.sampleWaterLevel(terrain, wx, wz);
      // Spray leaves the waterline, not the contact patch: a wheel in
      // half a metre of water throws off the surface it is breaking.
      const wy = level;

      // A wheel ploughing shallow water throws the most; once it is
      // fully under, the surface above it barely breaks.
      const plough = 1 - Math.min(1, depth / SPRAY_MAX_DEPTH);
      const intensity = Math.min(1, (groundSpeed - SPRAY_MIN_SPEED) / 6) * plough;
      if (intensity <= 0.05) continue;

      const count = Math.max(1, Math.round(intensity * 3));
      for (let n = 0; n < count; n++) {
        this.particles.emit(wx, wy, wz, SPRAY_COLOR, {
          spread: 1.6,
          rise: 1.2 + intensity * 1.8,
          riseVar: 1.4,
          // Thrown backwards along travel, the way a wheel actually
          // sheets water.
          biasX: -vx * 0.22,
          biasZ: -vz * 0.22,
          lifeMs: 260,
          lifeVarMs: 220,
          scale: 0.75,
        });
      }
    }

    // Bow wave off the front of the chassis while it is pushing water.
    const nose = Physics.rotateVecByQuat(
      { x: 0, y: -0.2, z: geom.chassisHalfExtents.z },
      { x: q.x, y: q.y, z: q.z, w: q.w },
    );
    const nx = t.x + nose.x;
    const nz = t.z + nose.z;
    const noseDepth = Physics.sampleWaterDepth(terrain, nx, nz);
    if (noseDepth > 0.15 && groundSpeed > 2) {
      const level = Physics.sampleWaterLevel(terrain, nx, nz);
      const count = Math.min(3, Math.round(groundSpeed / 4));
      for (let n = 0; n < count; n++) {
        this.particles.emit(nx, level, nz, FOAM_COLOR, {
          spread: 2.4,
          rise: 1.0,
          riseVar: 1.2,
          biasX: vx * 0.14,
          biasZ: vz * 0.14,
          lifeMs: 320,
          lifeVarMs: 260,
          scale: 1.1,
        });
      }
    }
  }

  private spawnMud(build: VehicleBuild, vehicle: VehicleState, pose: EffectPose): void {
    const terrain = this.terrain!;
    const geom = Physics.geomFor(build);
    const wheelPositions = Physics.restWheelPositions(build);
    const groundSpeed = Math.hypot(vehicle.linVel.x, vehicle.linVel.z);
    const t = pose.position;
    const q = pose.quaternion;
    for (let i = 0; i < 4; i++) {
      const wheelSnap = vehicle.wheels[i];
      if (!wheelSnap || !wheelSnap.contact) continue;
      // angVel is on the wire per wheel (rad/s); deriving a rate from
      // consecutive spin values doesn't work because spin is wrapped
      // mod 2pi for transport and aliases at speed.
      const wheelLin = Math.abs(wheelSnap.angVel) * geom.wheelRadius;
      if (wheelLin <= groundSpeed + SLIP_THRESHOLD) continue;
      // World-space wheel contact point: rotate the local wheel position
      // (lowered slightly so particles emit near the ground) by the
      // chassis quaternion, then add the chassis world position.
      const wp = wheelPositions[i]!;
      const local = { x: wp.x, y: wp.y - geom.wheelRadius * 0.6, z: wp.z };
      const v = Physics.rotateVecByQuat(local, { x: q.x, y: q.y, z: q.z, w: q.w });
      const wx = t.x + v.x;
      const wy = t.y + v.y;
      const wz = t.z + v.z;

      const surf = Physics.sampleSurface(terrain, wx, wz);
      if (surf !== Physics.Surface.Mud && surf !== Physics.Surface.DeepMud) continue;
      const color = surf === Physics.Surface.DeepMud ? DEEP_MUD_COLOR : MUD_COLOR;
      // Spawn intensity scales with how much faster the wheel is than the ground.
      const excess = wheelLin - groundSpeed;
      const count = Math.min(3, Math.max(1, Math.floor(excess / 4)));
      for (let n = 0; n < count; n++) this.particles.emit(wx, wy, wz, color);
    }
  }

  /** How far below its physics-resolved position an axle visual should
   *  drop because the ground beneath it is soft (mud). Both wheels of a
   *  solid axle share the beam, so the sink applies to the whole axle -
   *  one wheel digging in pulls its partner down too, matching the rigid
   *  coupling. Pure visual; the chassis still rides at its
   *  physics-determined height. Returns 0 on road / dirt. */
  axleSink(pose: EffectPose, anchor: { centerLocalY: number; centerLocalZ: number }): number {
    if (!this.terrain) return 0;
    const q = pose.quaternion;
    // Sample at the axle centre - in chassis-local that's (0, anchor.centerLocalY, anchor.centerLocalZ).
    const local = { x: 0, y: anchor.centerLocalY, z: anchor.centerLocalZ };
    const w = Physics.rotateVecByQuat(local, { x: q.x, y: q.y, z: q.z, w: q.w });
    const surf = Physics.sampleSurface(
      this.terrain,
      pose.position.x + w.x,
      pose.position.z + w.z,
    );
    if (surf === Physics.Surface.Mud) return VEHICLE.wheelRadius * 0.18;
    if (surf === Physics.Surface.DeepMud) return VEHICLE.wheelRadius * 0.35;
    return 0;
  }

  update(frameDtMs: number): void {
    this.particles.update(frameDtMs);
  }

  dispose(): void {
    this.particles.dispose();
    this.group.clear();
  }
}
