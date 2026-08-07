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
  type CarKind,
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

/** A wheel must out-run the chassis by this much (m/s) before it is
 *  considered to be spinning rather than rolling. */
const SLIP_THRESHOLD = 1.5;

export class VehicleEffects {
  readonly group = new THREE.Group();
  private particles = new ParticleSystem();
  private terrain: Physics.TerrainData | null = null;
  private lastSnapMs = -1;

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
      this.spawnMud(p.carKind, p.vehicle, pose);
    }
  }

  private spawnMud(carKind: CarKind, vehicle: VehicleState, pose: EffectPose): void {
    const terrain = this.terrain!;
    const wheelPositions = Physics.restWheelPositions(carKind);
    const groundSpeed = Math.hypot(vehicle.linVel.x, vehicle.linVel.z);
    const t = pose.position;
    const q = pose.quaternion;
    for (let i = 0; i < 4; i++) {
      const wheelSnap = vehicle.wheels[i];
      if (!wheelSnap || !wheelSnap.contact) continue;
      // angVel is on the wire per wheel (rad/s); deriving a rate from
      // consecutive spin values doesn't work because spin is wrapped
      // mod 2pi for transport and aliases at speed.
      const wheelLin = Math.abs(wheelSnap.angVel) * VEHICLE.wheelRadius;
      if (wheelLin <= groundSpeed + SLIP_THRESHOLD) continue;
      // World-space wheel contact point: rotate the local wheel position
      // (lowered slightly so particles emit near the ground) by the
      // chassis quaternion, then add the chassis world position.
      const wp = wheelPositions[i]!;
      const local = { x: wp.x, y: wp.y - VEHICLE.wheelRadius * 0.6, z: wp.z };
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
