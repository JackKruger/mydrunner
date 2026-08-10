// The marker table, and the decoder that validates against it.
//
// The point of the table is that a new marker kind cannot be half-added:
// the Record type makes the entry mandatory, and these tests pin the two
// places that used to keep their own copy of the kind list.

import { describe, expect, it } from 'vitest';
import { Maps } from '../index.js';

describe('MARKER_INFO', () => {
  it('describes every kind the union has', () => {
    for (const kind of Maps.MARKER_KINDS) {
      const info = Maps.markerInfo(kind);
      expect(info.label.length, kind).toBeGreaterThan(0);
      expect(info.labelPrefix.length, kind).toBeGreaterThan(0);
      expect(info.hint.length, kind).toBeGreaterThan(0);
      const [min, max] = info.radiusLimits;
      expect(min, kind).toBeGreaterThan(0);
      expect(max, kind).toBeGreaterThan(min);
      expect(info.defaultRadius, kind).toBeGreaterThanOrEqual(min);
      expect(info.defaultRadius, kind).toBeLessThanOrEqual(max);
    }
  });

  it('keeps the shipped workshop bay radius as the garage default', () => {
    // The three bays under the station canopy are 3 m apart; a default
    // wider than half of that would author bays that overlap on sight.
    expect(Maps.markerInfo('garageBay').defaultRadius).toBe(1.65);
    expect(Maps.markerInfo('garageBay').usesYaw).toBe(true);
  });

  it('gives each kind its own colour', () => {
    const colors = Maps.MARKER_KINDS.map((k) => Maps.markerInfo(k).color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('recognises exactly the kinds in the table', () => {
    for (const kind of Maps.MARKER_KINDS) expect(Maps.isMarkerKind(kind)).toBe(true);
    expect(Maps.isMarkerKind('wormhole')).toBe(false);
    // Inherited properties are not kinds.
    expect(Maps.isMarkerKind('toString')).toBe(false);
  });
});

describe('the default map', () => {
  it('marks its workshop bays with garage markers the editor can now edit', () => {
    const doc = Maps.getMap(Maps.DEFAULT_MAP_ID)!;
    const bays = doc.markers.filter((m) => m.kind === 'garageBay');
    expect(bays.length).toBeGreaterThan(0);
    for (const bay of bays) {
      expect(Maps.isMarkerKind(bay.kind)).toBe(true);
      // The bay visual is sized from the radius, so a zero would paint
      // nothing on the ground and leave the trigger invisible again.
      expect(bay.radius).toBeGreaterThan(0);
      expect(bay.yaw).toBeTypeOf('number');
    }
  });
});
