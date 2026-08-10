// Cheap Pacejka-style longitudinal grip curve. Returns a multiplier in
// [TIRE.slipFloor, 1.0] for the engine force at a wheel given its slip
// ratio. Models the basic phenomenon: if you spin a wheel faster than
// the contact patch can grip, you LOSE traction. So mashing the throttle
// in mud isn't just slow because of low surface friction - it's slow
// because the tire is breaking loose and not transmitting torque.
//
// Slip ratio = (wheelSurfaceSpeed - groundSpeed) / max(|wheelSurfaceSpeed|, |groundSpeed|, eps)
// where wheelSurfaceSpeed = wheelAngVel * wheelRadius.

// NOTE: The longitudinal slip curve in this module is not used by the live
// solid-axle model (which uses an impulse-clamped friction circle). It is kept
// as a tested building block for a future tire model and still reads TIRE
// directly. The lateral slip-angle functions below are live and read TUNING.
import { TIRE, TIRE_LATERAL } from '../constants.js';
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
  const peak = TIRE.slipPeak;
  const floor = TIRE.slipFloor;
  if (a <= peak) {
    const t = a / peak;
    return floor + (1 - floor) * t;
  }
  const over = a - peak;
  const decay = Math.exp(-over * TIRE.slipFalloff);
  return floor + (1 - floor) * decay;
}

// ---- Lateral slip-angle model ----
// Slip angle = angle between the wheel's heading and the velocity of the
// contact patch. Sign follows latV (positive alpha = sliding toward
// chassis-right). The forward-speed denominator is floored so low-speed
// manoeuvres don't blow the angle up to ±π/2 and kill slow-speed steering.
// Pure function; tested in tire.test.ts.
export function slipAngle(latV: number, longV: number): number {
  const ref = Math.max(Math.abs(longV), TIRE_LATERAL.slipAngleVelFloor);
  return Math.atan2(latV, ref);
}

/** Lateral grip multiplier as a function of slip angle. Returns 1.0 in
 *  the linear cornering region (|alpha| <= slipAnglePeak) so turn-in
 *  keeps the full cornering stiffness; decays exponentially toward
 *  slipAngleFloor past the peak so a sliding tyre loses grip (the tail
 *  comes out) but never to zero (you can still counter-steer to
 *  recover). Symmetric in sign. */
export function lateralGripFromSlipAngle(alpha: number): number {
  const a = Math.abs(alpha);
  const peak = TUNING.tireSlipAnglePeak;
  const floor = TUNING.tireSlipAngleFloor;
  if (a <= peak) return 1.0;
  const over = a - peak;
  const decay = Math.exp(-over * TUNING.tireSlipAngleFalloff);
  return floor + (1 - floor) * decay;
}
