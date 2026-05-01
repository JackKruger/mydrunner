// Client-side prediction with server reconciliation.
//
// Keeps a local Rapier world with just the local player's vehicle, runs
// physics in lockstep with the server (60Hz, same FIXED_DT). Inputs are
// applied locally as they're sampled, and resent to the server. When a
// snapshot arrives:
//   1. Snap the local body to the authoritative pose for our player.
//   2. Drop all inputs the server has already acked.
//   3. Replay the un-acked inputs to fast-forward back to the predicted
//      "now" state.
//
// This makes the local car feel responsive (input -> next frame) regardless
// of network latency.

import {
  FIXED_DT,
  Physics,
  type PlayerInput,
  type WorldSnapshot,
  EMPTY_INPUT,
} from '@mydrunner/shared';

interface QueuedInput {
  input: PlayerInput;
}

export class Prediction {
  private world: Physics.World;
  private vehicle: Physics.Vehicle;
  private queue: QueuedInput[] = [];
  private acc = 0;
  /** Highest seq we've ever stepped locally. */
  private lastSteppedSeq = 0;
  /** Spawn pose - used for resets. */
  private spawn: { position: { x: number; y: number; z: number }; yaw: number };
  /** Visual position offset that decays each step. On reconcile, the body
   *  snaps to the server pose; we capture the jump (oldPos - newPos) into
   *  this offset so state() can return a smoothly-converging visual
   *  position. Hides 30Hz reconcile stutter when divergence is small. */
  private visualOffset = { x: 0, y: 0, z: 0 };
  /** Body pose at the start of the most recent physics step. Together
   *  with the body's current pose, lets state(alpha) return an
   *  interpolated state - smooth motion when the rAF accumulator runs
   *  0/1/2 steps per frame instead of an exact 1-per-frame cadence. */
  private prev = {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    wheels: [
      { steer: 0, spin: 0, suspensionLength: 0 },
      { steer: 0, spin: 0, suspensionLength: 0 },
      { steer: 0, spin: 0, suspensionLength: 0 },
      { steer: 0, spin: 0, suspensionLength: 0 },
    ],
  };

  constructor(seed: number, size: number, resolution: number, spawn: { position: { x: number; y: number; z: number }; yaw?: number }) {
    const terrain = Physics.generateTerrain({ seed, size, resolution });
    this.world = new Physics.World({ terrain });
    this.spawn = { position: spawn.position, yaw: spawn.yaw ?? 0 };
    this.vehicle = this.world.spawnVehicle('local', this.spawn);
  }

  /** Push a sampled input. Caller has already sent it to the server.
   *  Steps the local sim once at FIXED_DT regardless of frame timing -
   *  prediction is on the input axis, not the frame axis. */
  pushAndStep(input: PlayerInput): void {
    if (input.seq <= this.lastSteppedSeq) return;
    this.queue.push({ input });
    if ((input.buttons & 1) !== 0) {
      this.vehicle.resetTo(this.spawn);
    }
    this.capturePrev();
    this.vehicle.setInput(input);
    this.world.step();
    this.lastSteppedSeq = input.seq;
    // Decay the visual reconcile offset toward zero each step. 0.82 per
    // step at 60Hz gives a ~80ms half-life, so a small reconcile snap
    // converges away within a couple of frames - invisible.
    this.visualOffset.x *= 0.82;
    this.visualOffset.y *= 0.82;
    this.visualOffset.z *= 0.82;
  }

  private capturePrev(): void {
    const t = this.vehicle.body.translation();
    this.prev.pos.x = t.x; this.prev.pos.y = t.y; this.prev.pos.z = t.z;
    const r = this.vehicle.body.rotation();
    this.prev.rot.x = r.x; this.prev.rot.y = r.y;
    this.prev.rot.z = r.z; this.prev.rot.w = r.w;
    // Wheel state too - without this, wheel spin / suspension advance
    // only on step boundaries, which makes the wheels visibly tick at
    // the physics rate instead of moving smoothly with the chassis.
    const s = this.vehicle.getState();
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      const pw = this.prev.wheels[i]!;
      if (w) {
        pw.steer = w.steer;
        pw.spin = w.spin;
        pw.suspensionLength = w.suspensionLength;
      }
    }
  }

  /** Frame-time advance is a NO-OP. Prediction steps exactly once per
   *  sampled input via pushAndStep(); driving the world from the render
   *  loop too caused prediction to over-step relative to the server,
   *  which in turn caused snapshot reconciliation to snap-back at 30Hz
   *  - visible as a wheel-flicker on steering. Inputs are sampled at
   *  60Hz which matches the server's tick rate exactly. */
  advance(_frameDt: number): void {
    /* intentionally empty */
  }

  /** Reconcile against an authoritative snapshot for the local player. */
  reconcile(snap: WorldSnapshot, myId: string): void {
    const me = snap.players.find((p) => p.id === myId);
    if (!me) return;

    // Drop acked inputs.
    this.queue = this.queue.filter((q) => q.input.seq > me.lastAckSeq);

    // Capture the predicted pose BEFORE we snap so we can smooth the
    // visual jump. After replaying queued inputs, we'll compare
    // post-replay pose to pre-snap pose and add the difference to the
    // visual offset. Decay in pushAndStep then fades it out.
    const before = this.vehicle.body.translation();
    const beforeX = before.x, beforeY = before.y, beforeZ = before.z;

    // Snap to authoritative state. Includes the smoothed steering angle:
    // without this, replay would double-step currentSteer (since
    // prediction had already advanced it for each unacked input), making
    // the wheel visibly jitter on every snapshot.
    const v = me.vehicle;
    this.vehicle.body.setTranslation(v.position, true);
    this.vehicle.body.setRotation(v.rotation, true);
    this.vehicle.body.setLinvel(v.linVel, true);
    this.vehicle.body.setAngvel(v.angVel, true);
    if (v.wheels[0]) this.vehicle.setSteerAngle(v.wheels[0].steer);

    // Replay remaining queue to fast-forward to prediction time.
    for (const q of this.queue) {
      this.capturePrev();
      this.vehicle.setInput(q.input);
      this.world.step();
    }

    // Compare post-replay pose to the pre-snap predicted pose. Anything
    // we couldn't fix by replay shows up as a jump - bake it into the
    // visual offset so the rendered car drifts smoothly to the new
    // pose instead of popping. Cap to ±1.5m so a catastrophic
    // divergence still snaps visibly (better to teleport than fly).
    const after = this.vehicle.body.translation();
    const dx = beforeX - after.x;
    const dy = beforeY - after.y;
    const dz = beforeZ - after.z;
    const CAP = 1.5;
    this.visualOffset.x = Math.max(-CAP, Math.min(CAP, this.visualOffset.x + dx));
    this.visualOffset.y = Math.max(-CAP, Math.min(CAP, this.visualOffset.y + dy));
    this.visualOffset.z = Math.max(-CAP, Math.min(CAP, this.visualOffset.z + dz));
  }

  /** Read the predicted vehicle state for rendering. `alpha` in [0, 1]
   *  interpolates between the start-of-step pose and the end-of-step
   *  pose - smooths the motion when the render rate isn't exactly the
   *  same as the physics rate (0/1/2 steps per frame). The position
   *  also includes the visual reconcile offset (decaying toward zero)
   *  so small server corrections don't pop the car. */
  state(alpha = 1): {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    wheels: { steer: number; spin: number; suspensionLength: number }[];
  } {
    const s = this.vehicle.getState();
    const a = Math.max(0, Math.min(1, alpha));
    const p = this.prev.pos;
    const pr = this.prev.rot;
    // Normalised lerp for rotation: cheap, fine for the small per-step
    // angle change at 60Hz. Negate one quaternion if the dot is
    // negative to take the short way around.
    const dot = pr.x * s.rotation.x + pr.y * s.rotation.y + pr.z * s.rotation.z + pr.w * s.rotation.w;
    const sgn = dot < 0 ? -1 : 1;
    let rx = pr.x + (s.rotation.x * sgn - pr.x) * a;
    let ry = pr.y + (s.rotation.y * sgn - pr.y) * a;
    let rz = pr.z + (s.rotation.z * sgn - pr.z) * a;
    let rw = pr.w + (s.rotation.w * sgn - pr.w) * a;
    const rl = Math.hypot(rx, ry, rz, rw) || 1;
    rx /= rl; ry /= rl; rz /= rl; rw /= rl;
    return {
      position: {
        x: p.x + (s.position.x - p.x) * a + this.visualOffset.x,
        y: p.y + (s.position.y - p.y) * a + this.visualOffset.y,
        z: p.z + (s.position.z - p.z) * a + this.visualOffset.z,
      },
      rotation: { x: rx, y: ry, z: rz, w: rw },
      wheels: s.wheels.map((w, i) => {
        const pw = this.prev.wheels[i]!;
        return {
          steer: pw.steer + (w.steer - pw.steer) * a,
          spin: pw.spin + (w.spin - pw.spin) * a,
          suspensionLength: pw.suspensionLength + (w.suspensionLength - pw.suspensionLength) * a,
        };
      }),
    };
  }

  dispose(): void {
    this.world.dispose();
  }
}
