// Engine + gearbox unit tests. These run on the pure model without
// touching Rapier - so they're fast and deterministic.

import { describe, it, expect } from 'vitest';
import { createEngineState, stepEngine, torqueAtRpm } from '../physics/engine.js';
import { ENGINE } from '../constants.js';
import { TUNING } from '../tuning.js';

const dt = 1 / 60;

describe('engine torque curve', () => {
  it('peaks near peakTorqueRpm', () => {
    const peak = torqueAtRpm(ENGINE.peakTorqueRpm);
    expect(peak).toBeGreaterThan(torqueAtRpm(ENGINE.idleRpm));
    expect(peak).toBeGreaterThan(torqueAtRpm(ENGINE.redlineRpm - 100));
  });

  it('drops sharply above redline (rev limiter)', () => {
    const ok = torqueAtRpm(ENGINE.redlineRpm);
    const limited = torqueAtRpm(ENGINE.redlineRpm + ENGINE.rpmLimiterFalloff);
    expect(limited).toBeLessThan(ok * 0.05);
  });
});

describe('live engine tuning', () => {
  it('scales drive torque and engine braking independently', () => {
    const savedTorque = TUNING.engineTorqueMult;
    const savedBrake = TUNING.engineBrakeMult;
    try {
      const drive = (mult: number): number => {
        TUNING.engineTorqueMult = mult;
        const state = createEngineState();
        state.gearIndex = ENGINE.firstGear;
        return stepEngine(state, 4, 4, 1, dt).totalDrivelineTorque;
      };
      expect(drive(1.5)).toBeCloseTo(drive(1) * 1.5, 5);

      TUNING.engineBrakeMult = 0;
      const coast = createEngineState();
      coast.gearIndex = ENGINE.firstGear + 1;
      expect(stepEngine(coast, 20, 20, 0, dt).totalDrivelineTorque).toBe(0);
    } finally {
      TUNING.engineTorqueMult = savedTorque;
      TUNING.engineBrakeMult = savedBrake;
    }
  });
});

describe('gearbox', () => {
  it('starts in neutral', () => {
    const s = createEngineState();
    expect(s.gearIndex).toBe(ENGINE.neutralGear);
  });

  it('engages first gear when throttle is applied from a stop', () => {
    const s = createEngineState();
    const out = stepEngine(s, 0, 0, 0.5, dt);
    expect(out.gear).toBe(1);
  });

  it('engages reverse when throttle is negative from a stop', () => {
    const s = createEngineState();
    const out = stepEngine(s, 0, 0, -0.5, dt);
    expect(out.gear).toBe(-1);
  });

  it('upshifts when vehicle speed exceeds shiftUpRpm equivalent', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.firstGear;
    // vehicleAngVel high enough that chassis-speed RPM in 1st exceeds shiftUpRpm.
    // vehicleAngVel * ratio * finalDrive * 60/(2π) = vehicleAngVel * 4.0 * 4.1 * 9.549
    // Need > 4600 → vehicleAngVel > 29.4 rad/s. Use 50 to be well clear.
    const angVel = 50;
    let last = -1;
    for (let i = 0; i < 5; i++) {
      const out = stepEngine(s, angVel, angVel, 1.0, dt);
      last = out.gear;
    }
    expect(last).toBeGreaterThan(1);
  });

  it('does not upshift on wheel spin alone (slip on stuck truck)', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.firstGear;
    // Wheels spinning fast (high wheelAngVel = slip) but truck not moving.
    for (let i = 0; i < 10; i++) {
      stepEngine(s, 50, 0, 1.0, dt); // vehicleAngVel = 0 (stopped)
    }
    expect(s.gearIndex).toBe(ENGINE.firstGear); // must stay in 1st
  });

  it('produces engine braking torque when throttle is released while moving', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.firstGear + 1; // 2nd
    // Decent forward angular velocity, no throttle -> engine braking.
    const out = stepEngine(s, 30, 30, 0, dt);
    expect(out.totalDrivelineTorque).toBeLessThan(0);
  });

  it('produces positive force at idle in 1st gear with throttle', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.firstGear;
    const out = stepEngine(s, 0.5, 0.5, 1.0, dt);
    expect(out.totalDrivelineTorque).toBeGreaterThan(0);
  });

  it('engine braking scales with chassis speed (downhill coast hold)', () => {
    // Regression guard for the chassis-speed engine-brake term. In high
    // gears the rpm term alone is weak (low ratio → low locked RPM even
    // at a fast cruise), so off-throttle downhill coasting ran away.
    // The speed-based term closes that gap: faster chassis = more brake
    // regardless of gear. Same gear + same wheel rpm, only vehicleAngVel
    // (chassis speed) differs → the faster case must brake harder.
    const slow = createEngineState();
    slow.gearIndex = ENGINE.firstGear + 1; // 2nd
    const fast = createEngineState();
    fast.gearIndex = ENGINE.firstGear + 1;
    const slowOut = stepEngine(slow, 5, 5, 0, dt);
    const fastOut = stepEngine(fast, 5, 50, 0, dt); // 10x chassis speed
    expect(fastOut.totalDrivelineTorque).toBeLessThan(slowOut.totalDrivelineTorque);
    expect(fastOut.totalDrivelineTorque).toBeLessThan(0); // actually braking, not just less drive
  });

  it('produces no engine braking in neutral (coasts freely)', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.neutralGear;
    const out = stepEngine(s, 30, 30, 0, dt);
    expect(out.totalDrivelineTorque).toBeCloseTo(0, 1);
  });

  it('holds a manually selected gear instead of automatic shifting', () => {
    const s = createEngineState();
    for (let i = 0; i < 10; i++) stepEngine(s, 50, 50, 1, dt, 2);
    expect(stepEngine(s, 2, 2, 1, dt, 2).gear).toBe(2);
  });

  it('supports manual neutral and reverse with the gas pedal', () => {
    const neutral = createEngineState();
    expect(stepEngine(neutral, 0, 0, 1, dt, 0)).toMatchObject({ gear: 0, totalDrivelineTorque: 0 });

    const reverse = createEngineState();
    const out = stepEngine(reverse, 0, 0, 1, dt, -1);
    expect(out.gear).toBe(-1);
    expect(out.totalDrivelineTorque).toBeLessThan(0);
  });
});

// Engine braking used to take its sign from the gear ratio while both of
// its magnitude terms were unsigned. Off-throttle in a forward gear while
// rolling BACKWARD - the classic "lost momentum on a switchback" case -
// that produced a negative wheel torque, so the thing meant to hold you
// on the hill drove you further down it.
describe('engine braking opposes travel, not gear', () => {
  it('pushes forward when rolling backward in a forward gear', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.firstGear;
    const out = stepEngine(s, -8, 8, 0, dt);
    expect(
      out.totalDrivelineTorque,
      `rolling backward in 1st off-throttle gave ${out.totalDrivelineTorque.toFixed(1)} N·m; ` +
        'engine braking must oppose the rollback, not add to it',
    ).toBeGreaterThan(0);
  });

  it('pushes backward when rolling forward in reverse gear', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.reverseGear;
    const out = stepEngine(s, 8, 8, 0, dt);
    expect(out.totalDrivelineTorque).toBeLessThan(0);
  });

  it('still brakes normally when travel matches the gear', () => {
    const fwd = createEngineState();
    fwd.gearIndex = ENGINE.firstGear;
    expect(stepEngine(fwd, 8, 8, 0, dt).totalDrivelineTorque).toBeLessThan(0);

    const rev = createEngineState();
    rev.gearIndex = ENGINE.reverseGear;
    expect(stepEngine(rev, -8, 8, 0, dt).totalDrivelineTorque).toBeGreaterThan(0);
  });

  it('applies no engine braking at a standstill in gear', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.firstGear;
    const out = stepEngine(s, 0, 0, 0, dt);
    expect(out.totalDrivelineTorque).toBeCloseTo(0, 1);
  });
});
