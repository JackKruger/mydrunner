// Axle state for the solid-axle vehicle model. An axle has two degrees
// of freedom relative to its chassis attachment:
//
//   rideY     - vertical translation along the axle's mount.
//   rollAngle - rotation of the axle beam about the chassis-forward axis.
//
// The model is kinematic: each tick we set rideY to track average ground
// compression and rollAngle to track terrain slope across the wheels,
// both clamped at their travel limits. The "spring" dynamics live on the
// chassis: the per-tick ride and roll forces produced here drive the
// chassis Rapier rigid body, and Rapier integrates the chassis bounce.
// This avoids the stability headache of a separate axle integrator at a
// tick rate where axle natural frequencies (omega ~ sqrt(k/m_axle) ~ 27
// rad/s) are close to Nyquist.
//
// The articulation cap is enforced here: when terrain demands more roll
// than maxArticulation, rollAngle clamps and the surplus torque dumps
// onto the chassis - that's the lean-over-a-rock behaviour that gives
// solid-axle rock crawlers their distinctive look.
//
// Pure functions; no Rapier handles. Tested in shared/__tests__/axle.test.ts.

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
  /** Whether each ray hit anything (no contact -> no ride force). */
  leftContact: boolean;
  rightContact: boolean;
  /** Vertical component of the chassis velocity at the axle anchor in
   *  world space, used to damp chassis bounce on the ride spring. */
  chassisVertVelAtAnchor: number;
  dt: number;
}

/** Advance an AxleState one fixed timestep. Kinematic: rideY tracks
 *  average ground compression, rollAngle tracks terrain slope; both
 *  clamped at their travel limits. Returns the per-tick reaction force
 *  on the chassis (ride spring + damper) and roll torque (only non-zero
 *  past the articulation cap). */
export function stepAxle(s: AxleState, input: StepAxleInputs): StepAxleResult {
  const g = s.geom;

  const lc = input.leftContact ? input.leftDepth : 0;
  const rc = input.rightContact ? input.rightDepth : 0;
  s.leftDepth = lc;
  s.rightDepth = rc;
  s.leftContact = input.leftContact;
  s.rightContact = input.rightContact;

  // rideY: average compression. Visual only — solidAxleVehicle.ts
  // ignores stepAxle's chassisRideForce and applies per-wheel-end ride
  // forces directly, so the cap here only affects the wheel-mesh
  // position, not the suspension force. We allow rideY to track the
  // raw compression past bumpMax (capped at restLength * 0.85, which
  // keeps the wheel mesh below the chassis attachment point so it
  // doesn't visibly intersect the chassis body when a sharp rise
  // pushes the ray reading deep).
  //
  // In-air handling: when neither wheel is in contact we hold the
  // previous rideY rather than snapping to zero (full droop). The
  // snap-to-zero behaviour produced a visible "diffs extend / wheels
  // detach from the body" pop the moment all four wheels left the
  // ground (jumps, flips, the airborne phase of cresting a sharp
  // ridge). Holding lets the wheels stay where they were last loaded;
  // when they next make contact the visual catches up to the new
  // ground reading next tick. rideY is visual-only so this doesn't
  // change the physics behaviour at all.
  const visualMax = g.suspensionRestLength * 0.85;
  const prevY = s.rideY;
  let targetY: number;
  if (!input.leftContact && !input.rightContact) {
    targetY = -g.droopMax;
  } else {
    const avgComp = 0.5 * (lc + rc);
    targetY = avgComp;
    if (targetY > visualMax) targetY = visualMax;
    // Allow negative rideY for droop (wheels hanging below rest).
    // Clamped at -droopMax to match physical limit.
    if (targetY < -g.droopMax) targetY = -g.droopMax;
  }
  s.rideY = targetY;
  s.rideVelY = input.dt > 0 ? (s.rideY - prevY) / input.dt : 0;

  // rollAngle tracks terrain slope across the wheels, clamped at the
  // articulation cap. Anything past the cap dumps surplus into the
  // chassis as a torque - that's the body-lean-over-a-rock behaviour.
  const targetRoll = Math.atan2(rc - lc, 2 * g.trackHalf);
  let clampedRoll = targetRoll;
  if (clampedRoll > g.maxArticulation) clampedRoll = g.maxArticulation;
  else if (clampedRoll < -g.maxArticulation) clampedRoll = -g.maxArticulation;
  const prevRoll = s.rollAngle;
  s.rollAngle = clampedRoll;
  s.rollVel = input.dt > 0 ? (s.rollAngle - prevRoll) / input.dt : 0;

  // Ride force on chassis: positive (up) when axle is compressed
  // (rideY > 0). The damping term is scaled by spring engagement
  // (rideY / restLength), so a chassis hitting the spring at speed
  // gets a soft initial response that builds with compression - this
  // matches a real shock absorber where fluid bandwidth limits the
  // peak force at the moment of contact, and avoids huge impulses
  // that otherwise launch the chassis off its first contact.
  const engagement = Math.min(1, s.rideY / g.suspensionRestLength);
  const chassisRideForce =
    s.rideY > 1e-6
      ? g.rideStiffness * s.rideY
        - g.rideDamping * engagement * input.chassisVertVelAtAnchor
      : 0;

  let chassisRollTorque = 0;
  if (Math.abs(targetRoll) > g.maxArticulation) {
    const surplus = targetRoll - clampedRoll;
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
