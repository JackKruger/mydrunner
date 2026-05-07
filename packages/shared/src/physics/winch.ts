// Recovery winch: pull-only spring–damper between a vehicle's bumper
// fairlead and a fixed world anchor. Forces are applied via Rapier's
// addForceAtPoint inside SolidAxleVehicle.preStep, so they accumulate
// with the per-tick wheel forces and are consumed by the next world.step.
//
// Slice 1 was the bare force model. Slice 2 added the input-driven spool
// loop with motor force cap. Slice 3 (this revision) adds the phase
// state machine (stowed → deployed → attached → broken) and lets a
// Winch live as a default field on every vehicle: applyForces and
// stepSpool short-circuit unless the phase is 'attached', so the cost
// is one branch per tick on idle winches.
//
// Phase transitions live here; Room.tickOnce drives them in response
// to player input bits. Anchor-resolution against world obstacles and
// other vehicles is slice 4 — for now setStaticAnchor is the only
// way into 'attached' (used by tests/scripting; tryAttach is a stub).
//
// See docs/winching-system.md for the full design.

import type RAPIER from '@dimforge/rapier3d-compat';
import { WINCH } from '../constants.js';
import type { Vec3 } from '../types.js';
import { rotateVecByQuat } from './util.js';

export type WinchPhase =
  | 'stowed'      // hook on bumper, no cable in world
  | 'deployed'    // hook off the truck, no anchor (purely visual for now)
  | 'attached'    // anchor bound, force model active
  | 'broken';     // post-snap cooldown (slice 5)

export class Winch {
  phase: WinchPhase = 'stowed';

  /** Cable rest length in metres. Only meaningful while attached. */
  spoolLength = 0;

  /** Magnitude of the force applied last tick, in newtons. Zero when
   *  the cable is slack or the winch isn't attached. */
  tension = 0;

  /** World-space anchor point while attached. null otherwise. Slice 4
   *  will replace this with a structured WinchAnchor that can resolve
   *  against a moving body (vehicle-to-vehicle). */
  private anchorWorld: Vec3 | null = null;

  private reelInActive = false;
  private reelOutActive = false;

  constructor(
    private readonly body: RAPIER.RigidBody,
    private readonly mountLocal: Vec3,
  ) {}

  /** Toggle between stowed and deployed. No-op while attached or
   *  broken — release the cable first. */
  toggleDeploy(): void {
    if (this.phase === 'stowed') this.phase = 'deployed';
    else if (this.phase === 'deployed') this.phase = 'stowed';
  }

  /** Player-facing attach action. Slice 3 ships a stub: the wiring is
   *  in place (rising-edge detection in Room dispatches here) but
   *  raycasting against winchable obstacles lands in slice 4. Until
   *  then this is a no-op so holding the button doesn't pop the phase. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tryAttach(_world: unknown): void {
    // intentional no-op; see slice 4
  }

  /** Test/scripting hook: bind to a fixed world point with a given
   *  initial spool length. Real player flow goes through tryAttach. */
  setStaticAnchor(worldPoint: Vec3, initialSpoolLength: number): void {
    this.anchorWorld = { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z };
    this.spoolLength = clampSpool(initialSpoolLength);
    this.phase = 'attached';
  }

  /** Detach and stow. Safe to call from any phase. */
  release(): void {
    this.phase = 'stowed';
    this.anchorWorld = null;
    this.spoolLength = 0;
    this.tension = 0;
    this.reelInActive = false;
    this.reelOutActive = false;
  }

  /** Latch the player's reel-in / reel-out intent. Both true cancels
   *  out (treated as no input). The actual spool motion happens in
   *  stepSpool, which respects the motor force cap. */
  setReelInput(input: { in: boolean; out: boolean }): void {
    this.reelInActive = input.in && !input.out;
    this.reelOutActive = input.out && !input.in;
  }

  /** Advance the spool by one tick. Reel-in is gated on the motor force
   *  cap: if last tick's tension exceeded it, the motor stalls and the
   *  rest length is held. Reel-out is unconditional. No-op unless
   *  attached. */
  stepSpool(dt: number): void {
    if (this.phase !== 'attached') return;
    if (this.reelInActive && this.tension < WINCH.motorMaxForce) {
      this.spoolLength = Math.max(0, this.spoolLength - WINCH.spoolSpeed * dt);
    }
    if (this.reelOutActive) {
      this.spoolLength = Math.min(WINCH.maxLength, this.spoolLength + WINCH.spoolSpeed * dt);
    }
  }

  /** Compute and apply the cable force on the vehicle body. Called from
   *  SolidAxleVehicle.preStep, after the per-tick force reset and the
   *  wheel forces. Pull-only: if the body is closer to the anchor than
   *  spoolLength, the cable is slack and no force is applied. */
  applyForces(): void {
    if (this.phase !== 'attached' || this.anchorWorld === null) {
      this.tension = 0;
      return;
    }
    const t = this.body.translation();
    const r = this.body.rotation();
    // Fairlead point in world space.
    const mountW = addVec(t, rotateVecByQuat(this.mountLocal, r));
    const dx = this.anchorWorld.x - mountW.x;
    const dy = this.anchorWorld.y - mountW.y;
    const dz = this.anchorWorld.z - mountW.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-4) {
      this.tension = 0;
      return;
    }
    const stretch = L - this.spoolLength;
    if (stretch <= 0) {
      this.tension = 0;
      return;
    }
    const invL = 1 / L;
    const nx = dx * invL;
    const ny = dy * invL;
    const nz = dz * invL;

    // Velocity of the fairlead point (linear + ω × r). Anchor is
    // static, so closing speed equals -dot(vMount, n).
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const rx = mountW.x - t.x;
    const ry = mountW.y - t.y;
    const rz = mountW.z - t.z;
    const wxX = av.y * rz - av.z * ry;
    const wxY = av.z * rx - av.x * rz;
    const wxZ = av.x * ry - av.y * rx;
    const vMx = lv.x + wxX;
    const vMy = lv.y + wxY;
    const vMz = lv.z + wxZ;
    const vAlong = -(vMx * nx + vMy * ny + vMz * nz); // +ve = stretching

    let Fmag = WINCH.stiffness * stretch + WINCH.damping * vAlong;
    if (Fmag < 0) Fmag = 0;

    this.tension = Fmag;
    if (Fmag === 0) return;

    this.body.addForceAtPoint(
      { x: nx * Fmag, y: ny * Fmag, z: nz * Fmag },
      mountW,
      true,
    );
  }
}

function clampSpool(v: number): number {
  if (v < 0) return 0;
  if (v > WINCH.maxLength) return WINCH.maxLength;
  return v;
}

function addVec(a: { x: number; y: number; z: number }, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
