import { describe, it, expect } from 'vitest';
import { createFixedStep } from '../physics/fixedStep.js';

describe('createFixedStep', () => {
  it('runs zero steps when below dt', () => {
    let count = 0;
    const r = createFixedStep(1 / 60, () => count++);
    r.advance(0.005);
    expect(count).toBe(0);
  });

  it('runs exactly one step at dt', () => {
    let count = 0;
    const r = createFixedStep(1 / 60, () => count++);
    r.advance(1 / 60);
    expect(count).toBe(1);
  });

  it('runs multiple steps and reports tick', () => {
    let count = 0;
    const r = createFixedStep(1 / 60, () => count++);
    r.advance(5 / 60);
    expect(count).toBe(5);
    expect(r.tick).toBe(5);
  });

  it('returns interpolation alpha in [0, 1)', () => {
    const r = createFixedStep(1 / 60, () => {});
    const alpha = r.advance(1.5 / 60);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(1);
    expect(alpha).toBeCloseTo(0.5, 5);
  });

  it('caps catch-up so we do not spiral', () => {
    let count = 0;
    const r = createFixedStep(1 / 60, () => count++, { maxStepsPerFrame: 3 });
    r.advance(10);
    expect(count).toBe(3);
  });

  it('clamps frame dt above 0.25s', () => {
    let count = 0;
    const r = createFixedStep(1 / 60, () => count++, { maxStepsPerFrame: 100 });
    r.advance(60); // would be 3600 steps unclamped
    expect(count).toBeLessThanOrEqual(15); // ~0.25s / (1/60)
  });
});
