// Tire slip-curve unit tests.

import { describe, it, expect } from 'vitest';
import { gripFromSlip, slipRatio, slipAngle, lateralGripFromSlipAngle } from '../physics/tire.js';
import { TIRE, TIRE_LATERAL } from '../constants.js';
import { TUNING } from '../tuning.js';

describe('slipRatio', () => {
  it('is zero when wheel and ground move at the same speed', () => {
    // wheelAngVel * radius = groundSpeed.
    const r = 0.36;
    const v = 10; // ground speed
    const omega = v / r;
    expect(slipRatio(omega, r, v)).toBeCloseTo(0, 5);
  });

  it('is positive when wheel surface is faster than ground (powered slip)', () => {
    expect(slipRatio(50, 0.36, 5)).toBeGreaterThan(0);
  });

  it('is negative when wheel is slower than ground (locked-up brake slip)', () => {
    expect(slipRatio(2, 0.36, 20)).toBeLessThan(0);
  });
});

describe('gripFromSlip', () => {
  it('returns slipFloor at zero slip (avoids standstill deadlock)', () => {
    expect(gripFromSlip(0)).toBeCloseTo(TIRE.slipFloor, 5);
  });

  it('peaks at slipPeak with grip = 1.0', () => {
    const peak = gripFromSlip(TIRE.slipPeak);
    expect(peak).toBeCloseTo(1.0, 5);
    expect(gripFromSlip(TIRE.slipPeak * 0.5)).toBeLessThan(peak);
    expect(gripFromSlip(TIRE.slipPeak * 2.0)).toBeLessThan(peak);
  });

  it('rises monotonically up to peak', () => {
    const a = gripFromSlip(0.02);
    const b = gripFromSlip(0.05);
    const c = gripFromSlip(TIRE.slipPeak);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it('falls toward (but not below) slipFloor as slip grows large', () => {
    const wayPast = gripFromSlip(2.0);
    expect(wayPast).toBeGreaterThanOrEqual(TIRE.slipFloor);
    expect(wayPast).toBeLessThan(TIRE.slipFloor + 0.15);
  });

  it('is symmetric for positive and negative slip', () => {
    expect(gripFromSlip(0.3)).toBeCloseTo(gripFromSlip(-0.3), 5);
  });
});

describe('slipAngle', () => {
  it('is zero when there is no lateral velocity', () => {
    expect(slipAngle(0, 10)).toBeCloseTo(0, 5);
  });

  it('grows with lateral velocity at fixed forward speed', () => {
    const small = Math.abs(slipAngle(1, 10));
    const large = Math.abs(slipAngle(5, 10));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it('signs with lateral velocity', () => {
    expect(slipAngle(2, 10)).toBeGreaterThan(0);
    expect(slipAngle(-2, 10)).toBeLessThan(0);
  });

  it('is bounded when forward speed is near zero (floor prevents NaN/±π/2 blowup)', () => {
    // Sliding sideways with no forward motion should register as large
    // slip but finite, not atan2(x, 0) = π/2 exactly nor NaN.
    const a = Math.abs(slipAngle(5, 0));
    expect(Number.isFinite(a)).toBe(true);
    expect(a).toBeLessThan(Math.PI / 2);
    expect(a).toBeGreaterThan(0.5); // clearly sliding
  });

  it('low-speed straight-line driving reads as near-zero slip (floor protects steering)', () => {
    // Tiny lateral component at low forward speed must not blow up to a
    // full-slide angle or slow-speed steering would lose all grip.
    const a = Math.abs(slipAngle(0.05, 0.5));
    expect(a).toBeLessThan(TIRE_LATERAL.slipAnglePeak);
  });
});

describe('lateralGripFromSlipAngle', () => {
  it('is 1.0 at and below the peak (linear cornering region keeps full stiffness)', () => {
    expect(lateralGripFromSlipAngle(0)).toBeCloseTo(1.0, 5);
    expect(lateralGripFromSlipAngle(TIRE_LATERAL.slipAnglePeak * 0.5)).toBeCloseTo(1.0, 5);
    expect(lateralGripFromSlipAngle(TIRE_LATERAL.slipAnglePeak)).toBeCloseTo(1.0, 5);
  });

  it('falls off past the peak', () => {
    const past = lateralGripFromSlipAngle(TIRE_LATERAL.slipAnglePeak * 3);
    expect(past).toBeLessThan(1.0);
    expect(past).toBeGreaterThanOrEqual(TIRE_LATERAL.slipAngleFloor);
  });

  it('decays toward but not below the floor as slip grows large', () => {
    const wayPast = lateralGripFromSlipAngle(2.0);
    expect(wayPast).toBeGreaterThanOrEqual(TIRE_LATERAL.slipAngleFloor);
    expect(wayPast).toBeLessThan(TIRE_LATERAL.slipAngleFloor + 0.15);
  });

  it('is symmetric for positive and negative slip', () => {
    expect(lateralGripFromSlipAngle(0.3)).toBeCloseTo(lateralGripFromSlipAngle(-0.3), 5);
  });

  it('is monotonic non-increasing past the peak', () => {
    const a = lateralGripFromSlipAngle(TIRE_LATERAL.slipAnglePeak + 0.02);
    const b = lateralGripFromSlipAngle(TIRE_LATERAL.slipAnglePeak + 0.2);
    const c = lateralGripFromSlipAngle(TIRE_LATERAL.slipAnglePeak + 0.6);
    expect(a).toBeGreaterThanOrEqual(b);
    expect(b).toBeGreaterThanOrEqual(c);
  });

  it('reads the live peak, falloff, and floor tuning', () => {
    const saved = {
      peak: TUNING.tireSlipAnglePeak,
      falloff: TUNING.tireSlipAngleFalloff,
      floor: TUNING.tireSlipAngleFloor,
    };
    try {
      TUNING.tireSlipAnglePeak = 0.25;
      TUNING.tireSlipAngleFalloff = 12;
      TUNING.tireSlipAngleFloor = 0.7;
      expect(lateralGripFromSlipAngle(0.2)).toBe(1);
      const sliding = lateralGripFromSlipAngle(1.5);
      expect(sliding).toBeGreaterThanOrEqual(0.7);
      expect(sliding).toBeLessThan(0.71);
    } finally {
      TUNING.tireSlipAnglePeak = saved.peak;
      TUNING.tireSlipAngleFalloff = saved.falloff;
      TUNING.tireSlipAngleFloor = saved.floor;
    }
  });
});
