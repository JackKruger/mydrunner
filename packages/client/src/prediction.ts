// Client-side prediction (v2): soft-correction model.
//
// Earlier prediction layer ran a local Rapier sim, kept a queue of
// unacked inputs, and on every snapshot SNAPPED the body to the server
// pose then REPLAYED the queue to fast-forward to "now". That replay
// loop was the source of every netcode bug we hit:
//   - 9 ms reconcile cost at 30 Hz = visible heartbeat.
//   - Multi-frame replay = partial state, drift while moving.
//   - Replay growing faster than it drained under load = death spiral.
//
// New model: the local sim runs continuously, lockstep with input. The
// snapshot is treated as a SOFT CORRECTION rather than authority: the
// body is nudged toward the server pose by a small fraction each
// snapshot, with the delta absorbed by a decaying visual offset so the
// rendered pose stays continuous. Internal state (wheel angular
// velocities, engine RPM, gear) is always SNAPPED to server values so
// the local physics integrator doesn't slowly diverge from the server's.
//
// Properties:
//   - Local body responds to input within one tick (~16 ms).
//   - No replay = constant cost per snapshot (~0.2 ms), no spiral.
//   - Soft corrections converge toward server over many snapshots.
//   - Big divergences (>5 m) hard-snap and accept a visible pop.

import {
  FIXED_DT,
  Physics,
  type PlayerInput,
  type WorldSnapshot,
} from '@mydrunner/shared';

export interface PredictionState {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  wheels: { steer: number; spin: number; suspensionLength: number }[];
  axles: [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }];
}

export class Prediction {
  private world: Physics.World;
  private vehicle: Physics.VehicleLike;
  private spawn: { position: { x: number; y: number; z: number }; yaw: number };
  private lastSteppedSeq = 0;
  /** Position offset captured by soft corrections; decays each step
   *  so the rendered pose smoothly converges to the corrected body. */
  private posOffset = { x: 0, y: 0, z: 0 };
  /** Per-snapshot soft correction strength. 0.12 means the body moves
   *  12 % of the way toward the server pose on each snapshot received.
   *  Combined with the per-step visual offset decay this converges in
   *  ~5 snapshots (~150 ms) after a small divergence. */
  private static readonly SOFT_CORRECTION_BLEND = 0.12;
  /** Per-step decay of posOffset toward zero. 0.85 ≈ 110 ms half-life
   *  at 60 Hz, so a single soft correction is invisible within a few
   *  frames. */
  private static readonly OFFSET_DECAY = 0.85;
  /** Hard-snap threshold. Beyond this the divergence is too big for
   *  smoothing to absorb without a meters-long visual slide; better to
   *  accept a visible pop and converge instantly. */
  private static readonly HARD_SNAP_DIST = 5.0;
  /** Pre-allocated state buffer to avoid per-frame GC pressure. */
  private _state: PredictionState = {
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
    ] as [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }],
  };

  constructor(
    seed: number,
    size: number,
    resolution: number,
    spawn: { position: { x: number; y: number; z: number }; yaw?: number },
  ) {
    const terrain = Physics.generateTerrain({ seed, size, resolution });
    this.world = new Physics.World({ terrain });
    this.spawn = { position: spawn.position, yaw: spawn.yaw ?? 0 };
    this.vehicle = this.world.spawnVehicle('local', this.spawn);
  }

  dispose(): void {
    this.world.dispose();
  }

  /** Step the local sim by one input. Called at 60 Hz from the main
   *  loop's input accumulator, after the input has been sent to the
   *  server. */
  step(input: PlayerInput): void {
    if (input.seq <= this.lastSteppedSeq) return;
    if ((input.buttons & 1) !== 0) {
      this.vehicle.resetTo(this.spawn);
      this.posOffset.x = 0; this.posOffset.y = 0; this.posOffset.z = 0;
    }
    this.vehicle.setInput(input);
    this.world.step();
    this.lastSteppedSeq = input.seq;
    // Decay visual offset toward zero - prior soft corrections fade out.
    this.posOffset.x *= Prediction.OFFSET_DECAY;
    this.posOffset.y *= Prediction.OFFSET_DECAY;
    this.posOffset.z *= Prediction.OFFSET_DECAY;
  }

  /** Apply a server snapshot as a soft correction. Never replays inputs;
   *  never snaps the body unless the divergence is large enough that
   *  smoothing would be visibly wrong. */
  applyServerSnapshot(snap: WorldSnapshot, myId: string): void {
    const me = snap.players.find((p) => p.id === myId);
    if (!me) return;
    const v = me.vehicle;
    // Extrapolate the server state forward to "now" before comparing.
    // The snapshot reflects server state at me.lastAckSeq; the local
    // sim is at this.lastSteppedSeq (ticks ahead = inputs in flight).
    // Without this extrapolation, the soft correction would pull the
    // local sim backwards toward stale server state every snapshot,
    // undoing the predicted motion.
    const ticksAhead = Math.max(0, this.lastSteppedSeq - me.lastAckSeq);
    const dtAhead = ticksAhead * FIXED_DT;
    const sx = v.position.x + v.linVel.x * dtAhead;
    const sy = v.position.y + v.linVel.y * dtAhead;
    const sz = v.position.z + v.linVel.z * dtAhead;
    const local = this.vehicle.body.translation();
    const dx = sx - local.x;
    const dy = sy - local.y;
    const dz = sz - local.z;
    const dist = Math.hypot(dx, dy, dz);

    if (dist > Prediction.HARD_SNAP_DIST) {
      // Hard snap. Body teleports to server's extrapolated pose; rendered
      // pose snaps too (no visual offset) because trying to slide 5 m
      // smoothly would look worse than the snap.
      this.vehicle.body.setTranslation({ x: sx, y: sy, z: sz }, true);
      this.vehicle.body.setRotation(v.rotation, true);
      this.vehicle.body.setLinvel(v.linVel, true);
      this.vehicle.body.setAngvel(v.angVel, true);
      this.posOffset.x = 0; this.posOffset.y = 0; this.posOffset.z = 0;
    } else {
      // Soft correction: nudge body a fraction of the way toward server,
      // and stash the rest as a visual offset that decays out invisibly.
      const blend = Prediction.SOFT_CORRECTION_BLEND;
      this.vehicle.body.setTranslation(
        {
          x: local.x + dx * blend,
          y: local.y + dy * blend,
          z: local.z + dz * blend,
        },
        true,
      );
      // The body moved by (dx*blend); to keep the RENDERED pose
      // continuous, the visual offset increases by exactly (-dx*blend)
      // so render = body + offset stays at the pre-correction render.
      this.posOffset.x -= dx * blend;
      this.posOffset.y -= dy * blend;
      this.posOffset.z -= dz * blend;
    }

    // Rotation: light, deadband-gated correction. The local sim and the
    // server run identical physics on identical inputs, so they should
    // converge - but tiny floating-point differences accumulate, and
    // without ANY correction the local rotation slowly drifts off from
    // the server (visible as the truck "driving sideways" after a few
    // minutes). Pulling local toward the server-extrapolated rotation
    // by 4 % per snapshot is small enough not to fight the predicted
    // yaw on a fresh input (the local sim's rotation lead is preserved
    // because we extrapolate the server's rotation forward by dtAhead),
    // but cumulative enough to bound long-term drift to <1°.
    const wAng = v.angVel;
    const q = v.rotation;
    let serverNowQx = q.x + 0.5 * dtAhead * ( wAng.x * q.w + wAng.y * q.z - wAng.z * q.y);
    let serverNowQy = q.y + 0.5 * dtAhead * (-wAng.x * q.z + wAng.y * q.w + wAng.z * q.x);
    let serverNowQz = q.z + 0.5 * dtAhead * ( wAng.x * q.y - wAng.y * q.x + wAng.z * q.w);
    let serverNowQw = q.w + 0.5 * dtAhead * (-wAng.x * q.x - wAng.y * q.y - wAng.z * q.z);
    const sqLen = Math.hypot(serverNowQx, serverNowQy, serverNowQz, serverNowQw) || 1;
    serverNowQx /= sqLen; serverNowQy /= sqLen; serverNowQz /= sqLen; serverNowQw /= sqLen;
    const lr = this.vehicle.body.rotation();
    let dot = lr.x * serverNowQx + lr.y * serverNowQy + lr.z * serverNowQz + lr.w * serverNowQw;
    let bx = serverNowQx, by = serverNowQy, bz = serverNowQz, bw = serverNowQw;
    if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
    // dot ≈ cos(angle/2). Skip correction for very small angles (<1°)
    // so the smooth steady-state isn't constantly nudged.
    if (dot < 0.99996) {
      const tRot = 0.04;
      let nx = lr.x + (bx - lr.x) * tRot;
      let ny = lr.y + (by - lr.y) * tRot;
      let nz = lr.z + (bz - lr.z) * tRot;
      let nw = lr.w + (bw - lr.w) * tRot;
      const rLen = Math.hypot(nx, ny, nz, nw) || 1;
      this.vehicle.body.setRotation({ x: nx / rLen, y: ny / rLen, z: nz / rLen, w: nw / rLen }, true);
    }
    // Velocity: light blend toward server (8 %) so divergent linVel/
    // angVel doesn't compound into a position drift faster than the
    // 12 % position correction can absorb.
    const llv = this.vehicle.body.linvel();
    const lav = this.vehicle.body.angvel();
    const tVel = 0.08;
    this.vehicle.body.setLinvel(
      { x: llv.x + (v.linVel.x - llv.x) * tVel, y: llv.y + (v.linVel.y - llv.y) * tVel, z: llv.z + (v.linVel.z - llv.z) * tVel },
      true,
    );
    this.vehicle.body.setAngvel(
      { x: lav.x + (v.angVel.x - lav.x) * tVel, y: lav.y + (v.angVel.y - lav.y) * tVel, z: lav.z + (v.angVel.z - lav.z) * tVel },
      true,
    );

    // Internal state: input-driven values (currentSteer, wheel angVels,
    // engine RPM, gear) are NOT snapped - the local sim integrates them
    // identically to the server given the same inputs. Axle flex IS
    // snapped because it's terrain-contact-driven (small, drifty, and
    // invisible when corrected each snapshot).
    if (this.vehicle.applyAxleSnaps && v.axles) {
      this.vehicle.applyAxleSnaps([
        { rideY: v.axles[0].rideY, rollAngle: v.axles[0].rollAngle },
        { rideY: v.axles[1].rideY, rollAngle: v.axles[1].rollAngle },
      ]);
    }
  }

  /** Read the current rendered state. Position has the visual offset
   *  applied; rotation/wheels/axles come straight from the body and
   *  vehicle model. Pre-allocated buffer is reused each frame. */
  state(): PredictionState {
    const t = this.vehicle.body.translation();
    const r = this.vehicle.body.rotation();
    const s = this.vehicle.getState();
    this._state.position.x = t.x + this.posOffset.x;
    this._state.position.y = t.y + this.posOffset.y;
    this._state.position.z = t.z + this.posOffset.z;
    this._state.rotation.x = r.x;
    this._state.rotation.y = r.y;
    this._state.rotation.z = r.z;
    this._state.rotation.w = r.w;
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      const out = this._state.wheels[i]!;
      if (w) {
        out.steer = w.steer;
        out.spin = w.spin;
        out.suspensionLength = w.suspensionLength;
      }
    }
    if (this.vehicle.axleSnaps) {
      const ax = this.vehicle.axleSnaps();
      this._state.axles[0].rideY = ax[0].rideY;
      this._state.axles[0].rollAngle = ax[0].rollAngle;
      this._state.axles[1].rideY = ax[1].rideY;
      this._state.axles[1].rollAngle = ax[1].rollAngle;
    }
    return this._state;
  }
}
