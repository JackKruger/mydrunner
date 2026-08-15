import { describe, expect, it } from 'vitest';
import { Physics } from '@mydrunner/shared';
import { generateGroundCover } from '../groundCover.js';

function terrain(seed = 41): Physics.TerrainData {
  const n = 9;
  return {
    size: 16, resolution: n, seed,
    heights: new Float32Array(n * n), surfaces: new Uint8Array(n * n).fill(Physics.Surface.Grass),
    ...Physics.dryWater(n), mountain: Physics.mountainFor(16), petrolStation: Physics.petrolStationPadFor(16),
    bogs: [], roads: [],
  };
}

describe('deterministic ground cover placement', () => {
  it('is identical for the same map and changes with map identity', () => {
    expect(generateGroundCover(terrain(), [])).toEqual(generateGroundCover(terrain(), []));
    expect(generateGroundCover(terrain(42), [])).not.toEqual(generateGroundCover(terrain(), []));
  });

  it('excludes forbidden surfaces, water and obstacle radii', () => {
    const t = terrain();
    t.surfaces.fill(Physics.Surface.Road);
    expect(generateGroundCover(t, [])).toEqual([]);
    t.surfaces.fill(Physics.Surface.Grass);
    t.waterLevel.fill(1);
    expect(generateGroundCover(t, [])).toEqual([]);
    Object.assign(t, Physics.dryWater(t.resolution));
    const cover = generateGroundCover(t, []);
    const first = cover[0]!;
    const obstacle = { id: 'shed', kind: 'shed', x: first.x, y: 0, z: first.z, size: 5, height: 4, yaw: 0 } as Physics.Obstacle;
    expect(generateGroundCover(t, [obstacle]).some((p) => Math.hypot(p.x - first.x, p.z - first.z) < 6.75)).toBe(false);
  });

  it('rejects steep cells and applies density independently', () => {
    const t = terrain();
    for (let r = 0; r < t.resolution; r++) for (let c = 0; c < t.resolution; c++) t.heights[r * t.resolution + c] = c * 4;
    expect(generateGroundCover(t, [])).toEqual([]);
    expect(generateGroundCover(terrain(), [], 0)).toEqual([]);
  });
});
