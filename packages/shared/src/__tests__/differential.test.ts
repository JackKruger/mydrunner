import { describe, expect, it } from 'vitest';
import {
  differentialCarrierSpeed,
  drivenCarrierSpeed,
  solveCenterTransferImpulse,
  solveDifferentialAngularImpulse,
} from '../physics/differential.js';

describe('physical axle differential', () => {
  it('uses the mean side-gear speed as carrier speed', () => {
    expect(differentialCarrierSpeed(10, 30)).toBe(20);
  });

  it('ignores undriven front wheel speed in 2H and fixed RWD', () => {
    expect(drivenCarrierSpeed('2h', 1_000, 20)).toBe(20);
    expect(drivenCarrierSpeed('4h', 1_000, 20)).toBe(510);
  });

  it('leaves open side gears free', () => {
    expect(solveDifferentialAngularImpulse(0, 20, 2, 1 / 60, 'open'))
      .toMatchObject({ leftAngularVelocity: 0, rightAngularVelocity: 20, reactionTorque: 0 });
  });

  it('locks side speeds while conserving angular momentum', () => {
    const result = solveDifferentialAngularImpulse(0, 20, 2, 1 / 60, 'locked');
    expect(result.leftAngularVelocity).toBeCloseTo(10);
    expect(result.rightAngularVelocity).toBeCloseTo(10);
    expect(result.leftAngularVelocity + result.rightAngularVelocity).toBeCloseTo(20);
  });

  it('caps an LSD below the locked impulse using TBR and preload', () => {
    const lsd = solveDifferentialAngularImpulse(0, 20, 2, 1 / 60, 'lsd', 600, 2.5, 40);
    const locked = solveDifferentialAngularImpulse(0, 20, 2, 1 / 60, 'locked', 600);
    expect(Math.abs(lsd.angularImpulse)).toBeGreaterThan(0);
    expect(Math.abs(lsd.angularImpulse)).toBeLessThan(Math.abs(locked.angularImpulse));
  });

  it('locks centre carriers exactly while conserving carrier momentum', () => {
    const result = solveCenterTransferImpulse(0, 20, 2, 1 / 60);
    expect(result.leftAngularVelocity).toBe(10);
    expect(result.rightAngularVelocity).toBe(10);
    expect(result.leftAngularVelocity + result.rightAngularVelocity).toBeCloseTo(20);
  });

  it('uses the exact 2.5:1 LSD side-torque capacity', () => {
    const result = solveDifferentialAngularImpulse(0, 200, 2, 1, 'lsd', 600, 2.5, 0);
    // 0.5 * 600 * (1.5 / 3.5) = 128.571 N m. With a 300 N m
    // open-diff base torque this produces a 428.571:171.429 = 2.5 ratio.
    expect(result.reactionTorque).toBeCloseTo(128.5714285714, 8);
    expect((300 + result.reactionTorque) / (300 - result.reactionTorque)).toBeCloseTo(2.5, 8);
  });
});
