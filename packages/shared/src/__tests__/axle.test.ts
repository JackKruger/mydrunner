// Pure-function tests for the software axle. No Rapier; verifies that
// rideY follows average ground compression, rollAngle follows terrain
// slope without snapping and clamps at the articulation cap, and the
// surplus torque is emitted to the chassis when articulation is capped.

import { describe, it, expect } from 'vitest';
import { AXLE, FIXED_DT } from '../constants.js';
import {
  applyAxleSnap,
  axleSnap,
  computeAntiRollLoadTransfer,
  createAxleState,
  resetAxleState,
  stepAxle,
} from '../physics/axle.js';
import type { AxleGeom } from '../physics/vehicleGeom.js';

function frontGeom(): AxleGeom {
  return { ...AXLE.front };
}

function step(s: ReturnType<typeof createAxleState>, comp: { l: number; r: number }, ticks: number) {
  let last = { chassisRideForce: 0, chassisRollTorque: 0 };
  for (let i = 0; i < ticks; i++) {
    last = stepAxle(s, {
      leftDepth: comp.l,
      rightDepth: comp.r,
      leftContact: comp.l > 0,
      rightContact: comp.r > 0,
      chassisVertVelAtAnchor: 0,
      dt: FIXED_DT,
    });
  }
  return last;
}

describe('axle: anti-roll load transfer', () => {
  const base = {
    leftDepth: 0.08,
    rightDepth: 0.08,
    leftRate: 0,
    rightRate: 0,
    leftSupported: true,
    rightSupported: true,
    trackHalf: 0.9,
    torqueStiffness: 70_000,
    torqueDamping: 16_000,
    maxTransferForce: 4_000,
  };

  it('does nothing at equal travel or with the whole axle airborne', () => {
    expect(computeAntiRollLoadTransfer(base)).toEqual({ leftForce: 0, rightForce: 0 });
    expect(computeAntiRollLoadTransfer({
      ...base,
      leftDepth: -0.27,
      rightDepth: -0.27,
      leftSupported: false,
      rightSupported: false,
    })).toEqual({ leftForce: 0, rightForce: 0 });
  });

  it('produces opposite supported-end forces and clamps the transfer', () => {
    const result = computeAntiRollLoadTransfer({ ...base, leftDepth: 0.5, rightDepth: -0.2 });
    expect(result.leftForce).toBe(-4_000);
    expect(result.rightForce).toBe(4_000);
    expect(result.leftForce + result.rightForce).toBe(0);
  });

  it('adjusts the supported end at full opposite droop but cannot push through air', () => {
    const result = computeAntiRollLoadTransfer({
      ...base,
      leftDepth: 0.1,
      rightDepth: -0.27,
      rightSupported: false,
    });
    expect(result.leftForce).toBeLessThan(0);
    expect(result.rightForce).toBe(0);
  });

  it('uses compression rate to oppose rapid articulation', () => {
    const result = computeAntiRollLoadTransfer({ ...base, leftRate: 1, rightRate: 0 });
    expect(result.leftForce).toBeGreaterThan(0);
    expect(result.rightForce).toBeLessThan(0);
  });
});

describe('axle: ride kinematics', () => {
  it('rideY converges on the average wheel-end compression', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    step(s, { l: 0.05, r: 0.05 }, 120);
    expect(s.rideY).toBeCloseTo(0.05, 4);
  });

  it('rideY converges on the average even with asymmetric compression', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    step(s, { l: 0.04, r: 0.10 }, 120);
    expect(s.rideY).toBeCloseTo(0.07, 4);
  });

  it('rideY clamps at the visual range (restLength * 0.85) past bumpMax', () => {
    // rideY is visual-only (solidAxleVehicle.ts ignores stepAxle's
    // chassisRideForce and applies per-wheel-end ride forces directly).
    // The clamp is set to keep the wheel mesh below the chassis
    // attachment point during sharp transient incursions, NOT at
    // bumpMax — capping at bumpMax produced visible "wheel half-buried
    // in the ground" on slope crests because the mesh couldn't follow
    // the ray reading higher than the bumpstop. The progressive
    // bumpstop on the physics side keeps these incursions short.
    const g = frontGeom();
    const s = createAxleState(g);
    step(s, { l: 5.0, r: 5.0 }, 120);
    expect(s.rideY).toBeCloseTo(g.suspensionRestLength * 0.85, 5);
    expect(s.rideY).toBeGreaterThan(g.bumpMax);
  });

  it('rideY extends toward full droop instead of snapping there', () => {
    // rideY is visual-only (solidAxleVehicle.ts applies per-wheel-end
    // ride forces directly and ignores stepAxle's chassisRideForce).
    // In-air the axle should extend continuously to full droop.
    const g = frontGeom();
    const s = createAxleState(g);
    step(s, { l: 0.05, r: 0.05 }, 120);
    const settled = s.rideY;
    expect(settled).toBeGreaterThan(0);
    // Drop to no contact. The first tick starts extending but retains
    // continuity; after enough time it reaches the mechanical stop.
    step(s, { l: 0, r: 0 }, 1);
    expect(s.rideY).toBeLessThan(settled);
    expect(s.rideY).toBeGreaterThan(-g.droopMax);
    step(s, { l: 0, r: 0 }, 240);
    expect(s.rideY).toBeCloseTo(-g.droopMax, 4);
  });

  it('chassis ride force is positive (pushes chassis up) under compression', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const out = step(s, { l: 0.10, r: 0.10 }, 1);
    expect(out.chassisRideForce).toBeCloseTo(g.rideStiffness * 0.10, 5);
    expect(out.chassisRideForce).toBeGreaterThan(0);
  });

  it('chassis ride force has a damping term against chassis vertical velocity', () => {
    // Damping is scaled by spring engagement (rideY/restLength) so the
    // damper stays soft at first contact and ramps up with compression.
    // For rideY=0.05 and restLength=0.55, engagement = 0.091.
    const g = frontGeom();
    const s = createAxleState(g);
    const r1 = stepAxle(s, {
      leftDepth: 0.05,
      rightDepth: 0.05,
      leftContact: true,
      rightContact: true,
      chassisVertVelAtAnchor: 0,
      dt: FIXED_DT,
    });
    resetAxleState(s);
    const r2 = stepAxle(s, {
      leftDepth: 0.05,
      rightDepth: 0.05,
      leftContact: true,
      rightContact: true,
      chassisVertVelAtAnchor: 1,
      dt: FIXED_DT,
    });
    expect(r2.chassisRideForce).toBeLessThan(r1.chassisRideForce);
    const expectedDelta = g.rideDamping * (0.05 / g.suspensionRestLength) * 1.0;
    expect(r1.chassisRideForce - r2.chassisRideForce).toBeCloseTo(expectedDelta, 2);
  });
});

describe('axle: roll articulation', () => {
  it('rollAngle converges on atan2(rightDepth - leftDepth, 2*trackHalf) below the cap', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const lc = 0.05;
    const rc = 0.20;
    step(s, { l: lc, r: rc }, 120);
    const target = Math.atan2(rc - lc, 2 * g.trackHalf);
    expect(target).toBeLessThan(g.maxArticulation); // sanity: below cap
    expect(s.rollAngle).toBeCloseTo(target, 5);
  });

  it('seats the supported wheel without pushing the other end below full droop', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const groundedDepth = 0.10;
    const expectedRide = 0.5 * (groundedDepth - g.droopMax);
    const expectedRoll = Math.atan2(
      groundedDepth + g.droopMax,
      2 * g.trackHalf,
    );

    for (let i = 0; i < 120; i++) {
      stepAxle(s, {
        leftDepth: 0,
        rightDepth: groundedDepth,
        leftContact: false,
        rightContact: true,
        chassisVertVelAtAnchor: 0,
        dt: FIXED_DT,
      });
    }

    expect(s.targetRideY).toBeCloseTo(expectedRide, 6);
    expect(s.targetRollAngle).toBeCloseTo(expectedRoll, 6);
    expect(s.rideY).toBeGreaterThanOrEqual(expectedRide);
    expect(s.rideY).toBeLessThan(expectedRide + 0.02);
    expect(s.rollAngle).toBeCloseTo(expectedRoll, 4);
    const supportedEndY = s.rideY + g.trackHalf * Math.sin(s.rollAngle);
    expect(supportedEndY).toBeCloseTo(groundedDepth, 5);
    const unsupportedEndY = s.rideY - g.trackHalf * Math.sin(s.rollAngle);
    expect(unsupportedEndY).toBeGreaterThanOrEqual(-g.droopMax);
    expect(unsupportedEndY).toBeLessThan(-g.droopMax + 0.02);
  });

  it('does not snap the beam when the ground target changes sides', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const target = Math.atan2(0.20 - 0.05, 2 * g.trackHalf);
    step(s, { l: 0.05, r: 0.20 }, 120);
    expect(s.rollAngle).toBeCloseTo(target, 5);

    step(s, { l: 0.20, r: 0.05 }, 1);
    expect(s.rollAngle).toBeGreaterThan(-target);
    expect(s.rollAngle).toBeLessThan(target);

    step(s, { l: 0.20, r: 0.05 }, 120);
    expect(s.rollAngle).toBeCloseTo(-target, 5);
  });

  it('rollAngle clamps at +maxArticulation when target exceeds cap', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    step(s, { l: 0, r: 1.5 }, 120);
    expect(s.rollAngle).toBeCloseTo(g.maxArticulation, 5);
  });

  it('rollAngle clamps at -maxArticulation when target is sharply negative', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    step(s, { l: 1.5, r: 0 }, 120);
    expect(s.rollAngle).toBeCloseTo(-g.maxArticulation, 5);
  });

  it('chassisRollTorque is zero below the cap and non-zero past it', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const small = step(s, { l: 0.05, r: 0.10 }, 1);
    expect(small.chassisRollTorque).toBe(0);

    resetAxleState(s);
    const big = step(s, { l: 0, r: 2.0 }, 1);
    expect(big.chassisRollTorque).toBeGreaterThan(0);
    expect(Math.sign(big.chassisRollTorque)).toBe(1);
  });

  it('chassisRollTorque sign matches the side that hit the cap', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const r = step(s, { l: 2.0, r: 0 }, 1);
    expect(r.chassisRollTorque).toBeLessThan(0);
  });
});

// The debug panel's axle sliders wrote to TUNING.axleFront/axleRear,
// which nothing read - stepAxle and solidAxleVehicle both took their
// rates straight from the geom. They are multipliers now, threaded
// through StepAxleInputs so this module stays free of shared mutable
// state.
describe('axle: runtime multipliers', () => {
  it('maxArticulationMult scales the articulation cap', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    // Depth has to be steep enough that atan2(depth, 2*trackHalf) clears
    // the DOUBLED cap, or it never clamps and the test proves nothing.
    const doubled = g.maxArticulation * 2;
    const rightDepth = Math.tan(doubled) * 2 * g.trackHalf * 1.5;
    for (let i = 0; i < 120; i++) {
      stepAxle(s, {
        leftDepth: 0,
        rightDepth,
        leftContact: false,
        rightContact: true,
        chassisVertVelAtAnchor: 0,
        dt: FIXED_DT,
        maxArticulationMult: 2,
      });
    }
    expect(Math.atan2(rightDepth, 2 * g.trackHalf)).toBeGreaterThan(doubled); // sanity
    expect(s.rollAngle).toBeCloseTo(doubled, 5);
  });

  it('a larger cap absorbs articulation that would otherwise lever the chassis', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const base = { leftDepth: 0, rightDepth: 0.9, leftContact: false, rightContact: true, chassisVertVelAtAnchor: 0, dt: FIXED_DT };
    const capped = stepAxle(s, base);
    expect(capped.chassisRollTorque).toBeGreaterThan(0);

    resetAxleState(s);
    const roomy = stepAxle(s, { ...base, maxArticulationMult: 3 });
    expect(roomy.chassisRollTorque).toBe(0);
  });

  it('rollStiffnessMult scales the surplus torque past the cap', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const base = { leftDepth: 0, rightDepth: 2.0, leftContact: false, rightContact: true, chassisVertVelAtAnchor: 0, dt: FIXED_DT };
    const plain = stepAxle(s, base);
    resetAxleState(s);
    const doubled = stepAxle(s, { ...base, rollStiffnessMult: 2 });
    expect(doubled.chassisRollTorque).toBeCloseTo(plain.chassisRollTorque * 2, 5);
  });

  it('defaults to the geom values when no multiplier is supplied', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    const withOne = step(s, { l: 0, r: 1.5 }, 1);
    resetAxleState(s);
    const explicit = stepAxle(s, {
      leftDepth: 0,
      rightDepth: 1.5,
      leftContact: false,
      rightContact: true,
      chassisVertVelAtAnchor: 0,
      dt: FIXED_DT,
      rollStiffnessMult: 1,
      maxArticulationMult: 1,
    });
    expect(explicit.chassisRollTorque).toBeCloseTo(withOne.chassisRollTorque, 5);
    for (let i = 1; i < 120; i++) {
      stepAxle(s, {
        leftDepth: 0,
        rightDepth: 1.5,
        leftContact: false,
        rightContact: true,
        chassisVertVelAtAnchor: 0,
        dt: FIXED_DT,
        rollStiffnessMult: 1,
        maxArticulationMult: 1,
      });
    }
    expect(s.rollAngle).toBeCloseTo(g.maxArticulation, 5);
  });
});

describe('axle snap apply/extract round-trip', () => {
  it('applyAxleSnap restores rideY/rollAngle and zeroes velocities', () => {
    const g = frontGeom();
    const s = createAxleState(g);
    s.rideY = 0.07;
    s.rollAngle = 0.12;
    s.rideVelY = 1.5;
    s.rollVel = -0.3;
    const snap = axleSnap(s);
    resetAxleState(s);
    applyAxleSnap(s, snap);
    expect(s.rideY).toBeCloseTo(0.07);
    expect(s.targetRideY).toBeCloseTo(0.07);
    expect(s.rollAngle).toBeCloseTo(0.12);
    expect(s.targetRollAngle).toBeCloseTo(0.12);
    expect(s.rideVelY).toBe(0);
    expect(s.rollVel).toBe(0);
  });
});
