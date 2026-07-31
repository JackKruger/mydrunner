// Golden fingerprint of the shipped world.
//
// production-world.test.ts checks *properties* — spawns land on drivable
// road, the trail grade stays climbable. Those pass happily while the whole
// map shifts half a metre. This test pins the exact bytes.
//
// It exists because authored maps store a height *delta* against this
// generated base. If the base moves, every committed delta silently means
// something different: a plateau carved into a hillside becomes a lump on a
// cliff, and nothing errors.
//
// A FAILURE HERE IS NOT AUTOMATICALLY A BUG. It means the generated world
// changed. Decide whether that was intentional:
//   - Intentional (tuning the mountain, adding a road): update the constants
//     below, then re-bake or rebase every map in shared/src/map/maps that
//     stores a delta against the procedural base.
//   - Unintentional: you changed generation while meaning to change
//     something else. Revert.
//
// Never update these numbers to make the suite green without doing that.

import { describe, it, expect } from 'vitest';
import { generateTerrain } from '../physics/terrain.js';
import { generateObstacles } from '../physics/obstacles.js';
import { landmarksFor } from '../physics/landmarks.js';
import { fnv1aArray, fnv1a32, canonicalStringify } from '../hash.js';
import { TERRAIN } from '../constants.js';

const GOLDEN = {
  size: 320,
  resolution: 128,
  seed: 1337,
  heights: 3865341215,
  surfaces: 2473862129,
  obstacleCount: 986,
  obstacleIds: 1085158518,
  obstaclePoses: 1171975807,
  landmarks: 3460521583,
  roads: 3649874811,
} as const;

const terrain = generateTerrain();

/** Poses are hashed at 4 decimal places rather than raw float bits: the
 *  point is to catch an obstacle that moved, not a last-ulp difference in
 *  how a trig call rounds on a different V8. */
function poseFingerprint(): number {
  return fnv1a32(
    generateObstacles(terrain)
      .map((o) => [o.kind, o.x, o.y, o.z, o.size, o.height, o.yaw]
        .map((v) => (typeof v === 'number' ? v.toFixed(4) : v))
        .join(':'))
      .join('|'),
  );
}

describe('shipped world golden fingerprint', () => {
  it('is generated at the geometry the constants declare', () => {
    expect(terrain.size).toBe(GOLDEN.size);
    expect(terrain.resolution).toBe(GOLDEN.resolution);
    expect(terrain.seed).toBe(GOLDEN.seed);
    // The constants are the production world — Room passes no overrides.
    expect(TERRAIN.defaultSize).toBe(GOLDEN.size);
    expect(TERRAIN.defaultResolution).toBe(GOLDEN.resolution);
    expect(TERRAIN.defaultSeed).toBe(GOLDEN.seed);
  });

  it('has an unchanged heightfield', () => {
    expect(fnv1aArray(terrain.heights)).toBe(GOLDEN.heights);
  });

  it('has an unchanged surface map', () => {
    expect(fnv1aArray(terrain.surfaces)).toBe(GOLDEN.surfaces);
  });

  it('has an unchanged road set', () => {
    expect(fnv1a32(canonicalStringify(terrain.roads))).toBe(GOLDEN.roads);
  });

  it('places the same obstacles, with the same identities', () => {
    const obstacles = generateObstacles(terrain);
    expect(obstacles.length).toBe(GOLDEN.obstacleCount);
    expect(fnv1a32(obstacles.map((o) => o.id).join('|'))).toBe(GOLDEN.obstacleIds);
    expect(poseFingerprint()).toBe(GOLDEN.obstaclePoses);
  });

  it('places the same landmarks', () => {
    expect(fnv1a32(canonicalStringify(landmarksFor(terrain)))).toBe(GOLDEN.landmarks);
  });

  it('regenerates bit-identically', () => {
    const again = generateTerrain();
    expect(fnv1aArray(again.heights)).toBe(GOLDEN.heights);
    expect(fnv1aArray(again.surfaces)).toBe(GOLDEN.surfaces);
  });
});
