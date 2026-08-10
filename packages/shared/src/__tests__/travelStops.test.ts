import { describe, expect, it } from 'vitest';
import { progressiveTravelStopForce } from '../physics/axle.js';

describe('progressive suspension travel stops', () => {
  it('begins the bump stop at 80% travel and rises quadratically', () => {
    expect(progressiveTravelStopForce(0.079, 0.1, 0.2, 50_000).bumpForce).toBe(0);
    const early = progressiveTravelStopForce(0.085, 0.1, 0.2, 50_000).bumpForce;
    const late = progressiveTravelStopForce(0.095, 0.1, 0.2, 50_000).bumpForce;
    expect(late).toBeGreaterThan(early * 3);
  });

  it('begins rebound support in the final 15% of droop', () => {
    expect(progressiveTravelStopForce(-0.16, 0.1, 0.2, 50_000).reboundForce).toBe(0);
    expect(progressiveTravelStopForce(-0.19, 0.1, 0.2, 50_000).reboundForce).toBeLessThan(0);
  });
});
