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
  };
}

export function resetWheelKinematic(w: WheelKinematic): void {
  w.spin = 0;
  w.angVel = 0;
  w.contact = false;
  w.contactDepth = 0;
  w.prevContactDepth = -1;
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
  w.angVel += (net / WHEEL.inertia) * dt;
}
