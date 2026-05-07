// Verifies the procedural terrain actually returns h=0 on the road core
// where spawns happen.

import { describe, it, expect } from 'vitest';
import { Physics, TERRAIN } from '@mydrunner/shared';

describe('terrain at spawn coords', () => {
  it('road core cells have h=0 in the seeded terrain', () => {
    const t = Physics.generateTerrain({ size: 200, resolution: 64, seed: 1337 });
    const rz = TERRAIN.roadZ;
    for (const x of [-14, -10, 0, 10, 14]) {
      for (const dz of [-1.2, 0, 1.2]) {
        const z = rz + dz;
        const idx = Physics.worldToTerrainIndex(t, x, z);
        expect(idx).toBeGreaterThanOrEqual(0);
        const h = t.heights[idx];
        expect(h, `at (${x}, ${z}) idx=${idx}`).toBeCloseTo(0, 5);
      }
    }
  });

  it('ALL spawn-corridor road cells (x < 30, |z - roadZ| < 5) have h=0', () => {
    // Bounded to x < 30 to stay clear of the diagonal mountain trail
    // (starts ~x=39). Inside this corridor the defaultRoad is the closest
    // road, so the universal flatness check still holds.
    const t = Physics.generateTerrain({ size: 200, resolution: 64, seed: 1337 });
    const n = t.resolution;
    const rz = TERRAIN.roadZ;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = (c / (n - 1) - 0.5) * t.size;
        const z = (r / (n - 1) - 0.5) * t.size;
        if (x > 30) continue;
        if (Math.abs(z - rz) < 5) {
          const h = t.heights[r * n + c];
          expect(h, `at r=${r} c=${c} x=${x} z=${z}`).toBeCloseTo(0, 5);
        }
      }
    }
  });
});
