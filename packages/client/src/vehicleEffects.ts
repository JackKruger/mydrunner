// Ground-response visuals for every vehicle on screen: surface-aware plumes
// and tyre marks, plus the visual sink of an axle into soft ground.
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
import { activeQuality, type QualitySettings } from './quality.js';
import { TyreTrackSystem } from './tyreTracks.js';

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

interface GroundEffectStyle {
  color: number;
  maxCount: number;
  spread: number;
  rise: number;
  riseVar: number;
  lifeMs: number;
  lifeVarMs: number;
  scale: number;
  gravity: number;
  endScale: number;
  opacity: number;
}

/** Visual response for every driveable surface. Keeping this exhaustive means
 *  adding a surface cannot silently bring back invisible wheelspin. */
const GROUND_EFFECTS: Record<Physics.Surface, GroundEffectStyle> = {
  [Physics.Surface.Road]: {
    color: 0xb5b6b3, maxCount: 3, spread: 0.7, rise: 0.15, riseVar: 0.45,
    lifeMs: 520, lifeVarMs: 280, scale: 0.9, gravity: 0.35, endScale: 2.4, opacity: 0.48,
  },
  [Physics.Surface.Dirt]: {
    color: 0x9b7045, maxCount: 4, spread: 1.5, rise: 0.35, riseVar: 0.8,
    lifeMs: 600, lifeVarMs: 350, scale: 1.05, gravity: -0.8, endScale: 2.1, opacity: 0.68,
  },
  [Physics.Surface.Mud]: {
    color: MUD_COLOR, maxCount: 3, spread: 3, rise: 2, riseVar: 3,
    lifeMs: 600, lifeVarMs: 400, scale: 1, gravity: -9.81, endScale: 0.6, opacity: 1,
  },
  [Physics.Surface.DeepMud]: {
    color: DEEP_MUD_COLOR, maxCount: 4, spread: 2.7, rise: 1.7, riseVar: 2.8,
    lifeMs: 680, lifeVarMs: 420, scale: 1.15, gravity: -9.81, endScale: 0.6, opacity: 1,
  },
  [Physics.Surface.Grass]: {
    color: 0x7a7047, maxCount: 3, spread: 1.3, rise: 0.3, riseVar: 0.7,
    lifeMs: 540, lifeVarMs: 300, scale: 0.9, gravity: -1.3, endScale: 1.8, opacity: 0.62,
  },
  [Physics.Surface.Gravel]: {
    color: 0x918779, maxCount: 4, spread: 1.8, rise: 0.45, riseVar: 1,
    lifeMs: 560, lifeVarMs: 320, scale: 0.9, gravity: -1.8, endScale: 1.7, opacity: 0.7,
  },
  [Physics.Surface.Concrete]: {
    color: 0xc1c2bf, maxCount: 3, spread: 0.65, rise: 0.15, riseVar: 0.4,
    lifeMs: 500, lifeVarMs: 260, scale: 0.85, gravity: 0.4, endScale: 2.3, opacity: 0.44,
  },
};

/** A wheel must out-run the chassis by this much (m/s) before it is
 *  considered to be spinning rather than rolling. */
const SLIP_THRESHOLD = 1.5;

/** At this much excess tread speed the plume has reached full density. */
const FULL_PLUME_EXCESS = 13;

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
  private particles: ParticleSystem;
  private tracks: TyreTrackSystem;
  private terrain: Physics.TerrainData | null = null;
  private lastSnapMs = -1;
  private lastLocalMs = -1;
  private snapshotPlayers = new Set<PlayerId>();

  constructor(quality: QualitySettings = activeQuality()) {
    this.particles = new ParticleSystem(quality);
    // Tracks are one draw call either way, but the ring buffer is drawn in
    // full every frame (frustumCulled is off, since it spans the map), so its
    // size is a triangle budget rather than just memory.
    this.tracks = new TyreTrackSystem(quality.trackSegments);
    this.group.add(this.particles.group);
    this.group.add(this.tracks.group);
  }

  setTerrain(t: Physics.TerrainData | null): void {
    this.terrain = t;
    this.tracks.setTerrain(t);
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
    this.snapshotPlayers.clear();
    for (const p of snap.players) {
      this.snapshotPlayers.add(p.id);
      const pose = poseOf(p.id);
      if (!pose) continue;
      this.spawnFor(p.id, p.build, p.vehicle, pose);
    }
    this.tracks.retainPlayers(this.snapshotPlayers);
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
    this.spawnFor('offline-preview', build, vehicle, pose);
  }

  private spawnFor(
    id: PlayerId,
    build: VehicleBuild,
    vehicle: VehicleState,
    pose: EffectPose,
  ): void {
    this.tracks.sampleVehicle(id, build, vehicle, pose);
    this.spawnWheelspin(build, vehicle, pose);
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
      const axle = i < 2 ? geom.front : geom.rear;
      const suspensionLength = vehicle.wheels[i]?.suspensionLength
        ?? axle.suspensionRestLength;
      const wheel = vehicle.wheels[i];
      const normal = wheel?.tireContactNormal ?? { x: 0, y: 1, z: 0 };
      const loadedRadius = Math.max(0, geom.wheelRadius - (wheel?.tireDeflection ?? 0));
      const local = {
        x: wp.x - normal.x * loadedRadius,
        y: wp.y - suspensionLength - normal.y * loadedRadius,
        z: wp.z - normal.z * loadedRadius,
      };
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

  private spawnWheelspin(build: VehicleBuild, vehicle: VehicleState, pose: EffectPose): void {
    const terrain = this.terrain!;
    const geom = Physics.geomFor(build);
    const wheelPositions = Physics.restWheelPositions(build);
    const groundSpeed = Math.hypot(vehicle.linVel.x, vehicle.linVel.z);
    const t = pose.position;
    const q = pose.quaternion;
    const forward = Physics.rotateVecByQuat(
      { x: 0, y: 0, z: 1 },
      { x: q.x, y: q.y, z: q.z, w: q.w },
    );
    for (let i = 0; i < 4; i++) {
      const wheelSnap = vehicle.wheels[i];
      if (!wheelSnap || !wheelSnap.contact) continue;
      // angVel is on the wire per wheel (rad/s); deriving a rate from
      // consecutive spin values doesn't work because spin is wrapped
      // mod 2pi for transport and aliases at speed.
      const wheelLin = Math.abs(wheelSnap.angVel) * geom.wheelRadius;
      if (wheelLin <= groundSpeed + SLIP_THRESHOLD) continue;
      // restWheelPositions gives the suspension mount, not the hub. Move
      // down by the transmitted spring length and a full tyre radius to
      // reach the ground-facing edge; using only a fraction of the radius
      // put the old plume visibly above the wheel centre.
      const wp = wheelPositions[i]!;
      const loadedRadius = Math.max(0, geom.wheelRadius - wheelSnap.tireDeflection);
      const local = {
        x: wp.x - wheelSnap.tireContactNormal.x * loadedRadius,
        y: wp.y - wheelSnap.suspensionLength - wheelSnap.tireContactNormal.y * loadedRadius,
        z: wp.z - wheelSnap.tireContactNormal.z * loadedRadius,
      };
      const v = Physics.rotateVecByQuat(local, { x: q.x, y: q.y, z: q.z, w: q.w });
      const wx = t.x + v.x;
      const wy = t.y + v.y;
      const wz = t.z + v.z;

      const surf = Physics.sampleSurface(terrain, wx, wz);
      const excess = wheelLin - groundSpeed;
      const intensity = Math.min(1, (excess - SLIP_THRESHOLD) / (FULL_PLUME_EXCESS - SLIP_THRESHOLD));
      const style = GROUND_EFFECTS[surf];
      const count = Math.max(1, Math.ceil(intensity * style.maxCount));

      // Dry dust and tyre smoke should not appear through a water surface.
      // Mud remains visible because a spinning tyre throws the wet bed itself.
      const depth = Physics.sampleWaterDepth(terrain, wx, wz);
      if (depth > 0.03 && surf !== Physics.Surface.Mud && surf !== Physics.Surface.DeepMud) continue;

      // Local +Z is the vehicle's forward direction. Wheelspin ejects material
      // behind the driven tread; reverse wheelspin naturally flips the plume.
      const throwSpeed = (0.55 + intensity * 1.7) * -Math.sign(wheelSnap.angVel);
      for (let n = 0; n < count; n++) {
        this.particles.emit(wx, wy, wz, style.color, {
          spread: style.spread,
          rise: style.rise + intensity * 0.5,
          riseVar: style.riseVar,
          biasX: forward.x * throwSpeed,
          biasZ: forward.z * throwSpeed,
          lifeMs: style.lifeMs,
          lifeVarMs: style.lifeVarMs,
          scale: style.scale * (0.75 + intensity * 0.5),
          gravity: style.gravity,
          endScale: style.endScale,
          opacity: style.opacity,
        });
      }
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
    this.tracks.update(frameDtMs);
  }

  dispose(): void {
    this.particles.dispose();
    this.tracks.dispose();
    this.group.clear();
  }
}
