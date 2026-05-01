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
  }

  /** Advance the local sim by frame time without new input - keeps the car
   *  rolling between input samples (mostly a no-op since we sample at 60Hz). */
  advance(frameDt: number): void {
    this.acc += Math.min(frameDt, 0.25);
    while (this.acc >= FIXED_DT) {
      // No queued input this frame: re-use the last one.
      const last = this.queue.length > 0 ? this.queue[this.queue.length - 1]!.input : EMPTY_INPUT;
      this.vehicle.setInput(last);
      this.world.step();
      this.acc -= FIXED_DT;
    }
  }

  /** Reconcile against an authoritative snapshot for the local player. */
  reconcile(snap: WorldSnapshot, myId: string): void {
    const me = snap.players.find((p) => p.id === myId);
    if (!me) return;

    // Drop acked inputs.
    this.queue = this.queue.filter((q) => q.input.seq > me.lastAckSeq);

    // Snap to authoritative state.
    const v = me.vehicle;
    this.vehicle.body.setTranslation(v.position, true);
    this.vehicle.body.setRotation(v.rotation, true);
    this.vehicle.body.setLinvel(v.linVel, true);
    this.vehicle.body.setAngvel(v.angVel, true);

    // Replay remaining queue to fast-forward to prediction time.
    for (const q of this.queue) {
      this.vehicle.setInput(q.input);
      this.world.step();
    }
  }

  /** Read the predicted vehicle state for rendering. */
  state(): {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
    wheels: { steer: number; spin: number; suspensionLength: number }[];
  } {
    const s = this.vehicle.getState();
    return {
      position: s.position,
      rotation: s.rotation,
      wheels: s.wheels.map((w) => ({ steer: w.steer, spin: w.spin, suspensionLength: w.suspensionLength })),
    };
  }

  dispose(): void {
    this.world.dispose();
  }
}
