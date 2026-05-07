// Terrain math tests: bilinear height sampling, pointToSegmentDist,
// and basic generated-terrain properties.

import { describe, it, expect } from 'vitest';
import {
  sampleHeightBilinear,
  worldToTerrainIndex,
  pointToSegmentDist,
  generateTerrain,
  mountainFor,
  petrolStationPadFor,
  type TerrainData,
} from '../physics/terrain.js';
import { TERRAIN } from '../constants.js';

function makeTerrain(resolution: number, size: number, heights: number[]): TerrainData {
  return {
    size,
    resolution,
    heights: new Float32Array(heights),
    surfaces: new Uint8Array(resolution * resolution),
    seed: 0,
    mountain: mountainFor(size),
    petrolStation: petrolStationPadFor(size),
    bogs: [],
    roads: [],
  };
}

describe('sampleHeightBilinear', () => {
  it('returns exact height at grid corners', () => {
    // 2x2, size=2 → corners at (±1, ±1)
    // r=0,c=0 → (x=-1, z=-1); r=0,c=1 → (x=1, z=-1)
    // r=1,c=0 → (x=-1, z=1);  r=1,c=1 → (x=1, z=1)
    const t = makeTerrain(2, 2, [1, 2, 3, 4]);
    expect(sampleHeightBilinear(t, -1, -1)).toBeCloseTo(1);
    expect(sampleHeightBilinear(t, 1, -1)).toBeCloseTo(2);
    expect(sampleHeightBilinear(t, -1, 1)).toBeCloseTo(3);
    expect(sampleHeightBilinear(t, 1, 1)).toBeCloseTo(4);
  });

  it('returns the bilinear average at the center of a 2x2 grid', () => {
    // At (x=0, z=0): u=0.5, v=0.5 → all four corners weighted equally
    const t = makeTerrain(2, 2, [0, 4, 8, 12]);
    expect(sampleHeightBilinear(t, 0, 0)).toBeCloseTo((0 + 4 + 8 + 12) / 4);
  });

  it('interpolates smoothly along a linear x-ramp', () => {
    // n=3, size=4: x-coords are -2, 0, +2; heights proportional to column index
    // Row-major: heights[r*3+c] = c*2, all rows identical → [0,2,4, 0,2,4, 0,2,4]
    const heights = [0, 2, 4, 0, 2, 4, 0, 2, 4];
    const t = makeTerrain(3, 4, heights);
    expect(sampleHeightBilinear(t, -2, 0)).toBeCloseTo(0); // left edge
    expect(sampleHeightBilinear(t, 0, 0)).toBeCloseTo(2);  // center
    expect(sampleHeightBilinear(t, 2, 0)).toBeCloseTo(4);  // right edge
    // Midpoints should interpolate linearly
    expect(sampleHeightBilinear(t, -1, 0)).toBeCloseTo(1);
    expect(sampleHeightBilinear(t, 1, 0)).toBeCloseTo(3);
  });

  it('gives a different (non-snapped) result from nearest-neighbor on a slope', () => {
    // Peak at center cell only; a point slightly off-center should yield an
    // interpolated value less than the peak, not snap to it.
    // n=3, size=4: heights=[0,0,0, 0,6,0, 0,0,0]  — only centre cell = 6
    const heights = [0, 0, 0, 0, 6, 0, 0, 0, 0];
    const t = makeTerrain(3, 4, heights);

    const x = 0.5;
    const z = 0.5; // slightly off centre

    const bilinear = sampleHeightBilinear(t, x, z);
    const nnIdx = worldToTerrainIndex(t, x, z);
    const nearestNeighbor = t.heights[nnIdx] ?? 0;

    // Nearest-neighbour snaps to the peak cell (6); bilinear gives < 6
    expect(nearestNeighbor).toBeCloseTo(6);
    expect(bilinear).toBeGreaterThan(0);
    expect(bilinear).toBeLessThan(nearestNeighbor);
  });

  it('returns 0 for out-of-bounds coordinates', () => {
    const t = makeTerrain(4, 100, new Array(16).fill(5));
    expect(sampleHeightBilinear(t, 200, 0)).toBe(0);
    expect(sampleHeightBilinear(t, 0, -200)).toBe(0);
    expect(sampleHeightBilinear(t, -1000, 1000)).toBe(0);
  });
});

describe('pointToSegmentDist', () => {
  it('returns 0 for a point on the segment', () => {
    expect(pointToSegmentDist(5, 0, 0, 0, 10, 0)).toBeCloseTo(0);
    expect(pointToSegmentDist(0, 0, -5, 0, 5, 0)).toBeCloseTo(0); // midpoint
  });

  it('returns perpendicular distance for a point beside the segment', () => {
    // Segment (0,0)→(10,0); point (5,3) → distance 3
    expect(pointToSegmentDist(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
    expect(pointToSegmentDist(5, -4, 0, 0, 10, 0)).toBeCloseTo(4);
  });

  it('returns distance to nearest endpoint when projection falls outside', () => {
    // Segment (0,0)→(10,0); point (-3,4) → nearest end (0,0), dist=5
    expect(pointToSegmentDist(-3, 4, 0, 0, 10, 0)).toBeCloseTo(5);
    // Point (13,0) → nearest end (10,0), dist=3
    expect(pointToSegmentDist(13, 0, 0, 0, 10, 0)).toBeCloseTo(3);
  });

  it('handles a zero-length segment', () => {
    // degenerate segment (2,3)→(2,3); dist to (5,7) = hypot(3,4) = 5
    expect(pointToSegmentDist(5, 7, 2, 3, 2, 3)).toBeCloseTo(5);
  });
});

describe('generateTerrain road properties', () => {
  it('road core cells are exactly flat at height 0', () => {
    const t = generateTerrain({ size: 100, resolution: 64, seed: 42 });
    // Default road runs along z = TERRAIN.roadZ; roadCore=8 → all cells with
    // |z - roadZ| < 8 are flat.
    const rz = TERRAIN.roadZ;
    for (const x of [-30, -15, 0, 15, 30]) {
      const h = sampleHeightBilinear(t, x, rz);
      expect(h, `height at (${x}, ${rz})`).toBeCloseTo(0, 1);
    }
  });

  it('terrain height increases significantly away from the road', () => {
    const t = generateTerrain({ size: 100, resolution: 64, seed: 42 });
    const rz = TERRAIN.roadZ;
    // 45 m perpendicular from the road should have meaningful elevation.
    const hRoad = Math.abs(sampleHeightBilinear(t, 0, rz));
    const hFar = Math.abs(sampleHeightBilinear(t, 0, rz + 45));
    expect(hFar).toBeGreaterThan(hRoad + 0.5);
  });
});
