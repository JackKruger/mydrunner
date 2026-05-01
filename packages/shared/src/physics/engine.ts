// Engine + automatic gearbox model. Output is the torque available at the
// drive wheels right now, given:
//   - the current driveshaft angular velocity (averaged from wheel rpms)
//   - throttle in [-1, 1] (negative selects reverse)
//   - the current gear (managed automatically)
//
// The actual force per wheel is computed by the caller via:
//   wheelForce = (torqueAtWheels * driveSplitShare) where torqueAtWheels
//   is engineTorque * gearRatio * finalDrive (already divided by wheel
//   radius implicitly because Rapier expects a force, not a torque, and
//   we just label our output as a force).
//
// We don't try to model the clutch - throttle goes to zero in neutral, and
// gear changes are instantaneous. Good enough for a game; bad for a
// simulator.

import { ENGINE } from '../constants.js';

export interface EngineState {
  rpm: number;
  /** Index into ENGINE.gears. */
  gearIndex: number;
}

export function createEngineState(): EngineState {
  return { rpm: ENGINE.idleRpm, gearIndex: ENGINE.neutralGear };
}

/** Approximate torque curve. Peak around peakTorqueRpm, falls off either
 *  side; near zero below idle, plus a soft cut above redline. */
export function torqueAtRpm(rpm: number): number {
  if (rpm < ENGINE.idleRpm * 0.5) return 0;
  const peak = ENGINE.peakTorqueRpm;
  const dx = (rpm - peak) / 2200;
  // Bell-shaped curve; ~0.55 at idle, 1.0 at peak, ~0.65 at redline.
  let t = Math.exp(-dx * dx);
  // Soft rev limiter above redline.
  if (rpm > ENGINE.redlineRpm) {
    const over = rpm - ENGINE.redlineRpm;
    t *= Math.max(0, 1 - over / ENGINE.rpmLimiterFalloff);
  }
  return ENGINE.peakTorqueNm * t;
}

/** Current gear ratio for the tracked gear. Returns 0 in neutral. */
export function gearRatio(state: EngineState): number {
  return ENGINE.gears[state.gearIndex] ?? 0;
}

/** Step the engine simulation one fixed frame.
 *
 *  wheelAngVel: signed average angular velocity of the driven wheels in
 *               rad/s. Sign indicates forward (+) vs reverse (-) motion.
 *  throttle:    signed input in [-1, 1].
 *
 *  Returns the torque to apply at the drive wheels (positive = forward).
 */
export function stepEngine(
  state: EngineState,
  wheelAngVel: number,
  throttle: number,
  dt: number,
): { wheelForce: number; rpm: number; gear: number } {
  // Derive engine RPM from driveshaft. In neutral, RPM follows throttle
  // toward an idle/blip behaviour; when in gear, it's locked to the
  // wheels through the gear and final drive.
  let rpm: number;
  const gIdx = state.gearIndex;
  const ratio = ENGINE.gears[gIdx] ?? 0;
  if (gIdx === ENGINE.neutralGear || ratio === 0) {
    // Free-revving in neutral: spool toward (idle + throttle * (redline - idle)).
    const target = ENGINE.idleRpm + Math.max(0, throttle) * (ENGINE.redlineRpm - ENGINE.idleRpm);
    rpm = state.rpm + (target - state.rpm) * Math.min(1, dt * 4);
  } else {
    const wheelRpm = (Math.abs(wheelAngVel) * 60) / (2 * Math.PI);
    rpm = wheelRpm * Math.abs(ratio) * ENGINE.finalDrive;
    if (rpm < ENGINE.idleRpm) rpm = ENGINE.idleRpm;
  }

  // Auto-shift logic. Reverse vs forward is selected by throttle sign.
  // Only allow a gear change when |wheelAngVel| is small (no harsh shifts at speed).
  let nextGear = gIdx;
  const goingForward = wheelAngVel > 1.5;
  const goingBackward = wheelAngVel < -1.5;
  const wantsReverse = throttle < -0.05 && !goingForward;
  const wantsForward = throttle > 0.05 && !goingBackward;
  if (wantsReverse && gIdx >= ENGINE.firstGear) {
    nextGear = ENGINE.reverseGear;
  } else if (wantsForward && gIdx === ENGINE.reverseGear) {
    nextGear = ENGINE.firstGear;
  } else if (gIdx >= ENGINE.firstGear) {
    if (rpm > ENGINE.shiftUpRpm && gIdx < ENGINE.gears.length - 1) {
      nextGear = gIdx + 1;
    } else if (rpm < ENGINE.shiftDownRpm && gIdx > ENGINE.firstGear) {
      nextGear = gIdx - 1;
    }
  } else if (Math.abs(throttle) < 0.05 && Math.abs(wheelAngVel) < 0.5) {
    // Idle into neutral when stopped and not pressing.
    nextGear = ENGINE.neutralGear;
  } else if (gIdx === ENGINE.neutralGear) {
    if (wantsForward) nextGear = ENGINE.firstGear;
    if (wantsReverse) nextGear = ENGINE.reverseGear;
  }
  state.gearIndex = nextGear;
  state.rpm = rpm;

  const activeRatio = ENGINE.gears[nextGear] ?? 0;
  if (activeRatio === 0) {
    return { wheelForce: 0, rpm, gear: signedGear(nextGear) };
  }

  // Engine torque this tick.
  const engineT = torqueAtRpm(rpm) * Math.abs(throttle);
  // Negative throttle in reverse gear translates to positive torque
  // through the negative ratio - both signs cancel.
  const torqueAtWheels = engineT * activeRatio * ENGINE.finalDrive;

  // Engine braking off-throttle.
  let brakeT = 0;
  if (Math.abs(throttle) < 0.05 && rpm > ENGINE.idleRpm + 100) {
    brakeT = (rpm - ENGINE.idleRpm) * ENGINE.engineBrakeCoef * Math.sign(activeRatio);
  }

  return {
    wheelForce: torqueAtWheels - brakeT,
    rpm,
    gear: signedGear(nextGear),
  };
}

function signedGear(gIdx: number): number {
  if (gIdx === ENGINE.reverseGear) return -1;
  if (gIdx === ENGINE.neutralGear) return 0;
  return gIdx - ENGINE.neutralGear; // 1..5
}
