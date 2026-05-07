// Recovery winch: pull-only spring–damper between a vehicle's bumper
// fairlead and a fixed world anchor. Forces are applied via Rapier's
// addForceAtPoint after the vehicle's preStep (which calls resetForces),
// so they accumulate with the per-tick wheel forces and are consumed by
// the next world.step.
//
// Slice 1 covered the bare force model. Slice 2 (this revision) adds
// the input-driven spool loop: setReelInput latches in/out booleans;
// stepSpool advances the rest length each tick, gated on the motor
// force cap so impossible loads stall the motor instead of letting the
// rest length teleport the chassis. Phase state, anchor types, and
// break force land in later slices — see docs/winching-system.md §11.

import type RAPIER from '@dimforge/rapier3d-compat';
import { WINCH } from '../constants.js';
import type { Vec3 } from '../types.js';
import { rotateVecByQuat } from './util.js';

export class Winch {
  /** Cable rest length in metres. Stretch above this produces force;
   *  below this the cable is slack and zero force is applied. */
  spoolLength: number;
  /** Magnitude of the force applied last tick, in newtons. Zero when
   *  the cable is slack. Exposed for HUD / tests. */
  tension = 0;

  private reelInActive = false;
  private reelOutActive = false;

  constructor(
    private readonly body: RAPIER.RigidBody,
    private readonly mountLocal: Vec3,
    /** World-space anchor point. Static for slice 1. */
    private readonly anchorWorld: Vec3,
    initialSpoolLength: number,
  ) {
    this.spoolLength = clampSpool(initialSpoolLength);
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
   *  rest length is held. Reel-out is unconditional (paying cable out
   *  doesn't fight the load). */
  stepSpool(dt: number): void {
    if (this.reelInActive && this.tension < WINCH.motorMaxForce) {
      this.spoolLength = Math.max(0, this.spoolLength - WINCH.spoolSpeed * dt);
    }
    if (this.reelOutActive) {
      this.spoolLength = Math.min(WINCH.maxLength, this.spoolLength + WINCH.spoolSpeed * dt);
    }
  }

  /** Compute and apply the cable force on the vehicle body. Call once
   *  per tick, after vehicle.preStep() and before world.step(). Pull-only:
   *  if the body is closer to the anchor than `spoolLength`, the cable
   *  is slack and no force is applied. */
  applyForces(): void {
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
    // ω × r
    const wxX = av.y * rz - av.z * ry;
    const wxY = av.z * rx - av.x * rz;
    const wxZ = av.x * ry - av.y * rx;
    const vMx = lv.x + wxX;
    const vMy = lv.y + wxY;
    const vMz = lv.z + wxZ;
    const vAlong = -(vMx * nx + vMy * ny + vMz * nz); // closing speed; +ve = stretching

    let Fmag = WINCH.stiffness * stretch + WINCH.damping * vAlong;
    if (Fmag < 0) Fmag = 0; // pull-only

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
