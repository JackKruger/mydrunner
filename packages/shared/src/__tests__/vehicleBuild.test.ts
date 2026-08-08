import { describe, expect, it } from 'vitest';
import {
  VEHICLE_BASE_IDS,
  createStockBuild,
  decodeVehicleGarage,
  isNormalizedVehicleBuild,
  normalizeVehicleBuildDetailed,
  partCompatibility,
  resolveVehicleSpec,
} from '../vehicleBuild.js';

describe('vehicle builds', () => {
  it('creates a valid stock build for all five production bases', () => {
    for (const base of VEHICLE_BASE_IDS) {
      const build = createStockBuild(base);
      expect(isNormalizedVehicleBuild(build)).toBe(true);
      expect(resolveVehicleSpec(build).build).toEqual(build);
    }
  });

  it('normalizes incompatible and foreign part combinations', () => {
    const source = {
      ...createStockBuild('ridgeback'),
      tireId: 'ridgeback.tire.mt-35',
      winchId: 'ridgeback.winch.fitted',
      wheelId: 'longreach.wheel.classic-steel',
    };
    const result = normalizeVehicleBuildDetailed(source);
    expect(result.build.tireId).toBe('ridgeback.tire.factory');
    expect(result.build.winchId).toBe('ridgeback.winch.none');
    expect(result.build.wheelId).toBe('ridgeback.wheel.factory');
    expect(result.issues).toHaveLength(3);
  });

  it('explains disabled selections without hiding them', () => {
    const build = createStockBuild('overlander');
    expect(partCompatibility(build, 'tireId', 'overlander.tire.mt-35')).toEqual({
      enabled: false,
      reason: 'Requires the 100 mm flex lift.',
    });
    expect(partCompatibility(build, 'winchId', 'overlander.winch.fitted').enabled).toBe(false);
  });

  it('derives the intended physical trade-offs deterministically', () => {
    const stock = createStockBuild('ridgeback');
    const heavy = {
      ...stock,
      suspensionId: 'ridgeback.suspension.flex-100',
      tireId: 'ridgeback.tire.mt-35',
      frontBarId: 'ridgeback.frontBar.steel-winch',
      winchId: 'ridgeback.winch.fitted',
      roofId: 'ridgeback.roof.platform-awning',
    };
    const a = resolveVehicleSpec(stock);
    const b = resolveVehicleSpec(heavy);
    expect(resolveVehicleSpec(heavy)).toEqual(b);
    expect(b.massKg).toBeGreaterThan(a.massKg);
    expect(b.groundClearance).toBeGreaterThan(a.groundClearance);
    expect(b.droop).toBeGreaterThan(a.droop);
    expect(b.stability).toBeLessThan(a.stability);
    expect(b.steeringResponse).toBeLessThan(a.steeringResponse);
    expect(b.grip.deepMud).toBeGreaterThan(a.grip.deepMud);
  });

  it('keeps each stock base physically distinct', () => {
    const specs = VEHICLE_BASE_IDS.map((id) => resolveVehicleSpec(createStockBuild(id)));
    expect(new Set(specs.map((s) => s.wheelbase)).size).toBe(5);
    expect(new Set(specs.map((s) => s.massKg)).size).toBe(5);
    expect(new Set(specs.map((s) => s.intakeHeight)).size).toBe(5);
  });

  it('migrates removed Falcon and motorbike saves to the Ridgeback', () => {
    for (const carKind of ['ute', 'motorbike', 'patrol']) {
      const garage = decodeVehicleGarage({ carKind, color: '#123456' });
      expect(garage.builds[0]!.build.baseId).toBe('ridgeback');
      expect(garage.builds[0]!.build.paintColor).toBe('#123456');
    }
  });
});
