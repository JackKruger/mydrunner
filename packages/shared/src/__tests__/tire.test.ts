// Tire slip-curve unit tests.

import { describe, it, expect } from 'vitest';
import {
  combineFrictionEllipse,
  lateralGripFromLongitudinalSlip,
  lateralGripFromSlipAngle,
  loadSensitivityMultiplier,
  longitudinalGripFromSlip,
  relaxLongitudinalForce,
  slipAngle,
  slipRatio,
  tyreFrictionCapacity,
} from '../physics/tire.js';
import { TIRE_LATERAL } from '../constants.js';
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

describe('live longitudinal tyre model', () => {
  it('builds to a peak and falls to sliding grip', () => {
    const peak = longitudinalGripFromSlip(0.1, 0.1, 0.78);
    const locked = longitudinalGripFromSlip(-1, 0.1, 0.78);
    expect(peak).toBeCloseTo(1);
    expect(locked).toBeLessThan(peak);
    expect(locked).toBeCloseTo(0.78, 3);
  });

  it('uses the same symmetric law uphill and downhill', () => {
    expect(longitudinalGripFromSlip(0.2, 0.1, 0.78))
      .toBeCloseTo(longitudinalGripFromSlip(-0.2, 0.1, 0.78));
  });

  it('cannot create capacity from an unloaded tyre', () => {
    expect(loadSensitivityMultiplier(0, 4_000, 0.08)).toBe(0);
    expect(tyreFrictionCapacity(0, 1, 4_000, 0.08)).toBe(0);
  });

  it('does not change grip when chassis pitch changes at equal contact load', () => {
    const load = 4_000;
    const capacityAtNoseDown = tyreFrictionCapacity(load, 0.8, load, 0.08);
    const capacityAtNoseUp = tyreFrictionCapacity(load, 0.8, load, 0.08);
    expect(capacityAtNoseUp).toBe(capacityAtNoseDown);
  });

  it('matches the planar climb threshold mu >= tan(slope)', () => {
    const mass = 1_500;
    const gravity = 9.81;
    const angle = Math.atan(0.6);
    const normalLoad = mass * gravity * Math.cos(angle);
    const required = mass * gravity * Math.sin(angle);
    expect(tyreFrictionCapacity(normalLoad, 0.59, normalLoad, 0)).toBeLessThan(required);
    expect(tyreFrictionCapacity(normalLoad, 0.61, normalLoad, 0)).toBeGreaterThan(required);
  });

  it('relaxes force progressively over distance', () => {
    const first = relaxLongitudinalForce(0, 4_000, 10, 0.35, 1 / 60);
    const second = relaxLongitudinalForce(first, 4_000, 10, 0.35, 1 / 60);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(4_000);
  });

  it('shares a friction ellipse between longitudinal and lateral force', () => {
    const force = combineFrictionEllipse(4_000, 4_000, 4_000, 4_000);
    expect(force.utilization).toBe(1);
    expect(Math.hypot(force.longitudinal / 4_000, force.lateral / 4_000)).toBeCloseTo(1);
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

describe('lateralGripFromLongitudinalSlip', () => {
  // The combined-slip term. Its absence is why a locked wheel used to keep
  // about half its cornering force, and why the handbrake could never break
  // the rear loose: the tyre could not slide because it kept its grip, and
  // kept its grip because it was not sliding.
  const ROAD_PEAK = 0.10; // SURFACE_INFO road traction.peakSlip
  const MUD_PEAK = 0.40;  // deep mud

  it('is 1.0 at and below the surface peak slip (free-rolling keeps full grip)', () => {
    expect(lateralGripFromLongitudinalSlip(0, ROAD_PEAK)).toBeCloseTo(1.0, 5);
    expect(lateralGripFromLongitudinalSlip(ROAD_PEAK * 0.5, ROAD_PEAK)).toBeCloseTo(1.0, 5);
    expect(lateralGripFromLongitudinalSlip(ROAD_PEAK, ROAD_PEAK)).toBeCloseTo(1.0, 5);
  });

  it('collapses cornering grip for a fully locked wheel', () => {
    const locked = lateralGripFromLongitudinalSlip(1, ROAD_PEAK);
    expect(locked).toBeLessThan(0.25);
    expect(locked).toBeGreaterThanOrEqual(TIRE_LATERAL.combinedSlipFloor);
  });

  it('never drops below the floor, so a sliding tyre stays recoverable', () => {
    for (const slip of [0.5, 1, 2, -3]) {
      expect(lateralGripFromLongitudinalSlip(slip, ROAD_PEAK))
        .toBeGreaterThanOrEqual(TIRE_LATERAL.combinedSlipFloor);
    }
  });

  it('is symmetric in sign: locking and spinning both cost lateral grip', () => {
    expect(lateralGripFromLongitudinalSlip(0.6, ROAD_PEAK))
      .toBeCloseTo(lateralGripFromLongitudinalSlip(-0.6, ROAD_PEAK), 5);
  });

  it('is monotonic non-increasing past the peak', () => {
    const a = lateralGripFromLongitudinalSlip(0.2, ROAD_PEAK);
    const b = lateralGripFromLongitudinalSlip(0.5, ROAD_PEAK);
    const c = lateralGripFromLongitudinalSlip(0.9, ROAD_PEAK);
    expect(a).toBeGreaterThanOrEqual(b);
    expect(b).toBeGreaterThanOrEqual(c);
  });

  it('lets soft surfaces carry far more wheelspin before losing the rear', () => {
    // The knee is the surface's own peakSlip, so mud stays hooked up at a
    // slip ratio that has already cost a road tyre most of its cornering
    // force. This is what keeps throttle-steering in a bog controllable.
    expect(lateralGripFromLongitudinalSlip(0.35, MUD_PEAK))
      .toBeGreaterThan(lateralGripFromLongitudinalSlip(0.35, ROAD_PEAK));
  });

  it('reads the live floor and falloff tuning', () => {
    const saved = {
      floor: TUNING.tireCombinedSlipFloor,
      falloff: TUNING.tireCombinedSlipFalloff,
    };
    try {
      TUNING.tireCombinedSlipFloor = 0.6;
      TUNING.tireCombinedSlipFalloff = 20;
      const locked = lateralGripFromLongitudinalSlip(1, ROAD_PEAK);
      expect(locked).toBeGreaterThanOrEqual(0.6);
      expect(locked).toBeLessThan(0.61);
      // A steeper falloff must reach the floor sooner.
      TUNING.tireCombinedSlipFalloff = 1;
      expect(lateralGripFromLongitudinalSlip(0.5, ROAD_PEAK))
        .toBeGreaterThan(locked);
    } finally {
      TUNING.tireCombinedSlipFloor = saved.floor;
      TUNING.tireCombinedSlipFalloff = saved.falloff;
    }
  });
});
