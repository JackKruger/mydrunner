// Axle state machine for the solid-axle vehicle model. An axle has two
// degrees of freedom relative to its chassis attachment:
//
//   rideY     - vertical translation along the axle's mount, governed by
//               the ride spring + damper.
//   rollAngle - rotation of the axle beam about the chassis-forward axis,
//               governed by a (much softer) roll spring + damper. Roll
//               articulation is capped at +/- maxArticulation; surplus
//               torque past the cap is reported back to the caller so it
//               can be applied to the chassis (the body leans).
//
// Both wheels on the axle share these DOFs - that's the whole point of
// "solid axle". A bump under one wheel rotates the beam, which lifts the
// hub on the other side OR (if past the cap) levers the chassis instead.
//
// Pure functions; no Rapier handles. Tested in isolation in
// shared/__tests__/axle.test.ts.

import { GRAVITY_Y } from '../constants.js';
import type { AxleGeom } from './vehicleGeom.js';

export interface AxleState {
  geom: AxleGeom;
  /** Vertical offset of the axle from its chassis-local centerLocalY
   *  attachment, positive = up. Clamped to [-droopMax, +bumpMax]. */
  rideY: number;
  /** Rate of change of rideY (m/s). */
  rideVelY: number;
  /** Rotation of the axle beam about the chassis-forward axis (rad).
   *  Positive = right-hand wheel up, left-hand wheel down. Clamped to
   *  +/- maxArticulation. */
  rollAngle: number;
  /** Rate of change of rollAngle (rad/s). */
  rollVel: number;
  /** Last computed left-wheel ground contact depth (m, >=0).  */
  leftDepth: number;
  /** Last computed right-wheel ground contact depth (m, >=0). */
  rightDepth: number;
  /** Was the left wheel in contact with anything this tick? */
  leftContact: boolean;
  rightContact: boolean;
}

export function createAxleState(geom: AxleGeom): AxleState {
  return {
    geom,
    rideY: 0,
    rideVelY: 0,
    rollAngle: 0,
    rollVel: 0,
    leftDepth: 0,
    rightDepth: 0,
    leftContact: false,
    rightContact: false,
  };
}

export function resetAxleState(s: AxleState): void {
  s.rideY = 0;
  s.rideVelY = 0;
  s.rollAngle = 0;
  s.rollVel = 0;
  s.leftDepth = 0;
  s.rightDepth = 0;
  s.leftContact = false;
  s.rightContact = false;
}

export interface StepAxleResult {
  /** Reaction force on the chassis along chassis-up at the axle anchor (N). */
  chassisRideForce: number;
  /** Reaction torque on the chassis about chassis-forward at the axle
   *  anchor (N*m). Non-zero only when rollAngle is clamped to
   *  +/- maxArticulation - that's the surplus articulation pushing the
   *  body over. */
  chassisRollTorque: number;
}

export interface StepAxleInputs {
  /** Wheel-end ground compression depths from the latest raycasts (m). */
  leftDepth: number;
  rightDepth: number;
  /** Whether each ray hit anything (no contact -> the spring relaxes). */
  leftContact: boolean;
  rightContact: boolean;
  /** Vertical component of the chassis velocity at the axle anchor in
   *  world space, used so chassis motion damps the axle correctly. */
  chassisVertVelAtAnchor: number;
  dt: number;
  /** Internal sub-stepping count for stability at high spring rates.
   *  Defaults to 4 - cheap because the axle math is tiny. */
  substeps?: number;
}

/** Advance an AxleState one fixed timestep. Pure: mutates `s` in place
 *  and returns the chassis reaction terms. Sub-steps the integrator
 *  internally for unconditional stability up to ~200k N/m spring rates. */
export function stepAxle(s: AxleState, input: StepAxleInputs): StepAxleResult {
  const g = s.geom;
  const subs = Math.max(1, input.substeps ?? 4);
  const h = input.dt / subs;

  // The springs only push when the wheel is actually touching ground.
  // No-contact wheels droop to their stop and contribute nothing.
  const lc = input.leftContact ? input.leftDepth : 0;
  const rc = input.rightContact ? input.rightDepth : 0;
  s.leftDepth = lc;
  s.rightDepth = rc;
  s.leftContact = input.leftContact;
  s.rightContact = input.rightContact;

  const avgComp = 0.5 * (lc + rc);
  // Target articulation = atan of the wheel-end height delta over the
  // axle's full track. Solving exactly tracks ground slope across the
  // wheels; the spring then carries rollAngle toward this target.
  const targetRoll = Math.atan2(rc - lc, 2 * g.trackHalf);

  for (let i = 0; i < subs; i++) {
    // Ride dynamics. The spring force on the axle from the ground is
    // rideStiffness * avgComp; on top of that, the damping term scales
    // the axle's local vertical velocity relative to the chassis at the
    // anchor (so the axle settles instead of bouncing forever).
    const groundForce = g.rideStiffness * avgComp;
    const relVel = s.rideVelY - input.chassisVertVelAtAnchor;
    const dampF = -g.rideDamping * relVel;
    // Axle weight pulls the hub down; chassis weight is handled by
    // gravity on the chassis body itself (Rapier integrates it). The
    // axle mass is a free body relative to the chassis between its
    // droop/bump stops; gravity on it shows up here.
    const axleWeight = g.axleMass * GRAVITY_Y;
    const accel = (groundForce + dampF + axleWeight) / g.axleMass;
    s.rideVelY += accel * h;
    s.rideY += s.rideVelY * h;
    if (s.rideY > g.bumpMax) {
      s.rideY = g.bumpMax;
      if (s.rideVelY > 0) s.rideVelY = 0;
    } else if (s.rideY < -g.droopMax) {
      s.rideY = -g.droopMax;
      if (s.rideVelY < 0) s.rideVelY = 0;
    }

    // Roll dynamics. Spring restores toward the terrain target; damping
    // resists rapid articulation. Mass moment is axleRollInertia.
    const rollErr = targetRoll - s.rollAngle;
    const rollAccel = (g.rollStiffness * rollErr - g.rollDamping * s.rollVel) / g.axleRollInertia;
    s.rollVel += rollAccel * h;
    s.rollAngle += s.rollVel * h;
    if (s.rollAngle > g.maxArticulation) {
      s.rollAngle = g.maxArticulation;
      if (s.rollVel > 0) s.rollVel = 0;
    } else if (s.rollAngle < -g.maxArticulation) {
      s.rollAngle = -g.maxArticulation;
      if (s.rollVel < 0) s.rollVel = 0;
    }
  }

  // Force the chassis sees from this axle = the spring pre-load. With
  // axle compressed (rideY < 0) the spring pushes the chassis up; with
  // axle extended (rideY > 0) it pulls down. Damping uses the same
  // relative-velocity term so chassis motion doesn't ring on top of the
  // axle's own settling.
  const relVelEnd = s.rideVelY - input.chassisVertVelAtAnchor;
  const chassisRideForce = -g.rideStiffness * s.rideY - g.rideDamping * relVelEnd;

  // Surplus articulation past the mechanical stop becomes a torque on
  // the chassis. Below the cap it's zero (the axle is free to flex).
  let chassisRollTorque = 0;
  const surplus = targetRoll - s.rollAngle;
  if (s.rollAngle >= g.maxArticulation && surplus > 0) {
    chassisRollTorque = g.rollStiffness * surplus;
  } else if (s.rollAngle <= -g.maxArticulation && surplus < 0) {
    chassisRollTorque = g.rollStiffness * surplus;
  }

  return { chassisRideForce, chassisRollTorque };
}

export interface AxleSnap {
  rideY: number;
  rollAngle: number;
}

export function axleSnap(s: AxleState): AxleSnap {
  return { rideY: s.rideY, rollAngle: s.rollAngle };
}

export function applyAxleSnap(s: AxleState, snap: AxleSnap): void {
  s.rideY = snap.rideY;
  s.rollAngle = snap.rollAngle;
  s.rideVelY = 0;
  s.rollVel = 0;
}
