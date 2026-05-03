// Verifies the procedural terrain actually returns h=0 on the road core
// where spawns happen.

import { describe, it, expect } from 'vitest';
import { Physics } from '@mydrunner/shared';

describe('terrain at spawn coords', () => {
  it('road core cells have h=0 in the seeded terrain', () => {
    const t = Physics.generateTerrain({ size: 200, resolution: 64, seed: 1337 });
    for (const x of [-14, -10, 0, 10, 14]) {
      for (const z of [-1.2, 0, 1.2]) {
        const idx = Physics.worldToTerrainIndex(t, x, z);
        expect(idx).toBeGreaterThanOrEqual(0);
        const h = t.heights[idx];
        expect(h, `at (${x}, ${z}) idx=${idx}`).toBeCloseTo(0, 5);
      }
    }
  });

  it('ALL road cells (|z| < 5) have h=0', () => {
    const t = Physics.generateTerrain({ size: 200, resolution: 64, seed: 1337 });
    const n = t.resolution;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const z = (r / (n - 1) - 0.5) * t.size;
        if (Math.abs(z) < 5) {
          const h = t.heights[r * n + c];
          expect(h, `at r=${r} c=${c} z=${z}`).toBeCloseTo(0, 5);
        }
      }
    }
  });
});
