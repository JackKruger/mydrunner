// Engine + automatic gearbox model. Output is the torque available at the
// drive wheels right now, given:
//   - the current driveshaft angular velocity (averaged from wheel rpms)
//   - throttle in [-1, 1] (negative selects reverse)
//   - the current gear (managed automatically)
//
// Output remains torque throughout this module, in Nm:
//   totalDrivelineTorque = engineTorque * gearRatio * finalDrive.
// The caller splits it between driven wheels; the tyre contact path alone
// converts each wheel torque to force using the effective radius.
//
// We don't try to model the clutch - throttle goes to zero in neutral, and
// gear changes are instantaneous. Good enough for a game; bad for a
// simulator.

import { ENGINE, WATER } from '../constants.js';
import { TUNING } from '../tuning.js';
import type { ManualGear } from '../types.js';

export interface EngineState {
  rpm: number;
  /** Index into ENGINE.gears. */
  gearIndex: number;
  /** Ticks remaining before the next automatic RPM-triggered shift is allowed. */
  shiftCooldown: number;
  /** Flooded: the air intake went under. No torque and RPM decays to
   *  zero until the player cranks it (and only if the intake is clear). */
  drowned: boolean;
  /** Ticks the starter has been held with a clear intake. */
  crankTicks: number;
}

export function createEngineState(): EngineState {
  return {
    rpm: ENGINE.idleRpm,
    gearIndex: ENGINE.neutralGear,
    shiftCooldown: 0,
    drowned: false,
    crankTicks: 0,
  };
}

/** Advance the flood/restart state machine.
 *
 *  Separate from stepEngine because it is driven by geometry (is the
 *  intake under water?) and player intent (is the starter held?), not by
 *  driveline state. stepEngine only has to honour the resulting flag.
 *
 *  Returns true while the starter is cranking, so the HUD and audio can
 *  say so. */
export function stepEngineFlooding(
  state: EngineState,
  intakeSubmerged: boolean,
  drownedNow: boolean,
  starterHeld: boolean,
): boolean {
  if (drownedNow) state.drowned = true;
  if (!state.drowned) {
    state.crankTicks = 0;
    return false;
  }
  // Cranking only counts with the intake clear. Holding the starter down
  // while still submerged should do nothing at all - that is the whole
  // point of the failure state, and letting it tick would mean a player
  // who mashed the key came back to life the instant they surfaced.
  if (!starterHeld || intakeSubmerged) {
    state.crankTicks = 0;
    return false;
  }
  state.crankTicks += 1;
  if (state.crankTicks >= WATER.crankTicks) {
    state.drowned = false;
    state.crankTicks = 0;
    state.rpm = ENGINE.idleRpm;
    return false;
  }
  return true;
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
  manualGear: ManualGear | null = null,
  finalDrive: number = ENGINE.finalDrive,
): { totalDrivelineTorque: number; rpm: number; gear: number } {
  // A flooded engine makes no torque and winds down to a stop. This has
  // to short-circuit before the RPM block below, which floors targetRpm
  // at idleRpm - the assumption everywhere else that the engine is
  // always running is exactly what a drowning has to break. Zero RPM
  // also fades the engine audio and reads as 0 on the tacho with no wire
  // change, because rpm is already a transmitted field.
  if (state.drowned) {
    state.rpm = Math.max(0, state.rpm - ENGINE.idleRpm * dt * 2);
    state.gearIndex = ENGINE.neutralGear;
    state.shiftCooldown = 0;
    return { totalDrivelineTorque: 0, rpm: state.rpm, gear: 0 };
  }

  // Derive engine RPM from driveshaft. In neutral, RPM follows throttle
  // toward an idle/blip behaviour; when in gear, it's locked to the
  // wheels through the gear and final drive.
  // A manual selection owns the gearbox completely. Applying it before the
  // RPM calculation makes the tachometer react on the same tick as the lever.
  if (manualGear !== null) state.gearIndex = gearIndexFor(manualGear);
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
    const lockedRpm = wheelRpm * Math.abs(ratio) * finalDrive;
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
  if (manualGear !== null) {
    nextGear = gearIndexFor(manualGear);
    state.shiftCooldown = 0;
  } else if (wantsForward && gIdx <= ENGINE.neutralGear) {
    nextGear = ENGINE.firstGear;
  } else if (wantsReverse && gIdx >= ENGINE.firstGear) {
    nextGear = ENGINE.reverseGear;
  } else if (wantsReverse && gIdx === ENGINE.neutralGear) {
    nextGear = ENGINE.reverseGear;
  } else if (gIdx >= ENGINE.firstGear) {
    // Forward auto-shifting based on chassis speed (vehicleAngVel), NOT
    // wheel spin. Wheel angVel inflates when tires slip (stuck on hill,
    // mud bog, etc.) and using it for shift decisions causes a feedback
    // loop: spinning wheels trigger an upshift → less torque in the
    // higher gear → wheels slow → downshift → wheels spin up → upshift
    // again (the 1-2-1-2 hunting the player reported). Chassis speed is
    // unaffected by slip and gives a stable, speed-accurate shift point.
    const vehicleRpmAbs = (vehicleAngVel * 60) / (2 * Math.PI);
    const vehicleLockedRpm = vehicleRpmAbs * Math.abs(ratio) * finalDrive;
    if (state.shiftCooldown > 0) {
      state.shiftCooldown--;
    } else if (vehicleLockedRpm > ENGINE.shiftUpRpm && gIdx < ENGINE.gears.length - 1) {
      nextGear = gIdx + 1;
      state.shiftCooldown = ENGINE.shiftHoldTicks;
    } else if (vehicleLockedRpm < ENGINE.shiftDownRpm && gIdx > ENGINE.firstGear) {
      nextGear = gIdx - 1;
      state.shiftCooldown = ENGINE.shiftHoldTicks;
    }
  } else if (Math.abs(throttle) < 0.05 && Math.abs(wheelAngVel) < 0.5) {
    nextGear = ENGINE.neutralGear;
  }
  state.gearIndex = nextGear;
  state.rpm = rpm;

  const activeRatio = ENGINE.gears[nextGear] ?? 0;
  if (activeRatio === 0) {
    return { totalDrivelineTorque: 0, rpm, gear: signedGear(nextGear) };
  }

  // Engine torque this tick.
  const engineT = torqueAtRpm(rpm) * Math.abs(throttle) * TUNING.engineTorqueMult;
  // Negative throttle in reverse gear translates to positive torque
  // through the negative ratio - both signs cancel.
  const torqueAtWheels = engineT * activeRatio * finalDrive;

  // Engine braking off-throttle. Two components:
  //   - rpm-based: compression braking through the locked drivetrain.
  //     Scales with engine RPM (faster engine = more pump loss).
  //   - speed-based: scales with chassis speed regardless of gear. In
  //     high gears (low ratio) chassis speed maps to a low engine RPM
  //     even at a fast cruise, so the rpm term alone can't hold a
  //     downhill coast in overdrive — the truck just runs away. The
  //     speed term closes that gap so off-throttle coasting bleeds
  //     momentum in every gear, not just low ones.
  // Both only apply off-throttle and in-gear; neutral coasts freely.
  //
  // The sign must follow the DIRECTION OF TRAVEL, not the gear. Both
  // components above are magnitudes, so keying the sign off the gear
  // ratio meant that rolling backward in a forward gear (losing momentum
  // partway up a switchback, off the throttle) produced a negative wheel
  // torque - engine "braking" that accelerated the rollback instead of
  // holding it. Mirrored in reverse gear when rolling forward. Below
  // ~0 wheel speed both terms are already ~0, so falling back to the gear
  // sign there keeps standstill behaviour identical.
  let brakeT = 0;
  if (Math.abs(throttle) < 0.05 && Math.abs(activeRatio) > 0) {
    const rpmBrake = Math.max(0, rpm - ENGINE.idleRpm) * ENGINE.engineBrakeCoef;
    const speedBrake = Math.abs(vehicleAngVel) * ENGINE.engineBrakeSpeedCoef;
    const travelDir =
      Math.abs(wheelAngVel) > 1e-3 ? Math.sign(wheelAngVel) : Math.sign(activeRatio);
    brakeT = (rpmBrake + speedBrake) * TUNING.engineBrakeMult * travelDir;
  }

  return {
    totalDrivelineTorque: torqueAtWheels - brakeT,
    rpm,
    gear: signedGear(nextGear),
  };
}

function signedGear(gIdx: number): number {
  if (gIdx === ENGINE.reverseGear) return -1;
  if (gIdx === ENGINE.neutralGear) return 0;
  return gIdx - ENGINE.neutralGear; // 1..5
}

function gearIndexFor(gear: ManualGear): number {
  if (gear === -1) return ENGINE.reverseGear;
  if (gear === 0) return ENGINE.neutralGear;
  return ENGINE.neutralGear + gear;
}
