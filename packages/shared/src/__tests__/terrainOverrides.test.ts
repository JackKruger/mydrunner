// The pad and the bogs used to be read straight from TERRAIN inside
// generateTerrain, so a map could not move the petrol station or dig a
// mud hole anywhere new. These tests pin the override path an authored
// map drives.

import { describe, it, expect } from 'vitest';
import {
  generateTerrain, petrolStationPadFor, sampleHeightBilinear, sampleSurface,
  Surface, type Bog,
} from '../physics/terrain.js';
import { landmarksFor } from '../physics/landmarks.js';
import { TERRAIN } from '../constants.js';

describe('petrol station pad override', () => {
  const moved = { ...petrolStationPadFor(TERRAIN.defaultSize), cx: 40, cz: 60 };

  it('flattens the heightfield at the new location', () => {
    const t = generateTerrain({ pad: moved });
    expect(sampleHeightBilinear(t, 40, 60)).toBeCloseTo(0, 3);
  });

  it('lays concrete at the new location', () => {
    const t = generateTerrain({ pad: moved });
    expect(sampleSurface(t, 40, 60)).toBe(Surface.Concrete);
  });

  it('leaves the default location alone', () => {
    const base = generateTerrain();
    const t = generateTerrain({ pad: moved });
    const def = petrolStationPadFor(TERRAIN.defaultSize);
    expect(sampleSurface(base, def.cx, def.cz)).toBe(Surface.Concrete);
    expect(sampleSurface(t, def.cx, def.cz)).not.toBe(Surface.Concrete);
  });

  // landmarksFor used to re-derive the pad from terrain.size, which would
  // have left the station's colliders behind when the concrete moved.
  it('moves the station colliders with the concrete', () => {
    const t = generateTerrain({ pad: moved });
    const { petrolStation } = landmarksFor(t);
    expect(petrolStation.x).toBe(40);
    expect(petrolStation.z).toBe(60);
  });

  it('carries a pad yaw through to the station', () => {
    const t = generateTerrain({ pad: { ...moved, yaw: 0.7 } });
    expect(landmarksFor(t).petrolStation.yaw).toBeCloseTo(0.7, 6);
  });
});

describe('bog override', () => {
  it('digs a bog where the map asks for one', () => {
    const bogs: Bog[] = [{ x: 100, z: -100, depth: 2.5, sigma: 10 }];
    const t = generateTerrain({ bogs });
    const base = generateTerrain();
    expect(sampleHeightBilinear(t, 100, -100))
      .toBeLessThan(sampleHeightBilinear(base, 100, -100) - 1.5);
  });

  it('replaces the default set rather than adding to it', () => {
    // bogs[0] sits at z = roadZ, where roadLayer re-flattens to 0 after
    // bogLayer has dug — it reads identical with and without bogs. Use one
    // out in open terrain.
    const openBog = TERRAIN.bogs[1]!;
    const t = generateTerrain({ bogs: [] });
    const base = generateTerrain();
    expect(sampleHeightBilinear(base, openBog.x, openBog.z))
      .toBeLessThan(sampleHeightBilinear(t, openBog.x, openBog.z) - 1.0);
  });

  // Bogs carve the depression; they do not paint it. mudSurfaceRule
  // early-returns when the surface is already Dirt, and the accumulator
  // starts at Dirt — so the shipped world has 3 mud cells out of 16384.
  // Pinned here so the editor's surface painting is understood as the only
  // way mud currently reaches the map, and so a future fix to the rule
  // shows up as a deliberate change to this expectation.
  it('does not paint mud, because mudSurfaceRule cannot override Dirt', () => {
    const t = generateTerrain({ bogs: [{ x: 100, z: -100, depth: 4, sigma: 12 }] });
    expect(sampleSurface(t, 100, -100)).toBe(Surface.Dirt);

    const mudCells = generateTerrain().surfaces
      .reduce((n, s) => n + (s === Surface.Mud || s === Surface.DeepMud ? 1 : 0), 0);
    expect(mudCells).toBe(3);
  });
});

describe('defaults are unchanged', () => {
  it('an empty options object reproduces the shipped world exactly', () => {
    const a = generateTerrain();
    const b = generateTerrain({});
    expect(Array.from(b.heights)).toEqual(Array.from(a.heights));
    expect(Array.from(b.surfaces)).toEqual(Array.from(a.surfaces));
    expect(b.petrolStation).toEqual(petrolStationPadFor(TERRAIN.defaultSize));
    expect(b.bogs).toEqual(TERRAIN.bogs);
  });
});
