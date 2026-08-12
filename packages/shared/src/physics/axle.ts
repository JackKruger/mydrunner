// Axle state for the solid-axle vehicle model. An axle has two degrees
// of freedom relative to its chassis attachment:
//
//   rideY     - vertical translation along the axle's mount.
//   rollAngle - rotation of the axle beam about the chassis-forward axis.
//
// The axle pose follows average ground compression and terrain slope with
// damped unsprung-mass dynamics. It is still kinematic from Rapier's point
// of view (there is no separate rigid body), but rideY/rollAngle cannot
// teleport when a support ray is gained or lost. The chassis spring forces
// remain in SolidAxleVehicle; this integration is for the beam/wheel pose.
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
  /** Instantaneous support-derived ride pose used by contact queries.
   *  rideY follows this value with unsprung-mass dynamics for visuals. */
  targetRideY: number;
  /** Rate of change of rideY (m/s). */
  rideVelY: number;
  /** Rotation of the axle beam about the chassis-forward axis (rad).
   *  Positive = right-hand wheel up, left-hand wheel down. Clamped to
   *  +/- maxArticulation. */
  rollAngle: number;
  /** Instantaneous support-derived roll used by physical contact queries.
   *  rollAngle follows this value with axle rotational inertia. */
  targetRollAngle: number;
  /** Rate of change of rollAngle (rad/s). */
  rollVel: number;
  /** Last computed left-wheel ground contact depth (m, >=0).  */
  leftDepth: number;
  /** Last computed right-wheel ground contact depth (m, >=0). */
  rightDepth: number;
  /** Was the left wheel in contact with anything this tick? */
  leftContact: boolean;
  rightContact: boolean;
  /** Allocation-free integrator scratch, owned by this axle. */
  rideDof: [number, number];
  rollDof: [number, number];
  stepResult: StepAxleResult;
  travelStops: [TravelStopForce, TravelStopForce];
}

export function createAxleState(geom: AxleGeom): AxleState {
  return {
    geom,
    rideY: 0,
    targetRideY: 0,
    rideVelY: 0,
    rollAngle: 0,
    targetRollAngle: 0,
    rollVel: 0,
    leftDepth: 0,
    rightDepth: 0,
    leftContact: false,
    rightContact: false,
    rideDof: [0, 0],
    rollDof: [0, 0],
    stepResult: { chassisRideForce: 0, chassisRollTorque: 0 },
    travelStops: [
      { bumpForce: 0, reboundForce: 0, totalForce: 0 },
      { bumpForce: 0, reboundForce: 0, totalForce: 0 },
    ],
  };
}

export function resetAxleState(s: AxleState): void {
  s.rideY = 0;
  s.targetRideY = 0;
  s.rideVelY = 0;
  s.rollAngle = 0;
  s.targetRollAngle = 0;
  s.rollVel = 0;
  s.leftDepth = 0;
  s.rightDepth = 0;
  s.leftContact = false;
  s.rightContact = false;
  s.rideDof[0] = 0;
  s.rideDof[1] = 0;
  s.rollDof[0] = 0;
  s.rollDof[1] = 0;
  s.stepResult.chassisRideForce = 0;
  s.stepResult.chassisRollTorque = 0;
  for (const stop of s.travelStops) {
    stop.bumpForce = 0;
    stop.reboundForce = 0;
    stop.totalForce = 0;
  }
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
  /** Runtime scalars on the geom's roll spring and articulation cap
   *  (TUNING.axleFront / axleRear). Passed in rather than imported so
   *  this module stays free of shared mutable state and the axle tests
   *  can exercise a scale factor directly. Default 1 = use geom as-is. */
  rideStiffnessMult?: number;
  rideDampingMult?: number;
  rollStiffnessMult?: number;
  maxArticulationMult?: number;
}

export interface AntiRollLoadInput {
  /** Suspension pose relative to the chassis. Unsupported ends should be
   *  passed at full droop so one-wheel articulation can tension the bar. */
  leftDepth: number;
  rightDepth: number;
  leftRate: number;
  rightRate: number;
  leftSupported: boolean;
  rightSupported: boolean;
  trackHalf: number;
  torqueStiffness: number;
  torqueDamping: number;
  maxTransferForce: number;
}

export interface AntiRollLoadTransfer {
  /** Additions to the existing wheel-end support forces (N). */
  leftForce: number;
  rightForce: number;
}

export interface TravelStopForce {
  bumpForce: number;
  reboundForce: number;
  totalForce: number;
}

/** Progressive bump/rebound stops expressed as wheel-end forces. */
/** @hotloop */
export function progressiveTravelStopForce(
  travel: number,
  bumpMax: number,
  droopMax: number,
  mainSpringRate: number,
  out: TravelStopForce = { bumpForce: 0, reboundForce: 0, totalForce: 0 },
): TravelStopForce {
  const bumpStart = Math.max(0, bumpMax) * 0.80;
  const bumpRange = Math.max(1e-6, Math.max(0, bumpMax) - bumpStart);
  const bumpT = clamp01((travel - bumpStart) / bumpRange);
  const bumpForce = 4 * Math.max(0, mainSpringRate) * bumpRange * bumpT * bumpT;

  const reboundStart = -Math.max(0, droopMax) * 0.85;
  const reboundRange = Math.max(1e-6, Math.max(0, droopMax) * 0.15);
  const reboundT = clamp01((reboundStart - travel) / reboundRange);
  const reboundForce = reboundT > 0
    ? -1.5 * Math.max(0, mainSpringRate) * reboundRange * reboundT * reboundT
    : 0;
  out.bumpForce = bumpForce;
  out.reboundForce = reboundForce;
  out.totalForce = bumpForce + reboundForce;
  return out;
}

/** Apply the force opposite to chassis-mounted travel stops to the beam's
 * generalized heave and roll velocities. This is the unsprung half of an
 * internal reaction pair; the caller applies the supplied forces to the
 * chassis at the corresponding mounts. */
/** @hotloop */
export function applyTravelStopReactionToAxle(
  s: AxleState,
  leftChassisForce: number,
  rightChassisForce: number,
  dt: number,
): void {
  if (dt <= 0) return;
  const axleForce = -(leftChassisForce + rightChassisForce);
  s.rideVelY += axleForce / Math.max(1e-6, s.geom.axleMass) * dt;
  const chassisTorque = -s.geom.trackHalf * leftChassisForce
    + s.geom.trackHalf * rightChassisForce;
  s.rollVel += -chassisTorque / Math.max(1e-6, s.geom.axleRollInertia) * dt;
}

/** Convert relative axle articulation into paired wheel-end load transfer.
 * There is deliberately no chassis/world orientation in this calculation:
 * a sway bar reacts suspension displacement, not gravity. Unsupported ends
 * cannot pass their half of the pair into the chassis, and with neither end
 * supported the bar cannot act at all. */
/** @hotloop */
export function computeAntiRollLoadTransfer(
  input: AntiRollLoadInput,
  out: AntiRollLoadTransfer = { leftForce: 0, rightForce: 0 },
): AntiRollLoadTransfer {
  if (!input.leftSupported && !input.rightSupported) {
    out.leftForce = 0;
    out.rightForce = 0;
    return out;
  }
  const track = Math.max(1e-6, input.trackHalf * 2);
  const forceStiffness = input.torqueStiffness / (track * track);
  const forceDamping = input.torqueDamping / (track * track);
  // Compression displacement and compression velocity have opposite
  // force conventions: the spring pushes the chassis toward the less-
  // compressed end, while the damper opposes the end currently gaining
  // compression. Keeping the signs explicit avoids turning the bar into
  // positive feedback on cross-slopes.
  const rawTransfer =
    -forceStiffness * (input.leftDepth - input.rightDepth)
    + forceDamping * (input.leftRate - input.rightRate);
  const limit = Math.max(0, input.maxTransferForce);
  const transfer = Math.max(-limit, Math.min(limit, rawTransfer));
  if (Math.abs(transfer) < 1e-12) {
    out.leftForce = 0;
    out.rightForce = 0;
    return out;
  }
  out.leftForce = input.leftSupported ? transfer : 0;
  out.rightForce = input.rightSupported ? -transfer : 0;
  return out;
}

/** Advance an AxleState one fixed timestep. The target pose comes from
 *  wheel support, while a stable implicit spring step gives the axle its
 *  unsprung mass/inertia instead of snapping straight to that target.
 *  Returns the per-tick reaction force on the chassis (ride spring +
 *  damper) and roll torque (only non-zero past the articulation cap). */
/** @hotloop */
export function stepAxle(
  s: AxleState,
  input: StepAxleInputs,
  out: StepAxleResult = { chassisRideForce: 0, chassisRollTorque: 0 },
): StepAxleResult {
  const g = s.geom;

  const lc = input.leftContact ? input.leftDepth : 0;
  const rc = input.rightContact ? input.rightDepth : 0;
  // A wheel with no support hangs at the suspension's droop stop. Treating
  // it as zero compression put it at the nominal rest position instead,
  // which made a one-wheel-loaded axle look parallel to the leaning body.
  const leftPoseDepth = input.leftContact ? input.leftDepth : -g.droopMax;
  const rightPoseDepth = input.rightContact ? input.rightDepth : -g.droopMax;
  s.leftDepth = lc;
  s.rightDepth = rc;
  s.leftContact = input.leftContact;
  s.rightContact = input.rightContact;

  // rideY target: average compression. Visual only — solidAxleVehicle.ts
  // ignores stepAxle's chassisRideForce and applies per-wheel-end ride
  // forces directly, so the cap here only affects the wheel-mesh
  // position, not the suspension force. We allow rideY to track the
  // raw compression past bumpMax (capped at restLength * 0.85, which
  // keeps the wheel mesh below the chassis attachment point so it
  // doesn't visibly intersect the chassis body when a sharp rise
  // pushes the ray reading deep).
  //
  // In-air handling: when neither wheel is in contact the target moves to
  // full droop, but the unsprung-mass step below makes the axle extend
  // progressively. It therefore hangs naturally without the old one-frame
  // "diffs extend / wheels detach" pop on jumps and ridge crests.
  const visualMax = g.suspensionRestLength * 0.85;
  let targetY: number;
  if (!input.leftContact && !input.rightContact) {
    targetY = -g.droopMax;
  } else {
    const avgComp = 0.5 * (leftPoseDepth + rightPoseDepth);
    targetY = avgComp;
    if (targetY > visualMax) targetY = visualMax;
    // Allow negative rideY for droop (wheels hanging below rest).
    // Clamped at -droopMax to match physical limit.
    if (targetY < -g.droopMax) targetY = -g.droopMax;
  }
  s.targetRideY = targetY;
  if (input.dt > 0) {
    stepDampedDof(
      s.rideY,
      s.rideVelY,
      targetY,
      g.rideStiffness * (input.rideStiffnessMult ?? 1),
      g.rideDamping * (input.rideDampingMult ?? 1),
      g.axleMass,
      input.dt,
      s.rideDof,
    );
    clampDof(
      s.rideDof[0],
      s.rideDof[1],
      -g.droopMax,
      visualMax,
      s.rideDof,
    );
    s.rideY = s.rideDof[0];
    s.rideVelY = s.rideDof[1];
  }

  // rollAngle targets terrain slope across the wheels. The beam's roll
  // inertia and damping stop a contact transition from rotating the whole
  // axle in one frame. Anything past the articulation cap still dumps its
  // surplus into the chassis as a torque.
  const maxArticulation = g.maxArticulation * (input.maxArticulationMult ?? 1);
  const targetRoll = Math.atan2(
    rightPoseDepth - leftPoseDepth,
    2 * g.trackHalf,
  );
  let clampedRoll = targetRoll;
  if (clampedRoll > maxArticulation) clampedRoll = maxArticulation;
  else if (clampedRoll < -maxArticulation) clampedRoll = -maxArticulation;
  s.targetRollAngle = clampedRoll;
  if (input.dt > 0) {
    stepDampedDof(
      s.rollAngle,
      s.rollVel,
      clampedRoll,
      g.rollStiffness * (input.rollStiffnessMult ?? 1),
      g.rollDamping,
      g.axleRollInertia,
      input.dt,
      s.rollDof,
    );
    clampDof(
      s.rollDof[0],
      s.rollDof[1],
      -maxArticulation,
      maxArticulation,
      s.rollDof,
    );
    s.rollAngle = s.rollDof[0];
    s.rollVel = s.rollDof[1];
  }

  // A tyre cannot visually lag *through* rising ground. Keep the damped axle
  // DOFs for unloading and articulation, then treat support as a one-sided
  // constraint by lifting the rigid beam just enough that neither supported
  // end is below its geometric depth. On a one-wheel rise this may briefly
  // leave the other wheel above ground while roll catches up, which is the
  // physically valid alternative to drawing the loaded tyre underground.
  const sinVisualRoll = Math.sin(s.rollAngle);
  const visualLeftDepth = s.rideY - g.trackHalf * sinVisualRoll;
  const visualRightDepth = s.rideY + g.trackHalf * sinVisualRoll;
  let supportCorrection = 0;
  if (input.leftContact) {
    supportCorrection = Math.max(supportCorrection, leftPoseDepth - visualLeftDepth);
  }
  if (input.rightContact) {
    supportCorrection = Math.max(supportCorrection, rightPoseDepth - visualRightDepth);
  }
  if (supportCorrection > 0) {
    // Contact/beam correction is a one-sided positional constraint, not an
    // impulse. Bound it to 3 m/s of beam travel so a discontinuous support
    // query cannot teleport the axle through its chassis in one tick.
    const boundedCorrection = Math.min(supportCorrection, 0.025);
    s.rideY = Math.min(visualMax, s.rideY + boundedCorrection);
    s.rideVelY = 0;
  }

  // Ride force on chassis: positive (up) when the support target is
  // compressed. The damping term is scaled by spring engagement
  // (targetY / restLength), so a chassis hitting the spring at speed
  // gets a soft initial response that builds with compression - this
  // matches a real shock absorber where fluid bandwidth limits the
  // peak force at the moment of contact, and avoids huge impulses
  // that otherwise launch the chassis off its first contact.
  // The legacy aggregate is retained for callers/tests even though the
  // production vehicle applies its ride forces separately at each wheel.
  // An unsupported end contributes no spring force, not negative force.
  const supportRideY = 0.5 * (lc + rc);
  const engagement = Math.min(1, supportRideY / g.suspensionRestLength);
  const chassisRideForce =
    supportRideY > 1e-6
      ? g.rideStiffness * supportRideY
        - g.rideDamping * engagement * input.chassisVertVelAtAnchor
      : 0;

  let chassisRollTorque = 0;
  if (Math.abs(targetRoll) > maxArticulation) {
    const surplus = targetRoll - clampedRoll;
    chassisRollTorque = g.rollStiffness * (input.rollStiffnessMult ?? 1) * surplus;
  }

  out.chassisRideForce = chassisRideForce;
  out.chassisRollTorque = chassisRollTorque;
  return out;
}

/** Implicit Euler step for a damped spring following a moving target.
 *  Unlike an explicit spring step this remains stable when the axle's
 *  natural frequency is a sizeable fraction of the 60 Hz physics rate. */
function stepDampedDof(
  position: number,
  velocity: number,
  target: number,
  stiffness: number,
  damping: number,
  mass: number,
  dt: number,
  out: [number, number] = [0, 0],
): [number, number] {
  const safeMass = Math.max(1e-6, mass);
  const stiffnessPerMass = Math.max(0, stiffness) / safeMass;
  const dampingPerMass = Math.max(0, damping) / safeMass;
  const nextVelocity = (
    velocity + dt * stiffnessPerMass * (target - position)
  ) / (
    1 + dt * dampingPerMass + dt * dt * stiffnessPerMass
  );
  out[0] = position + dt * nextVelocity;
  out[1] = nextVelocity;
  return out;
}

/** Stop a DOF cleanly at a mechanical limit without retaining velocity
 *  that points farther through the stop. */
function clampDof(
  position: number,
  velocity: number,
  min: number,
  max: number,
  out: [number, number] = [0, 0],
): [number, number] {
  out[0] = position < min ? min : position > max ? max : position;
  out[1] = position < min && velocity < 0
    ? 0
    : position > max && velocity > 0 ? 0 : velocity;
  return out;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
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
  s.targetRideY = snap.rideY;
  s.rollAngle = snap.rollAngle;
  s.targetRollAngle = snap.rollAngle;
  s.rideVelY = 0;
  s.rollVel = 0;
}
