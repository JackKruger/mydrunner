// Engine + gearbox unit tests. These run on the pure model without
// touching Rapier - so they're fast and deterministic.

import { describe, it, expect } from 'vitest';
import { createEngineState, stepEngine, torqueAtRpm } from '../physics/engine.js';
import { ENGINE } from '../constants.js';

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
    expect(out.wheelForce).toBeLessThan(0);
  });

  it('produces positive force at idle in 1st gear with throttle', () => {
    const s = createEngineState();
    s.gearIndex = ENGINE.firstGear;
    const out = stepEngine(s, 0.5, 0.5, 1.0, dt);
    expect(out.wheelForce).toBeGreaterThan(0);
  });
});
