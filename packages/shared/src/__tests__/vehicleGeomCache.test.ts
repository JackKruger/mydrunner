// geomFor caches, so the interesting failures are cache failures: two
// different builds sharing an entry, or a build resolving to its raw parts
// instead of its normalised ones. The render, effects and tyre-track paths
// call this every frame, so a wrong hit is a wrong truck on screen.

import { describe, expect, it } from 'vitest';
import { geomFor, restWheelPositions } from '../physics/vehicleGeom.js';
import {
  VEHICLE_BASE_IDS,
  createStockBuild,
  normalizeVehicleBuild,
  vehicleBuildKey,
} from '../vehicleBuild.js';

describe('vehicle geometry cache', () => {
  it('returns one shared instance for equal builds arriving as different objects', () => {
    for (const base of VEHICLE_BASE_IDS) {
      const held = createStockBuild(base);
      // What the snapshot decoder hands over: same parts, fresh object.
      const decoded = JSON.parse(JSON.stringify(createStockBuild(base))) as typeof held;
      expect(geomFor(decoded)).toBe(geomFor(held));
      expect(geomFor(held)).toEqual(geomFor(base));
      expect(restWheelPositions(decoded)).toBe(restWheelPositions(held));
    }
  });

  it('keeps builds that differ in any physical part apart', () => {
    const stock = createStockBuild('ridgeback');
    const lifted = normalizeVehicleBuild({ ...stock, suspensionId: 'ridgeback.suspension.flex-100' });
    const portal = normalizeVehicleBuild({ ...stock, axleId: 'ridgeback.axle.portal-240' });
    expect(geomFor(lifted).front.suspensionRestLength)
      .toBeGreaterThan(geomFor(stock).front.suspensionRestLength);
    expect(geomFor(portal).front.trackHalf).toBeGreaterThan(geomFor(stock).front.trackHalf);
    expect(restWheelPositions(portal)[0]!.x).toBeLessThan(restWheelPositions(stock)[0]!.x);
  });

  it('keeps paint out of the geometry but not out of the key', () => {
    const stock = createStockBuild('ridgeback');
    const red = normalizeVehicleBuild({ ...stock, paintColor: '#ff0000' });
    // Same steel, different paint: the physics must not move...
    expect(geomFor(red).front).toEqual(geomFor(stock).front);
    // ...but the resolved spec carries the colour, so the two must not share
    // a cache entry or a repaint would silently render in the old colour.
    expect(geomFor(red).spec.build.paintColor).toBe('#ff0000');
    expect(geomFor(stock).spec.build.paintColor).toBe(stock.paintColor);
  });

  it('resolves an unnormalised build to its normalised geometry', () => {
    const base = createStockBuild('longreach');
    // Legal combination: 37s with the flex lift they require.
    const legal = { ...base, tireId: 'longreach.tire.mt-37', suspensionId: 'longreach.suspension.flex-100' };
    expect(geomFor(legal)).toBe(geomFor(normalizeVehicleBuild(legal)));
    // Illegal combination: the normaliser drops back to the stock tyre, and
    // the cache must not shortcut past it and fit the 37s anyway.
    const illegal = { ...base, tireId: 'longreach.tire.mt-37' };
    expect(geomFor(illegal).wheelRadius).toBe(geomFor(base).wheelRadius);
  });

  it('survives null and junk at the boundary', () => {
    expect(geomFor(null as never).spec.build.baseId).toBe('ridgeback');
    expect(geomFor({ baseId: 'nope' } as never).spec.build.baseId).toBe('ridgeback');
    expect(geomFor({ baseId: 'outclaw' } as never).spec.build.baseId).toBe('outclaw');
  });

  it('keys on parts rather than field order', () => {
    const a = createStockBuild('outclaw');
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(vehicleBuildKey(reordered)).toBe(vehicleBuildKey(a));
    expect(geomFor(reordered)).toBe(geomFor(a));
  });
});
