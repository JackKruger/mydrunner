// Pure-function unit tests for the wheel-spin integrator.
// Pin down the brake-induced wheel-sign-flip clamp behaviour: a strong
// brake must NOT push the wheel through zero into the opposite sign in
// a single tick, because that flips the friction-circle sign and turns
// braking into a high-frequency oscillation that mostly cancels itself.

import { describe, it, expect } from 'vitest';
import { createWheelKinematic, integrateWheelSpin } from '../physics/wheelDynamics.js';
import { WHEEL } from '../constants.js';

const dt = 1 / 60;

describe('integrateWheelSpin: brake-only', () => {
  it('reduces a forward-spinning wheel toward zero under brake', () => {
    const w = createWheelKinematic();
    w.angVel = 26; // ~12 m/s at wheelRadius 0.46
    integrateWheelSpin(w, 0, 1000, 0, dt);
    expect(w.angVel).toBeLessThan(26);
    expect(w.angVel).toBeGreaterThanOrEqual(0);
  });

  it('clamps to zero (does NOT flip sign) when brake alone is strong enough to reverse the wheel in one tick', () => {
    const w = createWheelKinematic();
    w.angVel = 5; // spinning forward
    // Pick a brake torque large enough that a naive integrator would
    // drive angVel negative in this single tick:
    //   |Δω| = brake/I * dt = 5000/1.6 * 1/60 ≈ 52 rad/s  >> 5 rad/s
    integrateWheelSpin(w, 0, 5000, 0, dt);
    // Real wheels lock at zero — they cannot rotate backward purely
    // from a brake on a forward-spinning wheel.
    expect(w.angVel).toBe(0);
  });

  it('symmetric case: clamps to zero from a reverse-spinning wheel under strong brake', () => {
    const w = createWheelKinematic();
    w.angVel = -5;
    integrateWheelSpin(w, 0, 5000, 0, dt);
    expect(w.angVel).toBe(0);
  });

  it('still allows ground torque to spin a locked wheel back up if it dominates the brake', () => {
    // A locked wheel can be re-energised by a strong ground reaction
    // (e.g. wheel skidding on grippy road). The clamp guards against
    // brake-induced sign flip, not ground-driven re-acceleration.
    const w = createWheelKinematic();
    w.angVel = 0; // start locked
    // Ground torque larger than brake torque -> wheel can spin again.
    integrateWheelSpin(w, 0, 100, 1000, dt);
    expect(w.angVel).toBeGreaterThan(0);
  });
});

describe('integrateWheelSpin: drive + brake interaction', () => {
  it('drive torque > brake torque keeps the wheel accelerating', () => {
    const w = createWheelKinematic();
    w.angVel = 10;
    integrateWheelSpin(w, 2000, 500, 0, dt);
    expect(w.angVel).toBeGreaterThan(10);
  });

  it('brake torque > drive torque slows a forward wheel', () => {
    const w = createWheelKinematic();
    w.angVel = 10;
    integrateWheelSpin(w, 500, 2000, 0, dt);
    expect(w.angVel).toBeLessThan(10);
  });
});

describe('integrateWheelSpin: rolling resistance', () => {
  it('bleeds spin off a free-coasting wheel toward zero', () => {
    const w = createWheelKinematic();
    w.angVel = 10;
    // No drive, no brake, no ground torque - rolling resistance only.
    for (let i = 0; i < 60 * 10; i++) integrateWheelSpin(w, 0, 0, 0, dt);
    expect(w.angVel).toBeLessThan(10);
    expect(w.angVel).toBeGreaterThan(0); // exponential decay, won't reach 0 quickly
  });

  it('stronger rolling resistance bleeds spin off faster (mud)', () => {
    const wRoad = createWheelKinematic();
    const wMud = createWheelKinematic();
    wRoad.angVel = wMud.angVel = 10;
    for (let i = 0; i < 60; i++) {
      integrateWheelSpin(wRoad, 0, 0, 0, dt, WHEEL.rollingResistance);
      integrateWheelSpin(wMud, 0, 0, 0, dt, WHEEL.rollingResistance * 12);
    }
    expect(wMud.angVel).toBeLessThan(wRoad.angVel);
  });
});
