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
}

export class Prediction {
  private world: Physics.World;
  private vehicle: Physics.VehicleLike;
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

  /** Call once per render frame (before any physics steps) to capture
   *  the current body state as the "previous" pose. This is needed for
   *  smooth alpha-based interpolation in state(). Without calling this
   *  every frame, `prev` goes stale on displays whose refresh rate isn't
   *  an exact multiple of the physics tick rate (e.g. 144Hz vs 60Hz),
   *  causing the car to stutter as the lerp endpoints don't advance
   *  smoothly between physics steps. */
  beginFrame(): void {
    this.capturePrev();
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

    // Drop acked inputs.
    this.queue = this.queue.filter((q) => q.input.seq > me.lastAckSeq);

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

    // 3. Capture the post-snap state into prev (single capture; the
    //    replay loop below does NOT call capturePrev again). With prev
    //    fixed at the post-snap pose, lerp(prev, body, a) covers the
    //    entire replay span, which is what we want for a smooth visual
    //    sweep into the new trajectory.
    this.capturePrev();

    // 4. Replay queued inputs to fast-forward body to "now".
    for (const q of this.queue) {
      this.vehicle.setInput(q.input);
      this.world.step();
    }

    // 5. Compute the new visual pose with NO offset and at the same
    //    alpha. The offset that makes new render == old render is
    //    exactly (oldRendered - newRenderedNoOffset).
    const newPosNoOffset = this.computeLerpedPos(a);
    // 3m offset cap absorbs RTT-driven divergence on real connections
    // (~25 m/s × 100ms RTT = 2.5m); the per-step decay still pulls the
    // visual back toward truth within ~5 ticks.
    const dxCap = 3.0;
    this.visualOffset.x = clampAbs(renderedPos.x - newPosNoOffset.x, dxCap);
    this.visualOffset.y = clampAbs(renderedPos.y - newPosNoOffset.y, dxCap);
    this.visualOffset.z = clampAbs(renderedPos.z - newPosNoOffset.z, dxCap);

    if (supportsAxles && renderedAxles) {
      const newAxlesNoOffset = this.computeLerpedAxles(a);
      const AX_CAP_RIDE = 0.2;
      const AX_CAP_ROLL = 0.2;
      for (let i = 0; i < 2; i++) {
        const off = this.axleVisualOffset[i]!;
        off.rideY = clampAbs(renderedAxles[i]!.rideY - newAxlesNoOffset[i]!.rideY, AX_CAP_RIDE);
        off.rollAngle = clampAbs(renderedAxles[i]!.rollAngle - newAxlesNoOffset[i]!.rollAngle, AX_CAP_ROLL);
      }
    }

    const posCap = 3.0;
    const capped =
      Math.abs(dxRaw) > posCap || Math.abs(dyRaw) > posCap || Math.abs(dzRaw) > posCap;
    return { posErr, capped, queueLen: this.queue.length };
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
    const axCurrent = s.axles ?? [
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ];
    const axles: [
      { rideY: number; rollAngle: number },
      { rideY: number; rollAngle: number },
    ] = [
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ];
    for (let i = 0; i < 2; i++) {
      const cur = axCurrent[i] ?? { rideY: 0, rollAngle: 0 };
      const prev = this.prev.axles[i]!;
      const off = this.axleVisualOffset[i]!;
      axles[i]!.rideY = prev.rideY + (cur.rideY - prev.rideY) * a + off.rideY;
      axles[i]!.rollAngle = prev.rollAngle + (cur.rollAngle - prev.rollAngle) * a + off.rollAngle;
    }
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
      axles,
    };
  }

  dispose(): void {
    this.world.dispose();
  }
}

function clampAbs(v: number, cap: number): number {
  return v < -cap ? -cap : v > cap ? cap : v;
}
