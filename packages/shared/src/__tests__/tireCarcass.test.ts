import { describe, expect, it } from 'vitest';
import {
  carcassRates,
  classifyTireContact,
  solveSeriesCompliance,
  solveSidewallConstraint,
  pressureEdgeWrapScale,
  pressureLateralScale,
  pressureRadialScale,
  pressureRollingScale,
  sealedRoadPressureGripScale,
} from '../physics/tireCarcass.js';
import { VEHICLE_PART_CATALOGS } from '../vehicleBuild.js';

describe('directional tyre carcass', () => {
  it('classifies tread, smoothly blended shoulder and sidewall contacts', () => {
    expect(classifyTireContact(0.2)).toMatchObject({ zone: 'tread', treadFraction: 1 });
    const shoulderA = classifyTireContact(0.45);
    const shoulderB = classifyTireContact(0.7);
    expect(shoulderA.zone).toBe('shoulder');
    expect(shoulderA.treadFraction).toBeGreaterThan(shoulderB.treadFraction);
    expect(classifyTireContact(0.9)).toMatchObject({ zone: 'sidewall', treadFraction: 0 });
  });

  it('gives every catalogue tyre an explicit carcass without id inference', () => {
    for (const catalog of Object.values(VEHICLE_PART_CATALOGS)) {
      for (const tire of catalog.tires) {
        expect(tire.tireCarcass).toMatchObject({
          radialDampingRatio: 0.7,
          sidewallDampingRatio: 0.5,
          sidewallFrictionRatio: 0.35,
        });
      }
    }
  });

  it('partitions one load through springs in series without double force', () => {
    const result = solveSeriesCompliance(0.1, 50_000, 250_000, 0.05);
    expect(result.suspensionDeflection + result.carcassDeflection).toBeCloseTo(0.1, 8);
    expect(result.suspensionForce).toBeCloseTo(result.carcassForce, 8);
    expect(result.force).toBeLessThan(50_000 * 0.1);
  });

  it('derives static stiffness from quarter load and preset deflection', () => {
    const rates = carcassRates({
      staticDeflectionRatio: 0.04,
      radialDampingRatio: 0.7,
      sidewallDampingRatio: 0.5,
      sidewallFrictionRatio: 0.35,
      nominalPressurePsi: 34,
      minPressurePsi: 20,
      maxPressurePsi: 42,
    }, 0.4, 4_000, 450);
    expect(rates.stiffness * 0.4 * 0.04).toBeCloseTo(4_000, 6);
    expect(rates.sidewallDamping).toBeCloseTo(rates.radialDamping * 0.5, 8);
  });

  it('scales carcass, response and rolling resistance with pressure', () => {
    expect(pressureRadialScale(17, 34)).toBe(0.55);
    expect(pressureLateralScale(17, 34)).toBeCloseTo(0.75);
    expect(pressureRollingScale(17, 34)).toBeGreaterThan(1);
    expect(sealedRoadPressureGripScale(17, 34)).toBeLessThan(1);
  });

  it('bounds ledge tread wrapping above and below nominal pressure', () => {
    const low = pressureEdgeWrapScale(10, 20);
    const nominal = pressureEdgeWrapScale(20, 20);
    const high = pressureEdgeWrapScale(30, 20);
    expect(low).toBeGreaterThan(nominal);
    expect(nominal).toBe(1);
    expect(high).toBeLessThan(nominal);
    expect(pressureEdgeWrapScale(1, 100)).toBe(1.75);
    expect(pressureEdgeWrapScale(100, 1)).toBe(0.75);
  });

  it('keeps the implicit sidewall constraint bounded and releases gradually', () => {
    const hit = solveSidewallConstraint(0.2, -20, 450, 1 / 60, 0, 0.04);
    expect(hit.deflection).toBe(0.04);
    expect(hit.correctionSpeed).toBeLessThanOrEqual(2.5);
    expect(hit.impulse).toBeLessThanOrEqual(4_000);
    const release = solveSidewallConstraint(0, 0, 450, 1 / 60, hit.deflection, 0.04);
    expect(release.deflection).toBeGreaterThan(0);
    expect(release.deflection).toBeLessThan(hit.deflection);
  });
});
