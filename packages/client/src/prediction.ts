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

  /** Read the predicted vehicle state for rendering. The position
   *  includes the visual reconcile offset (decaying toward zero) so
   *  small server corrections don't pop the car. */
  state(): {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    wheels: { steer: number; spin: number; suspensionLength: number }[];
  } {
    const s = this.vehicle.getState();
    return {
      position: {
        x: s.position.x + this.visualOffset.x,
        y: s.position.y + this.visualOffset.y,
        z: s.position.z + this.visualOffset.z,
      },
      rotation: s.rotation,
      wheels: s.wheels.map((w) => ({ steer: w.steer, spin: w.spin, suspensionLength: w.suspensionLength })),
    };
  }

  dispose(): void {
    this.world.dispose();
  }
}
