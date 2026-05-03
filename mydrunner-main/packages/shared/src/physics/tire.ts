// Cheap Pacejka-style longitudinal grip curve. Returns a multiplier in
// [TIRE.slipFloor, 1.0] for the engine force at a wheel given its slip
// ratio. Models the basic phenomenon: if you spin a wheel faster than
// the contact patch can grip, you LOSE traction. So mashing the throttle
// in mud isn't just slow because of low surface friction - it's slow
// because the tire is breaking loose and not transmitting torque.
//
// Slip ratio = (wheelSurfaceSpeed - groundSpeed) / max(|wheelSurfaceSpeed|, |groundSpeed|, eps)
// where wheelSurfaceSpeed = wheelAngVel * wheelRadius.

import { TUNING } from '../tuning.js';

// Velocity floor for the slip-ratio denominator. Below this, slip is
// computed against a fixed reference rather than the actual (tiny) max
// of wheelLin / groundSpeed. The old 0.5 m/s floor meant any sub-0.5
// velocity mismatch (which is normal under hard initial throttle, light
// braking, or tight slow turns) registered as full slip and the grip
// curve dropped to slipFloor - so the truck felt greasy at low speed.
// 2.5 m/s keeps the slip ratio inside the linear ramp of the curve at
// typical low-speed throttle inputs, giving a confident bite off the
// line without changing high-speed behaviour (above 2.5 m/s the floor
// is dominated by the actual velocities and never engages).
const SLIP_VEL_FLOOR = 2.5;

export function slipRatio(wheelAngVel: number, wheelRadius: number, groundSpeed: number): number {
  const wheelLin = wheelAngVel * wheelRadius;
  const denom = Math.max(Math.abs(wheelLin), Math.abs(groundSpeed), SLIP_VEL_FLOOR);
  return (wheelLin - groundSpeed) / denom;
}

/** Grip multiplier as a function of slip ratio. Always >= slipFloor so a
 *  tire at zero slip still has meaningful grip (otherwise the model
 *  deadlocks at standstill: no slip -> no grip -> no acceleration ->
 *  still no slip). Peak at slipPeak, decays toward slipFloor past it. */
export function gripFromSlip(slip: number): number {
  const a = Math.abs(slip);
  const peak = TUNING.slipPeak;
  const floor = TUNING.slipFloor;
  if (a <= peak) {
    const t = a / peak;
    return floor + (1 - floor) * t;
  }
  const over = a - peak;
  const decay = Math.exp(-over * TUNING.slipFalloff);
  return floor + (1 - floor) * decay;
}
