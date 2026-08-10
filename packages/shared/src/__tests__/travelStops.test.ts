import { describe, expect, it } from 'vitest';
import { AXLE, FIXED_DT } from '../constants.js';
import {
  applyTravelStopReactionToAxle,
  createAxleState,
  progressiveTravelStopForce,
} from '../physics/axle.js';

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

  it('conserves internal linear and angular impulse with the chassis half', () => {
    const axle = createAxleState({ ...AXLE.front });
    const leftChassisForce = -600;
    const rightChassisForce = -1_000;
    applyTravelStopReactionToAxle(axle, leftChassisForce, rightChassisForce, FIXED_DT);

    const chassisLinearImpulse = (leftChassisForce + rightChassisForce) * FIXED_DT;
    const axleLinearImpulse = axle.rideVelY * axle.geom.axleMass;
    expect(axleLinearImpulse + chassisLinearImpulse).toBeCloseTo(0, 12);

    const chassisAngularImpulse = (
      -axle.geom.trackHalf * leftChassisForce
      + axle.geom.trackHalf * rightChassisForce
    ) * FIXED_DT;
    const axleAngularImpulse = axle.rollVel * axle.geom.axleRollInertia;
    expect(axleAngularImpulse + chassisAngularImpulse).toBeCloseTo(0, 12);
  });
});
