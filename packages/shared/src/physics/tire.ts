// Slip ratio = (wheelSurfaceSpeed - groundSpeed) / max(|wheelSurfaceSpeed|, |groundSpeed|, eps)
// where wheelSurfaceSpeed = wheelAngVel * wheelRadius.
import { TIRE_LATERAL } from '../constants.js';
import { TUNING } from '../tuning.js';

// Velocity floor for the slip-ratio denominator. Below this, slip is
// computed against a fixed reference rather than the actual tiny velocity.
// The vehicle blends to a bounded static constraint in this range.
const SLIP_VEL_FLOOR = 0.5;

export function slipRatio(wheelAngVel: number, wheelRadius: number, groundSpeed: number): number {
  const wheelLin = wheelAngVel * wheelRadius;
  const denom = Math.max(Math.abs(wheelLin), Math.abs(groundSpeed), SLIP_VEL_FLOOR);
  return (wheelLin - groundSpeed) / denom;
}

/** Brush-style longitudinal force shape. Peak coefficients remain surface /
 * fitted-tyre data; this only describes how much of that peak is available at
 * the current slip. A locked wheel is on the sliding tail, not at peak grip. */
export function longitudinalGripFromSlip(
  slip: number,
  peakSlip: number,
  slidingToPeak: number,
): number {
  const a = Math.abs(slip);
  const peak = Math.max(1e-4, peakSlip);
  const sliding = Math.max(0, Math.min(1, slidingToPeak));
  if (a <= peak) return a / peak;
  return sliding + (1 - sliding) * Math.exp(-3 * (a - peak) / peak);
}

/** Modest tyre load sensitivity. Fref is normally the static quarter load. */
export function loadSensitivityMultiplier(
  normalLoad: number,
  referenceLoad: number,
  exponent: number,
): number {
  if (normalLoad <= 0) return 0;
  if (exponent <= 0) return 1;
  const ratio = normalLoad / Math.max(1, referenceLoad);
  return Math.max(0.82, Math.min(1.12, ratio ** -exponent));
}

/** Peak force capacity from contact load alone. Chassis pitch is
 * intentionally absent: grade can alter Fz, but orientation is not grip. */
export function tyreFrictionCapacity(
  normalLoad: number,
  peakCoefficient: number,
  referenceLoad: number,
  loadSensitivityExponent: number,
): number {
  if (normalLoad <= 0 || peakCoefficient <= 0) return 0;
  return normalLoad * peakCoefficient * loadSensitivityMultiplier(
    normalLoad,
    referenceLoad,
    loadSensitivityExponent,
  );
}

/** Relax force over travelled distance. A small static reference speed lets
 * launch and hill-hold constraints settle even when patch speed is zero. */
export function relaxLongitudinalForce(
  previousForce: number,
  targetForce: number,
  patchSpeed: number,
  relaxationLength: number,
  dt: number,
): number {
  if (dt <= 0) return previousForce;
  const distance = Math.max(Math.abs(patchSpeed), 0.5) * dt;
  const alpha = 1 - Math.exp(-distance / Math.max(0.01, relaxationLength));
  return previousForce + (targetForce - previousForce) * alpha;
}

export interface CombinedForce {
  longitudinal: number;
  lateral: number;
  utilization: number;
}

/** Resolve longitudinal and lateral candidates through a friction ellipse. */
/** @hotloop */
export function combineFrictionEllipse(
  longitudinal: number,
  lateral: number,
  longitudinalLimit: number,
  lateralLimit: number,
  out: CombinedForce = { longitudinal: 0, lateral: 0, utilization: 0 },
): CombinedForce {
  if (longitudinalLimit <= 0 || lateralLimit <= 0) {
    out.longitudinal = 0;
    out.lateral = 0;
    out.utilization = 0;
    return out;
  }
  const x = longitudinal / longitudinalLimit;
  const y = lateral / lateralLimit;
  const requested = Math.hypot(x, y);
  const scale = requested > 1 ? 1 / requested : 1;
  out.longitudinal = longitudinal * scale;
  out.lateral = lateral * scale;
  out.utilization = Math.min(1, requested);
  return out;
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
export function lateralGripFromSlipAngle(
  alpha: number,
  peakAngle: number = TUNING.tireSlipAnglePeak,
): number {
  const a = Math.abs(alpha);
  const peak = Math.max(1e-4, peakAngle);
  const floor = TUNING.tireSlipAngleFloor;
  if (a <= peak) return 1.0;
  const over = a - peak;
  const decay = Math.exp(-over * TUNING.tireSlipAngleFalloff);
  return floor + (1 - floor) * decay;
}
