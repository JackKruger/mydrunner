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

/** Wall-clock budget for the inline first chunk of replay inside reconcile.
 *  At ~0.5 ms per replay tick on the local prediction sim this lets short
 *  replays (queueLen ≤ 6) complete in the snapshot frame, while longer
 *  ones drain over subsequent frames via tickReplay(). 4 ms keeps the
 *  reconcile-frame total well under the 16.67 ms 60 FPS budget even when
 *  it lands on a heavy render frame. */
const REPLAY_FIRST_CHUNK_MS = 4.0;

export interface ReconcileStats {
  /** Distance (m) between the rendered pose and the authoritative pose
   *  before replay - the raw prediction error the server just corrected. */
  posErr: number;
  /** True if any axis of visualOffset hit its 1.5m clamp - i.e. the
   *  divergence was big enough that we snapped instead of smoothing. */
  capped: boolean;
  /** Inputs left to replay after dropping acked ones. Proxy for RTT in
   *  ticks (60Hz), so 6 ≈ 100ms RTT. */
  queueLen: number;
  /** Average |prediction - server| wheel angVel (rad/s) before sync.
   *  Non-zero means the tire integrator was starting each replay from the
   *  wrong spin state, which is the primary cause of large posErr. */
  wheelAngVelErr: number;
  /** True if the predicted gear differed from the server's at this reconcile. */
  gearMismatch: boolean;
  /** Distance (m) between the rendered pose and P_replay after replay.
   *  This is the TRUE physics divergence: how far the prediction drifted
   *  from what the server would produce for the same inputs. Near-zero
   *  means the prediction is accurate; large values mean rubberbanding. */
  replayDiv: number;
}

export class Prediction {
  private world: Physics.World;
  private vehicle: Physics.VehicleLike;
  private queue: QueuedInput[] = [];
  private acc = 0;
  /** Highest seq we've ever stepped locally. */
  private lastSteppedSeq = 0;
  /** Inputs queued for multi-frame replay after a snapshot. While this is
   *  non-empty, pushAndStep defers stepping (just appending to this list)
   *  so that wall-clock time spent on reconcile is bounded per frame.
   *  tickReplay() drains it across subsequent frames. */
  private replayPending: PlayerInput[] = [];
  /** Spawn pose - used for resets. */
  private spawn: { position: { x: number; y: number; z: number }; yaw: number };
  /** Visual position offset that decays each step. On reconcile, the body
   *  snaps to the server pose; we capture the jump (oldPos - newPos) into
   *  this offset so state() can return a smoothly-converging visual
   *  position. Hides 30Hz reconcile stutter when divergence is small. */
  private visualOffset = { x: 0, y: 0, z: 0 };
  /** Axle visual offset, mirrored from `visualOffset` but for the
   *  solid-axle DOFs (rideY in metres, rollAngle in radians). On
   *  reconcile we snap the axle to the server's pose and re-integrate
   *  through replay; any leftover visual jump is captured here and
   *  decays each step so the flex pose doesn't pop at 30Hz. Caps:
   *  rideY +/- 0.2 m, rollAngle +/- 0.2 rad - beyond that the divergence
   *  is large enough to be worth snapping rather than smoothing. */
  private axleVisualOffset: [
    { rideY: number; rollAngle: number },
    { rideY: number; rollAngle: number },
  ] = [
    { rideY: 0, rollAngle: 0 },
    { rideY: 0, rollAngle: 0 },
  ];
  /** Last alpha value passed to state(). Reconcile uses this to compute
   *  a visualOffset that keeps the actually-rendered pose continuous
   *  across the snap, independent of where in the inter-step interval
   *  the renderer is. Without this the offset only matches the alpha=1
   *  endpoint, leaving a visible jump proportional to (1-alpha) and the
   *  velocity change - the source of "stutter on snapshot tick" pops. */
  private lastAlpha = 1;
  // Pre-allocated return value for state() — eliminates per-frame GC pressure.
  // Callers must consume the result within the same frame and not hold references.
  private _state = {
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
    axles: [
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ] as [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }],
  };

  constructor(seed: number, size: number, resolution: number, spawn: { position: { x: number; y: number; z: number }; yaw?: number }) {
    const terrain = Physics.generateTerrain({ seed, size, resolution });
    this.world = new Physics.World({ terrain });
    this.spawn = { position: spawn.position, yaw: spawn.yaw ?? 0 };
    this.vehicle = this.world.spawnVehicle('local', this.spawn);
  }

  /** Push a sampled input. Caller has already sent it to the server.
   *  Steps the local sim once at FIXED_DT regardless of frame timing -
   *  prediction is on the input axis, not the frame axis.
   *  When a multi-frame reconcile replay is in flight (replayPending
   *  non-empty), the input is deferred onto the replay tail instead of
   *  stepping immediately. tickReplay() will drain it once it reaches
   *  the head. This bounds the per-frame physics cost during reconcile. */
  pushAndStep(input: PlayerInput): void {
    if (input.seq <= this.lastSteppedSeq) return;
    this.queue.push({ input });
    if (this.replayPending.length > 0) {
      this.replayPending.push(input);
      return;
    }
    this.stepOne(input);
  }

  /** Drain pending replay inputs until either the queue empties or the
   *  wall-clock budget expires. Called once per render frame from the
   *  main loop so reconcile work is amortised across multiple frames
   *  instead of paying the entire 18-tick replay cost on the snapshot
   *  frame (which produced a visible 30 Hz heartbeat at high queueLen). */
  tickReplay(budgetMs: number): void {
    if (this.replayPending.length === 0) return;
    const start = performance.now();
    while (this.replayPending.length > 0) {
      const input = this.replayPending.shift()!;
      this.stepOne(input);
      if (performance.now() - start >= budgetMs) break;
    }
    if (this.replayPending.length === 0) {
      this.vehicle.setReplaying?.(false);
    }
  }

  /** Run a single physics tick for one input. Shared by the normal-mode
   *  pushAndStep path and the in-flight replay drain. Captures prev so
   *  state(alpha) lerp endpoints span exactly one tick, decays the visual
   *  reconcile offset, and advances lastSteppedSeq. */
  private stepOne(input: PlayerInput): void {
    this.capturePrev();
    if ((input.buttons & 1) !== 0) {
      this.vehicle.resetTo(this.spawn);
    }
    this.vehicle.setInput(input);
    this.world.step();
    this.lastSteppedSeq = input.seq;
    // Decay the visual reconcile offset toward zero each step. 0.82 per
    // step at 60 Hz gives a ~80 ms half-life, so a small reconcile snap
    // converges away within a couple of frames - invisible. Same factor
    // applies during multi-frame replay: by the time replay finishes
    // (~18 ticks) the offset has decayed to ~3 % of its initial value.
    this.visualOffset.x *= 0.82;
    this.visualOffset.y *= 0.82;
    this.visualOffset.z *= 0.82;
    for (const a of this.axleVisualOffset) {
      a.rideY *= 0.82;
      a.rollAngle *= 0.82;
    }
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
    // Axle DOFs follow the same pattern - capture for inter-step
    // interpolation. Only present for solid-axle vehicles; the legacy
    // raycast path doesn't expose axleSnaps.
    if (this.vehicle.axleSnaps) {
      const ax = this.vehicle.axleSnaps();
      this.prev.axles[0].rideY = ax[0].rideY;
      this.prev.axles[0].rollAngle = ax[0].rollAngle;
      this.prev.axles[1].rideY = ax[1].rideY;
      this.prev.axles[1].rollAngle = ax[1].rollAngle;
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

  /** Reconcile against an authoritative snapshot for the local player.
   *
   *  Visual continuity strategy: the rendered pose at the moment of
   *  reconcile is `lerp(prev, body, lastAlpha) + visualOffset`. Snapping
   *  body and applying server axle state changes the lerp endpoints
   *  underneath us, which would visibly pop the truck UNLESS we set the
   *  new visualOffset to exactly `oldRendered - newLerp(prev, body, a)`.
   *  Then the first frame after reconcile renders the same pose as the
   *  last frame before; the offset decays toward zero in pushAndStep so
   *  the truck slides into the corrected trajectory over ~5 ticks
   *  (~80 ms half-life) instead of jumping.
   *
   *  This replaces the older `offset += (oldEnd - newEnd)` formula,
   *  which only matched the alpha=1 endpoint and left a residual jump
   *  proportional to (1-alpha) and to the velocity change. That residual
   *  is the "stutter on every snapshot" the user reported. */
  reconcile(snap: WorldSnapshot, myId: string): ReconcileStats | null {
    const me = snap.players.find((p) => p.id === myId);
    if (!me) return null;

    // If a previous snapshot's replay is still draining, discard the
    // remainder. The newer snapshot is a more recent baseline; the
    // un-replayed inputs are still in this.queue and will either be
    // dropped (if acked by the new snapshot) or replayed below.
    if (this.replayPending.length > 0) {
      this.replayPending.length = 0;
      this.vehicle.setReplaying?.(false);
    }

    // Drop acked inputs in place. queue.filter() and queue.slice() both
    // allocate a fresh array on every snapshot (30/s); doing this in place
    // with splice() reuses the existing one and removes a steady GC
    // source. The array's already in cache.
    let drop = 0;
    while (drop < this.queue.length && this.queue[drop]!.input.seq <= me.lastAckSeq) {
      drop += 1;
    }
    if (drop > 0) this.queue.splice(0, drop);

    // Cap replay length. 30 ticks ≈ 500 ms of input at 60 Hz; past that
    // the local truck is far enough ahead of the server that the user
    // perceives a snap regardless of how much we replay.
    const MAX_REPLAY = 30;
    if (this.queue.length > MAX_REPLAY) {
      this.queue.splice(0, this.queue.length - MAX_REPLAY);
    }

    const a = this.lastAlpha;
    const supportsAxles = this.vehicle.axleSnaps && this.vehicle.applyAxleSnaps;

    // 1. Capture the actually-rendered visual pose using the current
    //    lerp endpoints + offset. This is what was on screen the last
    //    frame; the new offset must match it to keep continuity.
    const renderedPos = this.computeRenderedPos(a);
    const renderedAxles = supportsAxles ? this.computeRenderedAxles(a) : null;
    // Distance from rendered pose to the authoritative pose, BEFORE
    // replay - this is the raw divergence the server just told us about.
    // Reported back to caller for diagnostics.
    const dxRaw = renderedPos.x - me.vehicle.position.x;
    const dyRaw = renderedPos.y - me.vehicle.position.y;
    const dzRaw = renderedPos.z - me.vehicle.position.z;
    const posErr = Math.hypot(dxRaw, dyRaw, dzRaw);

    // 2. Snap to authoritative state. Includes the smoothed steering
    //    angle so replay doesn't double-step currentSteer.
    const v = me.vehicle;

    // Measure wheel angVel drift BEFORE snapping so it shows up in diagnostics.
    let wheelAngVelErr = 0;
    let gearMismatch = false;
    if (this.vehicle.applyWheelAngVels && v.wheels.length >= 4) {
      const cur = this.vehicle.getState();
      for (let i = 0; i < 4; i++) {
        wheelAngVelErr += Math.abs((cur.wheels[i]?.angVel ?? 0) - (v.wheels[i]?.angVel ?? 0));
      }
      wheelAngVelErr /= 4;
      gearMismatch = cur.gear !== v.gear;
    }

    this.vehicle.body.setTranslation(v.position, true);
    this.vehicle.body.setRotation(v.rotation, true);
    this.vehicle.body.setLinvel(v.linVel, true);
    this.vehicle.body.setAngvel(v.angVel, true);
    if (v.wheels[0]) this.vehicle.setSteerAngle(v.wheels[0].steer);
    if (supportsAxles && v.axles) {
      this.vehicle.applyAxleSnaps!([
        { rideY: v.axles[0].rideY, rollAngle: v.axles[0].rollAngle },
        { rideY: v.axles[1].rideY, rollAngle: v.axles[1].rollAngle },
      ]);
    }
    // Snap wheel angular velocities — the primary source of prediction
    // divergence. Without this the tire force integrator replays from the
    // wrong spin state and the truck drifts meters from the server position.
    if (this.vehicle.applyWheelAngVels && v.wheels.length >= 4) {
      this.vehicle.applyWheelAngVels([
        v.wheels[0]?.angVel ?? 0,
        v.wheels[1]?.angVel ?? 0,
        v.wheels[2]?.angVel ?? 0,
        v.wheels[3]?.angVel ?? 0,
      ]);
    }
    // Snap engine state so replay uses the correct gear and RPM.
    if (this.vehicle.applyEngineSnap) {
      this.vehicle.applyEngineSnap(v.rpm, v.gear);
    }

    // 3. Reset state(alpha) lerp endpoints. After the body snap, prev
    //    holds the OLD pre-snap pose, so lerp(prev, body, alpha) would
    //    interpolate halfway between the old prediction and the server
    //    pose - a visible glitch on the next render. Snap prev to body
    //    so the lerp degenerates to body until the next stepOne() runs
    //    a real tick and updates prev to body-before-step.
    this.capturePrev();

    // 4. Compute the visual reconcile offset that keeps the rendered
    //    pose continuous across the snap. After step 3, computeLerpedPos
    //    returns the server pose; we want it to render as the OLD
    //    rendered pose, so the offset must equal (oldRender - serverPose).
    //    For multi-frame replay this is large (~velocity × queueLen ≈
    //    2-3 m at 10 m/s); the per-step ×0.82 decay inside stepOne() and
    //    the slow forward integration during replay pull it back to
    //    near-zero by the time replay completes (~18 ticks). The cap is
    //    raised to 5 m so legitimate replays don't get truncated; tiny
    //    actual physics divergence (the post-replay error) will still
    //    sit well under it.
    const dxCap = 5.0;
    this.visualOffset.x = clampAbs(renderedPos.x - v.position.x, dxCap);
    this.visualOffset.y = clampAbs(renderedPos.y - v.position.y, dxCap);
    this.visualOffset.z = clampAbs(renderedPos.z - v.position.z, dxCap);

    if (supportsAxles && renderedAxles && v.axles) {
      const AX_CAP_RIDE = 0.5;
      const AX_CAP_ROLL = 0.5;
      for (let i = 0; i < 2; i++) {
        const off = this.axleVisualOffset[i]!;
        off.rideY = clampAbs(renderedAxles[i]!.rideY - v.axles[i]!.rideY, AX_CAP_RIDE);
        off.rollAngle = clampAbs(renderedAxles[i]!.rollAngle - v.axles[i]!.rollAngle, AX_CAP_ROLL);
      }
    }

    const capped =
      Math.abs(this.visualOffset.x) >= dxCap ||
      Math.abs(this.visualOffset.y) >= dxCap ||
      Math.abs(this.visualOffset.z) >= dxCap;

    // 5. Schedule the queued inputs for replay across the next few
    //    frames. The first chunk is pumped inline so short replays
    //    (small queueLen) still complete in one frame; longer ones
    //    drain via tickReplay() each subsequent frame.
    if (this.queue.length > 0) {
      for (const q of this.queue) this.replayPending.push(q.input);
      this.vehicle.setReplaying?.(true);
      this.tickReplay(REPLAY_FIRST_CHUNK_MS);
    }

    // 6. replayDiv: measured immediately after the inline first chunk.
    //    With multi-frame replay this is an UPPER BOUND on the eventual
    //    divergence (the body still has more replay to do, so it's
    //    further from the rendered pose than after full replay would be).
    //    Useful as a "is the system converging" signal even mid-flight.
    const replayBody = this.vehicle.body.translation();
    const replayDiv = Math.hypot(
      renderedPos.x - replayBody.x,
      renderedPos.y - replayBody.y,
      renderedPos.z - replayBody.z,
    );
    return { posErr, capped, queueLen: this.queue.length, wheelAngVelErr, gearMismatch, replayDiv };
  }

  /** Helpers below mirror the math in state(), so reconcile can compute
   *  what state() would return at a given alpha both before and after
   *  the snap. Kept private to avoid expanding the public surface. */
  private computeLerpedPos(a: number): { x: number; y: number; z: number } {
    const t = this.vehicle.body.translation();
    const p = this.prev.pos;
    return {
      x: p.x + (t.x - p.x) * a,
      y: p.y + (t.y - p.y) * a,
      z: p.z + (t.z - p.z) * a,
    };
  }

  private computeRenderedPos(a: number): { x: number; y: number; z: number } {
    const lerped = this.computeLerpedPos(a);
    return {
      x: lerped.x + this.visualOffset.x,
      y: lerped.y + this.visualOffset.y,
      z: lerped.z + this.visualOffset.z,
    };
  }

  private computeLerpedAxles(a: number): [
    { rideY: number; rollAngle: number },
    { rideY: number; rollAngle: number },
  ] {
    const cur = this.vehicle.axleSnaps ? this.vehicle.axleSnaps() : [
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ] as [{ rideY: number; rollAngle: number }, { rideY: number; rollAngle: number }];
    const out: [
      { rideY: number; rollAngle: number },
      { rideY: number; rollAngle: number },
    ] = [
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ];
    for (let i = 0; i < 2; i++) {
      const c = cur[i]!;
      const p = this.prev.axles[i]!;
      out[i]!.rideY = p.rideY + (c.rideY - p.rideY) * a;
      out[i]!.rollAngle = p.rollAngle + (c.rollAngle - p.rollAngle) * a;
    }
    return out;
  }

  private computeRenderedAxles(a: number): [
    { rideY: number; rollAngle: number },
    { rideY: number; rollAngle: number },
  ] {
    const lerped = this.computeLerpedAxles(a);
    for (let i = 0; i < 2; i++) {
      lerped[i]!.rideY += this.axleVisualOffset[i]!.rideY;
      lerped[i]!.rollAngle += this.axleVisualOffset[i]!.rollAngle;
    }
    return lerped;
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
    axles: [
      { rideY: number; rollAngle: number },
      { rideY: number; rollAngle: number },
    ];
  } {
    const s = this.vehicle.getState();
    const a = Math.max(0, Math.min(1, alpha));
    this.lastAlpha = a;
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
    const axCurrent = s.axles;
    for (let i = 0; i < 2; i++) {
      const cur = axCurrent?.[i];
      const prev = this.prev.axles[i]!;
      const off = this.axleVisualOffset[i]!;
      const ax = this._state.axles[i]!;
      ax.rideY = prev.rideY + ((cur?.rideY ?? 0) - prev.rideY) * a + off.rideY;
      ax.rollAngle = prev.rollAngle + ((cur?.rollAngle ?? 0) - prev.rollAngle) * a + off.rollAngle;
    }
    const pos = this._state.position;
    pos.x = p.x + (s.position.x - p.x) * a + this.visualOffset.x;
    pos.y = p.y + (s.position.y - p.y) * a + this.visualOffset.y;
    pos.z = p.z + (s.position.z - p.z) * a + this.visualOffset.z;
    const rot = this._state.rotation;
    rot.x = rx; rot.y = ry; rot.z = rz; rot.w = rw;
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i]!;
      const pw = this.prev.wheels[i]!;
      const wOut = this._state.wheels[i]!;
      wOut.steer = pw.steer + (w.steer - pw.steer) * a;
      wOut.spin = pw.spin + (w.spin - pw.spin) * a;
      wOut.suspensionLength = pw.suspensionLength + (w.suspensionLength - pw.suspensionLength) * a;
    }
    return this._state;
  }

  dispose(): void {
    this.world.dispose();
  }
}

function clampAbs(v: number, cap: number): number {
  return v < -cap ? -cap : v > cap ? cap : v;
}
