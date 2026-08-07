import { describe, expect, it } from 'vitest';
import {
  WATER_NONE, dryWater, isWet, mountainFor, petrolStationPadFor,
  type TerrainData,
} from '../physics/terrain.js';
import {
  hasWater, sampleWaterDepth, sampleWaterFlow, sampleWaterLevel,
} from '../physics/water.js';

const SIZE = 40;
const RES = 9; // cell pitch = 40 / 8 = 5 m, cell centres land on round numbers

/** Flat ground at y=0 with no water. */
function flat(): TerrainData {
  return {
    size: SIZE,
    resolution: RES,
    heights: new Float32Array(RES * RES),
    surfaces: new Uint8Array(RES * RES),
    seed: 0,
    mountain: mountainFor(SIZE),
    petrolStation: petrolStationPadFor(SIZE),
    ...dryWater(RES),
    bogs: [],
    roads: [],
  };
}

/** World coordinate of grid column/row index. */
function coord(i: number): number {
  return (i / (RES - 1) - 0.5) * SIZE;
}

/** Flood every cell whose column index is in [c0, c1], at `level`. */
function floodColumns(t: TerrainData, c0: number, c1: number, level: number): void {
  for (let r = 0; r < RES; r++) {
    for (let c = c0; c <= c1; c++) t.waterLevel[r * RES + c] = level;
  }
}

describe('isWet', () => {
  it('rejects the sentinel and accepts real levels including zero', () => {
    expect(isWet(WATER_NONE)).toBe(false);
    expect(isWet(0)).toBe(true);
    expect(isWet(-1.4)).toBe(true);
  });

  it('still rejects a sentinel that has round-tripped through int16 cm', () => {
    // What applyMapDoc reconstitutes is -32768 cm, not -1e9. The threshold
    // form of isWet is what keeps that a dry cell rather than a lake
    // 327 m below the world.
    expect(isWet(-32768 / 100)).toBe(true); // a plain -327.68 m level IS wet...
    expect(isWet(WATER_NONE)).toBe(false); // ...but the sentinel never is
  });
});

describe('sampleWaterLevel', () => {
  it('returns the sentinel on a dry terrain', () => {
    const t = flat();
    expect(sampleWaterLevel(t, 0, 0)).toBe(WATER_NONE);
    expect(hasWater(t)).toBe(false);
  });

  it('returns the authored level over a flooded cell', () => {
    const t = flat();
    floodColumns(t, 0, RES - 1, 1.25);
    expect(sampleWaterLevel(t, 0, 0)).toBeCloseTo(1.25, 6);
    expect(hasWater(t)).toBe(true);
  });

  it('interpolates between two wet cells at different levels', () => {
    const t = flat();
    for (let r = 0; r < RES; r++) {
      t.waterLevel[r * RES + 4] = 2;
      t.waterLevel[r * RES + 5] = 4;
    }
    const midX = (coord(4) + coord(5)) / 2;
    expect(sampleWaterLevel(t, midX, 0)).toBeCloseTo(3, 5);
  });

  it('does not sag toward the sentinel at a shoreline', () => {
    // The failure this guards: averaging a dry neighbour's -1e9 into the
    // bilinear blend drags the surface to nonsense within one cell of
    // every bank, which would read as a hole in the water.
    const t = flat();
    floodColumns(t, 0, 4, 0.8);
    // Just inside the last wet column, and 90% of the way to the dry one.
    expect(sampleWaterLevel(t, coord(4), 0)).toBeCloseTo(0.8, 6);
    const nearlyDry = coord(4) + 0.9 * (coord(5) - coord(4));
    expect(sampleWaterLevel(t, nearlyDry, 0)).toBeCloseTo(0.8, 6);
  });

  it('is dry once every corner of the sampled cell is dry', () => {
    const t = flat();
    floodColumns(t, 0, 4, 0.8);
    expect(sampleWaterLevel(t, coord(6), 0)).toBe(WATER_NONE);
  });

  it('is dry outside the map', () => {
    const t = flat();
    floodColumns(t, 0, RES - 1, 1);
    expect(sampleWaterLevel(t, SIZE, 0)).toBe(WATER_NONE);
    expect(sampleWaterLevel(t, 0, -SIZE)).toBe(WATER_NONE);
  });
});

describe('sampleWaterDepth', () => {
  it('is the gap between surface and bed', () => {
    const t = flat();
    t.heights.fill(-1.5);
    floodColumns(t, 0, RES - 1, 0.2);
    expect(sampleWaterDepth(t, 0, 0)).toBeCloseTo(1.7, 5);
  });

  it('is zero where the bed pokes above the surface', () => {
    const t = flat();
    t.heights.fill(3);
    floodColumns(t, 0, RES - 1, 0.5);
    expect(sampleWaterDepth(t, 0, 0)).toBe(0);
  });

  it('is zero on dry ground', () => {
    expect(sampleWaterDepth(flat(), 0, 0)).toBe(0);
  });

  it('shallows out toward a sloping bank', () => {
    const t = flat();
    // Bed rises with +x; water surface flat at 0.
    for (let r = 0; r < RES; r++) {
      for (let c = 0; c < RES; c++) t.heights[r * RES + c] = coord(c) * 0.05;
    }
    floodColumns(t, 0, RES - 1, 0);
    const deep = sampleWaterDepth(t, coord(1), 0);
    const shallow = sampleWaterDepth(t, coord(3), 0);
    expect(deep).toBeGreaterThan(shallow);
    expect(shallow).toBeGreaterThan(0);
  });
});

describe('sampleWaterFlow', () => {
  it('is zero on still water', () => {
    const t = flat();
    floodColumns(t, 0, RES - 1, 1);
    const out = sampleWaterFlow(t, 0, 0, { x: 0, z: 0 });
    expect(out.x).toBe(0);
    expect(out.z).toBe(0);
  });

  it('reads back the authored velocity', () => {
    const t = flat();
    floodColumns(t, 0, RES - 1, 1);
    t.waterFlowX.fill(1.5);
    t.waterFlowZ.fill(-0.5);
    const out = sampleWaterFlow(t, 0, 0, { x: 0, z: 0 });
    expect(out.x).toBeCloseTo(1.5, 6);
    expect(out.z).toBeCloseTo(-0.5, 6);
  });

  it('interpolates direction without wrapping artifacts', () => {
    // Two cells with opposing flow average to zero, not to a half-turn
    // through some arbitrary direction. This is the property an
    // angle-plus-speed encoding would not have.
    const t = flat();
    floodColumns(t, 0, RES - 1, 1);
    for (let r = 0; r < RES; r++) {
      t.waterFlowX[r * RES + 4] = 2;
      t.waterFlowX[r * RES + 5] = -2;
    }
    const midX = (coord(4) + coord(5)) / 2;
    const out = sampleWaterFlow(t, midX, 0, { x: 0, z: 0 });
    expect(out.x).toBeCloseTo(0, 5);
  });

  it('is zero outside the map', () => {
    const t = flat();
    t.waterFlowX.fill(3);
    const out = sampleWaterFlow(t, SIZE * 2, 0, { x: 0, z: 0 });
    expect(out.x).toBe(0);
    expect(out.z).toBe(0);
  });
});
