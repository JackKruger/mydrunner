// Per-wheel angular velocity integrator for the solid-axle vehicle model.
//
// The Rapier raycast vehicle hides this inside its controller. With the
// custom model we own it: drive torque from the engine, brake torque
// from the player, ground reaction torque from the longitudinal grip
// force the tyre actually transmits. Their net acts on the wheel's
// rotational inertia.
//
// Pure functions. Tested via the axle integration tests + the higher-
// level articulation tests.

import { WHEEL } from '../constants.js';

export interface WheelKinematic {
  /** Accumulated rotation of the wheel for visuals (rad). */
  spin: number;
  /** Current angular velocity (rad/s). +ve means the wheel is rotating
   *  in the direction that would drive the vehicle forward. */
  angVel: number;
  /** Was the wheel touching ground in the latest raycast? */
  contact: boolean;
  /** Compression of the spring at this wheel-end (m, >=0). */
  contactDepth: number;
  /** Previous tick's clamped compression (in [0, bumpMax]) for compression-
   *  rate damping. Sentinel -1 means uninitialized — first-contact tick uses
   *  rate=0 to avoid a 0→equilibrium spike that would slam the chassis. */
  prevContactDepth: number;
  /** World-space contact point for force application. */
  contactPoint: { x: number; y: number; z: number };
  /** World-space contact normal. */
  contactNormal: { x: number; y: number; z: number };
  /** Sampled surface id under the wheel (Surface enum value). */
  surface: number;
  /** Vertical force from the suspension last tick (N). */
  lastForce?: number;
  /** Ray depth after ledge-to-top continuity limiting. This is the depth
   *  consumed by suspension forces and axle visuals; contactDepth remains
   *  the raw geometric query result. */
  resolvedDepth: number;
  resolvedDepthInitialized: boolean;
  /** True while resolvedDepth is converging after a steep contact. */
  ledgeHandoff: boolean;
  /** Short support bridge between corner contact and top-surface ray. */
  ledgeHandoffGrace: number;
  /** Whether the tyre-volume query found a steep face this tick. */
  ledgeContact: boolean;
  /** Number of retained independent steep constraints (0..2). */
  ledgeContactCount: number;
  /** Internal diagnostics and integration-test observability. */
  ledgeNormalForce: number;
  ledgeLongForce: number;
  /** Previous world-space wheel centre for swept tyre-volume queries. */
  previousCenter: { x: number; y: number; z: number };
  hasPreviousCenter: boolean;
  /** Grip source for the support ray: terrain tuning or hit-collider
   *  friction, selected after the raycast. */
  supportGrip: number;
  supportIsTerrain: boolean;
  supportColliderFriction: number;
  /** True when the full tyre-cylinder sweep, rather than the centre ray,
   *  supplied this tick's terrain support. */
  volumeSupport: boolean;
  /** Metres of water over this wheel's contact point, 0 on dry ground.
   *  Feeds both the grip multiplier and the extra rolling resistance of
   *  wading, and is read by the renderer for wheel spray. */
  waterDepth: number;
  tireDeflection: number;
  previousTireDeflection: number;
  tireContactNormal: { x: number; y: number; z: number };
  contactZone: 'tread' | 'shoulder' | 'sidewall' | 'air';
  treadFraction: number;
  suspensionAxisAlignment: number;
  carcassForce: number;
  suspensionForce: number;
  tireDeflectionRate: number;
  /** Series longitudinal force after relaxation (N). */
  relaxedLongitudinalForce: number;
  sinkDepth: number;
  slipDisplacement: number;
  soilCompaction: number;
  bulldozingResistance: number;
  slipWork: number;
  soilResult: {
    contactArea: number;
    shearMultiplier: number;
    bulldozingForce: number;
    targetSinkDepth: number;
  };
}

export function createWheelKinematic(): WheelKinematic {
  return {
    spin: 0,
    angVel: 0,
    contact: false,
    contactDepth: 0,
    prevContactDepth: -1,
    contactPoint: { x: 0, y: 0, z: 0 },
    contactNormal: { x: 0, y: 1, z: 0 },
    surface: 1,
    lastForce: 0,
    resolvedDepth: 0,
    resolvedDepthInitialized: false,
    ledgeHandoff: false,
    ledgeHandoffGrace: 0,
    ledgeContact: false,
    ledgeContactCount: 0,
    ledgeNormalForce: 0,
    ledgeLongForce: 0,
    previousCenter: { x: 0, y: 0, z: 0 },
    hasPreviousCenter: false,
    supportGrip: 1,
    supportIsTerrain: true,
    supportColliderFriction: 1,
    volumeSupport: false,
    waterDepth: 0,
    tireDeflection: 0,
    previousTireDeflection: 0,
    tireContactNormal: { x: 0, y: 1, z: 0 },
    contactZone: 'air',
    treadFraction: 0,
    suspensionAxisAlignment: 0,
    carcassForce: 0,
    suspensionForce: 0,
    tireDeflectionRate: 0,
    relaxedLongitudinalForce: 0,
    sinkDepth: 0,
    slipDisplacement: 0,
    soilCompaction: 0,
    bulldozingResistance: 0,
    slipWork: 0,
    soilResult: { contactArea: 0, shearMultiplier: 1, bulldozingForce: 0, targetSinkDepth: 0 },
  };
}

export function resetWheelKinematic(w: WheelKinematic): void {
  w.spin = 0;
  w.angVel = 0;
  w.contact = false;
  w.contactDepth = 0;
  w.prevContactDepth = -1;
  w.lastForce = 0;
  w.resolvedDepth = 0;
  w.resolvedDepthInitialized = false;
  w.ledgeHandoff = false;
  w.ledgeHandoffGrace = 0;
  w.ledgeContact = false;
  w.ledgeContactCount = 0;
  w.ledgeNormalForce = 0;
  w.ledgeLongForce = 0;
  w.hasPreviousCenter = false;
  w.supportGrip = 1;
  w.supportIsTerrain = true;
  w.supportColliderFriction = 1;
  w.volumeSupport = false;
  w.waterDepth = 0;
  w.tireDeflection = 0;
  w.previousTireDeflection = 0;
  w.tireContactNormal = { x: 0, y: 1, z: 0 };
  w.contactZone = 'air';
  w.treadFraction = 0;
  w.suspensionAxisAlignment = 0;
  w.carcassForce = 0;
  w.suspensionForce = 0;
  w.tireDeflectionRate = 0;
  w.relaxedLongitudinalForce = 0;
  w.sinkDepth = 0;
  w.slipDisplacement = 0;
  w.soilCompaction = 0;
  w.bulldozingResistance = 0;
  w.slipWork = 0;
  w.soilResult.contactArea = 0;
  w.soilResult.shearMultiplier = 1;
  w.soilResult.bulldozingForce = 0;
  w.soilResult.targetSinkDepth = 0;
}

/** Integrate wheel angular velocity by net torque this tick.
 *
 *  driveTorque  - torque applied by the engine through the drivetrain
 *                 (signed; +ve drives the vehicle forward, -ve reverse).
 *  brakeTorque  - magnitude of the brake torque (>=0). Always opposes
 *                 the current angVel.
 *  groundTorque - torque the ground exerts on the wheel through the
 *                 longitudinal grip force. Caller computes this from
 *                 the slip-curve grip and the contact patch radius.
 *                 Sign opposes whichever way the wheel is slipping
 *                 relative to the ground.
 */
export function integrateWheelSpin(
  w: WheelKinematic,
  driveTorque: number,
  brakeTorque: number,
  groundTorque: number,
  dt: number,
  rollingResistance: number = WHEEL.rollingResistance,
  inertia: number = WHEEL.inertia,
): void {
  // Brake torque opposes the current angVel; if the wheel is stopped
  // and only brake is applied, hold it at zero (don't let brake reverse
  // the wheel and then reverse again - spurious oscillation).
  let brake = 0;
  if (Math.abs(w.angVel) > 1e-3) {
    brake = -Math.sign(w.angVel) * brakeTorque;
  } else if (brakeTorque > Math.abs(driveTorque + groundTorque)) {
    // Brake holds the wheel locked.
    w.angVel = 0;
    return;
  }
  // Rolling resistance: drag torque proportional to angVel that
  // bleeds spin off when the throttle is off. Can be increased on
  // soft surfaces like mud.
  const rolling = -rollingResistance * w.angVel;
  const net = driveTorque + brake + groundTorque + rolling;
  const newAngVel = w.angVel + (net / Math.max(1e-4, inertia)) * dt;
  // Brake-induced wheel-sign flip protection: if a brake (and only a
  // brake) is strong enough to reverse the wheel's direction in a
  // single tick, the integrator without this clamp will overshoot to
  // the opposite sign and then flip back next tick, producing a high-
  // frequency oscillation. The friction-circle reads alternating
  // signed slip, so chassis-side longitudinal force averages near zero
  // and braking force is mostly self-cancelling. Real-world wheels
  // can't reverse direction under brake alone — they lock at zero —
  // so clamp the result to 0 whenever brake (without help from drive
  // torque or ground reaction) is what flipped the sign.
  if (
    Math.abs(w.angVel) > 1e-3
    && Math.sign(newAngVel) !== Math.sign(w.angVel)
    && brakeTorque > Math.abs(driveTorque + groundTorque)
  ) {
    w.angVel = 0;
    return;
  }
  w.angVel = newAngVel;
}
