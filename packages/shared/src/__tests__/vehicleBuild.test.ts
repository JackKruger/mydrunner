import { describe, expect, it } from 'vitest';
import {
  VEHICLE_BASE_IDS,
  VEHICLE_PART_CATALOGS,
  createStockBuild,
  decodeVehicleGarage,
  isNormalizedVehicleBuild,
  normalizeVehicleBuildDetailed,
  partCompatibility,
  resolveVehicleSpec,
} from '../vehicleBuild.js';

describe('vehicle builds', () => {
  it('creates a valid stock build for all production bases', () => {
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

  it('offers wide axles plus wide and larger tyre packages with real geometry', () => {
    const stock = createStockBuild('ridgeback');
    const catalog = VEHICLE_PART_CATALOGS.ridgeback;
    const wide33 = resolveVehicleSpec({
      ...stock,
      tireId: catalog.tires.find((part) => part.id.endsWith('.at-33-wide'))!.id,
    });
    const extreme = resolveVehicleSpec({
      ...stock,
      suspensionId: catalog.suspension.find((part) => part.id.endsWith('.flex-100'))!.id,
      axleId: catalog.axles.find((part) => part.id.endsWith('.portal-240'))!.id,
      tireId: catalog.tires.find((part) => part.id.endsWith('.xt-40-wide'))!.id,
    });
    const baseline = resolveVehicleSpec(stock);

    expect(catalog.axles).toHaveLength(3);
    expect(wide33.wheelWidth).toBeGreaterThan(resolveVehicleSpec({
      ...stock,
      tireId: catalog.tires.find((part) => part.id.endsWith('.at-33'))!.id,
    }).wheelWidth);
    expect(extreme.track - baseline.track).toBeCloseTo(0.24);
    expect(extreme.wheelRadius).toBeCloseTo(0.508);
    expect(extreme.wheelWidth).toBeCloseTo(0.42);
    expect(extreme.suspensionRestLength - baseline.suspensionRestLength).toBeCloseTo(0.18);
    expect(extreme.groundClearance).toBeGreaterThan(baseline.groundClearance);
    expect(extreme.grip.deepMud).toBeGreaterThan(baseline.grip.deepMud);
  });

  it('requires flex suspension and portal axles for 40-inch tyres', () => {
    const stock = createStockBuild('overlander');
    const catalog = VEHICLE_PART_CATALOGS.overlander;
    const tire40 = catalog.tires.find((part) => part.id.endsWith('.xt-40-wide'))!.id;
    const lifted = {
      ...stock,
      suspensionId: catalog.suspension.find((part) => part.id.endsWith('.flex-100'))!.id,
    };

    expect(partCompatibility(stock, 'tireId', tire40)).toEqual({
      enabled: false,
      reason: 'Requires the 100 mm flex lift.',
    });
    expect(partCompatibility(lifted, 'tireId', tire40)).toEqual({
      enabled: false,
      reason: 'Requires the 240 mm portal axles.',
    });
    expect(partCompatibility({
      ...lifted,
      axleId: catalog.axles.find((part) => part.id.endsWith('.portal-240'))!.id,
    }, 'tireId', tire40).enabled).toBe(true);
  });

  it('migrates builds saved before axle choices to factory-width axles', () => {
    const legacy = { ...createStockBuild('longreach') } as Record<string, unknown>;
    delete legacy.axleId;
    expect(normalizeVehicleBuildDetailed(legacy).build.axleId).toBe('longreach.axle.factory');
  });

  it('keeps each stock base physically distinct', () => {
    const specs = VEHICLE_BASE_IDS.map((id) => resolveVehicleSpec(createStockBuild(id)));
    expect(new Set(specs.map((s) => s.wheelbase)).size).toBe(VEHICLE_BASE_IDS.length);
    expect(new Set(specs.map((s) => s.massKg)).size).toBe(VEHICLE_BASE_IDS.length);
    expect(new Set(specs.map((s) => s.intakeHeight)).size).toBe(VEHICLE_BASE_IDS.length);
  });

  it('gives the Outclaw its purpose-built crawler geometry', () => {
    const crawler = resolveVehicleSpec(createStockBuild('outclaw'));
    const widestOther = Math.max(...VEHICLE_BASE_IDS
      .filter((id) => id !== 'outclaw')
      .map((id) => resolveVehicleSpec(createStockBuild(id)).track));
    expect(crawler.track).toBeGreaterThan(widestOther);
    expect(crawler.articulation).toBeGreaterThan(0.6);
    expect(crawler.lowRangeRatio).toBeGreaterThan(3);
    expect(crawler.build.frontLocker).toBe(true);
    expect(crawler.build.rearLocker).toBe(true);
  });

  it('makes the Dustback the light, low, quick-steering gravel specialist', () => {
    const dustback = resolveVehicleSpec(createStockBuild('dustback-rs'));
    const fourByFours = VEHICLE_BASE_IDS
      .filter((id) => id !== 'dustback-rs')
      .map((id) => resolveVehicleSpec(createStockBuild(id)));
    expect(dustback.drivetrain).toBe('fixed-rwd');
    expect(dustback.massKg).toBeLessThan(Math.min(...fourByFours.map((spec) => spec.massKg)));
    expect(dustback.groundClearance).toBeLessThan(Math.min(...fourByFours.map((spec) => spec.groundClearance)));
    expect(dustback.steeringResponse).toBeGreaterThan(Math.max(...fourByFours.map((spec) => spec.steeringResponse)));
    expect(dustback.grip.mud).toBeLessThan(Math.min(...fourByFours.map((spec) => spec.grip.mud)));
    expect(dustback.wadingDepth).toBeLessThan(Math.min(...fourByFours.map((spec) => spec.wadingDepth)));
    expect(dustback.damageResistance).toBeLessThan(Math.min(...fourByFours.map((spec) => spec.damageResistance)));
    expect(dustback.powerMult).toBeGreaterThan(Math.max(...fourByFours.map((spec) => spec.powerMult)));
    expect(dustback.finalDriveMult).toBeLessThan(1);
  });

  it('gives its gravel tyre the strongest Dustback gravel grip', () => {
    const stock = createStockBuild('dustback-rs');
    const tires = VEHICLE_PART_CATALOGS['dustback-rs'].tires.map((tire) =>
      resolveVehicleSpec({ ...stock, tireId: tire.id }));
    expect(tires[1]!.grip.gravel).toBeGreaterThan(tires[0]!.grip.gravel);
    expect(tires[1]!.grip.gravel).toBeGreaterThan(tires[2]!.grip.gravel);
  });

  it('normalizes unsupported Dustback parts and front lockers safely', () => {
    const result = normalizeVehicleBuildDetailed({
      ...createStockBuild('dustback-rs'),
      frontLocker: true,
      winchId: 'dustback-rs.winch.fitted',
      snorkelId: 'dustback-rs.snorkel.fitted',
    });
    expect(result.build.frontLocker).toBe(false);
    expect(result.build.winchId).toBe('dustback-rs.winch.none');
    expect(result.build.snorkelId).toBe('dustback-rs.snorkel.none');
    expect(result.issues).toHaveLength(3);
  });

  it('persists a named Dustback LSD build through the garage decoder', () => {
    const build = { ...createStockBuild('dustback-rs'), rearLocker: true, tireId: 'dustback-rs.tire.gravel-rally' };
    const garage = decodeVehicleGarage(JSON.stringify({
      version: 1,
      builds: [{ id: 'rally-1', name: 'Gravel setup', build, updatedAt: 42 }],
    }));
    expect(garage.builds[0]).toEqual({ id: 'rally-1', name: 'Gravel setup', build, updatedAt: 42 });
  });

  it('migrates removed Falcon and motorbike saves to the Ridgeback', () => {
    for (const carKind of ['ute', 'motorbike', 'patrol']) {
      const garage = decodeVehicleGarage({ carKind, color: '#123456' });
      expect(garage.builds[0]!.build.baseId).toBe('ridgeback');
      expect(garage.builds[0]!.build.paintColor).toBe('#123456');
    }
  });
});
