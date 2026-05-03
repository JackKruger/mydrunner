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
    // Free-revving in neutral.
    const target = ENGINE.idleRpm + Math.max(0, throttle) * (ENGINE.redlineRpm - ENGINE.idleRpm);
    rpm = state.rpm + (target - state.rpm) * Math.min(1, dt * 4);
  } else {
    // Wheel-derived RPM (rigid coupling). At low wheel speed a real auto
    // is decoupled from the wheels by a torque converter / slipping
    // clutch - the engine "blips" up toward the throttle target while
    // the wheels lag. Without modeling this, launches lug at idle and
    // the car crawls forever before the wheels catch up.
    const wheelRpm = (Math.abs(wheelAngVel) * 60) / (2 * Math.PI);
    const lockedRpm = wheelRpm * Math.abs(ratio) * ENGINE.finalDrive;
    // Blend: at zero wheel speed use throttle target; full lock around
    // 8 rad/s wheel speed (~3 m/s).
    const blend = Math.min(1, Math.abs(wheelAngVel) / 8);
    const throttleTarget = ENGINE.idleRpm + Math.abs(throttle) * (ENGINE.peakTorqueRpm - ENGINE.idleRpm);
    rpm = lockedRpm * blend + throttleTarget * (1 - blend);
    if (rpm < ENGINE.idleRpm) rpm = ENGINE.idleRpm;
  }

  // Direction-of-travel intent comes from throttle sign. Importantly, we
  // shift into the requested direction even if the car is currently
  // rolling the other way - the wheels then "fight" the existing
  // momentum and decelerate the car. Without this, pressing W while
  // rolling backward kept us in reverse gear and ACCELERATED us backward,
  // which is exactly the opposite of what the player wants.
  let nextGear = gIdx;
  const wantsReverse = throttle < -0.05;
  const wantsForward = throttle > 0.05;
  if (wantsForward && gIdx <= ENGINE.neutralGear) {
    nextGear = ENGINE.firstGear;
  } else if (wantsReverse && gIdx >= ENGINE.firstGear) {
    nextGear = ENGINE.reverseGear;
  } else if (wantsReverse && gIdx === ENGINE.neutralGear) {
    nextGear = ENGINE.reverseGear;
  } else if (gIdx >= ENGINE.firstGear) {
    // Forward auto-shifting based on RPM. Only when actually rolling
    // forward (don't upshift while wheels are spinning at standstill).
    // Downshift uses the gear-locked RPM directly, NOT the blended
    // `rpm` above. Why: the converter-style blend pads RPM up toward
    // the throttle target at low wheel speeds (so launches don't lug
    // at idle), which means a truck slowing to a crawl on a hill
    // sits at ~2500 RPM in 5th and never trips the < 1700 downshift
    // threshold. Result: stuck in too-tall a gear, ~3 kN at the
    // wheels when 30° terrain wants ~7 kN, slows to a stop. Locked
    // RPM correctly reflects "if the engine were rigid-coupled to
    // the wheels, what would it be doing" - which is the right
    // signal for "do I need a lower gear?".
    const wheelRpmAbs = (Math.abs(wheelAngVel) * 60) / (2 * Math.PI);
    const lockedAtGear = wheelRpmAbs * Math.abs(ratio) * ENGINE.finalDrive;
    if (rpm > ENGINE.shiftUpRpm && gIdx < ENGINE.gears.length - 1 && wheelAngVel > 1.5) {
      nextGear = gIdx + 1;
    } else if (lockedAtGear < ENGINE.shiftDownRpm && gIdx > ENGINE.firstGear) {
      nextGear = gIdx - 1;
    }
  } else if (Math.abs(throttle) < 0.05 && Math.abs(wheelAngVel) < 0.5) {
    nextGear = ENGINE.neutralGear;
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

  // Engine braking off-throttle. The coef has been increased from 0.04
  // to 0.12 so the vehicle doesn't coast faster than it should on
  // downhills. Braking torque rises linearly with RPM above idle.
  let brakeT = 0;
  if (Math.abs(throttle) < 0.05 && rpm > ENGINE.idleRpm + 50) {
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
