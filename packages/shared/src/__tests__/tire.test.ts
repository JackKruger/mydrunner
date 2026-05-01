// Tire slip-curve unit tests.

import { describe, it, expect } from 'vitest';
import { gripFromSlip, slipRatio } from '../physics/tire.js';
import { TIRE } from '../constants.js';

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
