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
  /** Ticks remaining before the next automatic RPM-triggered shift is allowed. */
  shiftCooldown: number;
  /** Set to true while the client prediction is replaying queued inputs after
   *  a reconcile. The auto-shift state machine reads RPM + speed and can
   *  flip the gear within a tick of applyEngineSnap restoring the server's
   *  gear, undoing the snap and producing client/server gear mismatch -
   *  the dominant cause of large replay divergence. While this flag is
   *  set, gear is held to whatever applyEngineSnap put it at; direction
   *  switches (forward/reverse) and idle-into-neutral still happen because
   *  those are driven by the player's actual input intent. */
  replaying: boolean;
}

export function createEngineState(): EngineState {
  return { rpm: ENGINE.idleRpm, gearIndex: ENGINE.neutralGear, shiftCooldown: 0, replaying: false };
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
 *  wheelAngVel:   signed average angular velocity of the driven wheels in
 *                 rad/s. Used for RPM display / torque curve.
 *  vehicleAngVel: |chassis forward speed| / wheelRadius. Used exclusively
 *                 for automatic shift decisions. Decoupling this from
 *                 wheelAngVel prevents spinning wheels (slip on mud / steep
 *                 hills) from triggering premature upshifts and the 1-2-1-2
 *                 gear-hunt cycle that follows.
 *  throttle:      signed input in [-1, 1].
 */
export function stepEngine(
  state: EngineState,
  wheelAngVel: number,
  vehicleAngVel: number,
  throttle: number,
  dt: number,
): { wheelForce: number; rpm: number; gear: number } {
  // Derive engine RPM from driveshaft. In neutral, RPM follows throttle
  // toward an idle/blip behaviour; when in gear, it's locked to the
  // wheels through the gear and final drive.
  const gIdx = state.gearIndex;
  const ratio = ENGINE.gears[gIdx] ?? 0;
  let targetRpm: number;
  if (gIdx === ENGINE.neutralGear || ratio === 0) {
    // Free-revving in neutral.
    targetRpm = ENGINE.idleRpm + Math.max(0, throttle) * (ENGINE.redlineRpm - ENGINE.idleRpm);
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
    targetRpm = lockedRpm * blend + throttleTarget * (1 - blend);
  }
  // Hard cap at the rev-limiter cliff. Past this rpm the torque curve
  // (torqueAtRpm) returns ~0 anyway, so the engine cannot physically
  // rev higher. Without this cap, freely-spinning wheels (slip on mud,
  // in-air after a jump) inflate lockedRpm without bound and the rpm
  // field drifts to absurd values — which the audio synth then chases,
  // producing the "rpm climbs forever" glitch.
  const RPM_HARD_LIMIT = ENGINE.redlineRpm + ENGINE.rpmLimiterFalloff;
  if (targetRpm > RPM_HARD_LIMIT) targetRpm = RPM_HARD_LIMIT;
  if (targetRpm < ENGINE.idleRpm) targetRpm = ENGINE.idleRpm;
  // Smooth toward target. Per-tick wheel-spin variance (impulse-clamped
  // integrator + slip dynamics) and gear-change transitions otherwise
  // translate directly into rpm jumps that read as audio glitching/
  // bouncing. ~125 ms time constant tracks throttle changes within a
  // few frames while filtering single-tick spikes.
  const rpm = state.rpm + (targetRpm - state.rpm) * Math.min(1, dt * 8);

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
  } else if (gIdx >= ENGINE.firstGear && !state.replaying) {
    // Forward auto-shifting based on chassis speed (vehicleAngVel), NOT
    // wheel spin. Wheel angVel inflates when tires slip (stuck on hill,
    // mud bog, etc.) and using it for shift decisions causes a feedback
    // loop: spinning wheels trigger an upshift → less torque in the
    // higher gear → wheels slow → downshift → wheels spin up → upshift
    // again (the 1-2-1-2 hunting the player reported). Chassis speed is
    // unaffected by slip and gives a stable, speed-accurate shift point.
    //
    // Skipped during reconcile replay so the gear that the server told
    // us to hold isn't immediately overwritten by a stale shift threshold.
    const vehicleRpmAbs = (vehicleAngVel * 60) / (2 * Math.PI);
    const vehicleLockedRpm = vehicleRpmAbs * Math.abs(ratio) * ENGINE.finalDrive;
    if (state.shiftCooldown > 0) {
      state.shiftCooldown--;
    } else if (vehicleLockedRpm > ENGINE.shiftUpRpm && gIdx < ENGINE.gears.length - 1) {
      nextGear = gIdx + 1;
      state.shiftCooldown = ENGINE.shiftHoldTicks;
    } else if (vehicleLockedRpm < ENGINE.shiftDownRpm && gIdx > ENGINE.firstGear) {
      nextGear = gIdx - 1;
      state.shiftCooldown = ENGINE.shiftHoldTicks;
    }
  } else if (!state.replaying && Math.abs(throttle) < 0.05 && Math.abs(wheelAngVel) < 0.5) {
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
