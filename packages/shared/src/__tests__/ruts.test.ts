// RutBuffer accumulation + cap.
//
// These exist mainly to pin the ORDER OF MAGNITUDE of RUT_RATE. The
// constant shipped as 0.3035 with the intended 0.0035 stranded in its
// trailing comment — ~87x too fast, which at 60 Hz is 18 m of erosion
// per second. Nothing caught it because RUTS_ENABLED is false, so the
// whole subsystem is unreachable from the room loop. These tests drive
// RutBuffer directly, so they hold regardless of the feature flag.

import { describe, expect, it } from 'vitest';
import { RutBuffer } from '../physics/ruts.js';
import { Surface, mountainFor, petrolStationPadFor, type TerrainData } from '../physics/terrain.js';
import { RUT_MAX_DEPTH } from '../constants.js';

/** Ticks per flush batch. Room used to flush the buffer every 30 ticks
 *  (0.5 s at 60 Hz) and RUT_RATE was tuned against that cadence, so the
 *  rate-vs-cap assertion below is only meaningful in those units. It
 *  lives here rather than in constants.ts because nothing schedules a
 *  flush any more - whoever re-wires ruts picks the cadence, and will
 *  need to re-check this test against it. */
const FLUSH_INTERVAL_TICKS = 30;

function makeMudTerrain(): TerrainData {
  const n = 32;
  const size = 200;
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(Surface.Mud);
  return {
    size,
    resolution: n,
    heights: new Float32Array(n * n),
    surfaces,
    seed: 0,
    mountain: mountainFor(size),
    petrolStation: petrolStationPadFor(size),
    bogs: [],
    roads: [],
  };
}

describe('RutBuffer', () => {
  it('carves a fraction of the depth cap over one flush interval at full slip', () => {
    const terrain = makeMudTerrain();
    const buf = new RutBuffer(terrain);
    for (let i = 0; i < FLUSH_INTERVAL_TICKS; i++) {
      buf.recordWheel(0, 0, 1, true);
    }
    const deltas = buf.flush();
    expect(deltas).toHaveLength(1);
    // Rate-vs-cap is the invariant that matters: one flush interval
    // (~0.5 s of a wheel sitting still at full slip) should be a bite out
    // of the rut, not the whole thing. At the bad constant a single flush
    // was 9.1 m — 15x the cap — so the "gradual erosion" the buffer is
    // built around collapsed into one instant trench.
    expect(deltas[0]!.dy).toBeGreaterThan(0);
    expect(deltas[0]!.dy).toBeLessThan(RUT_MAX_DEPTH / 4);
  });

  it('caps total erosion per cell at RUT_MAX_DEPTH', () => {
    const terrain = makeMudTerrain();
    const buf = new RutBuffer(terrain);
    const startH = 0; // makeMudTerrain starts flat
    // Hammer one cell far past the cap.
    for (let batch = 0; batch < 400; batch++) {
      for (let i = 0; i < FLUSH_INTERVAL_TICKS; i++) {
        buf.recordWheel(0, 0, 1, true);
      }
      buf.flush();
    }
    const idx = terrain.heights.findIndex((h) => h < startH - 1e-6);
    expect(idx).toBeGreaterThanOrEqual(0);
    const sunk = startH - terrain.heights[idx]!;
    expect(sunk).toBeLessThanOrEqual(RUT_MAX_DEPTH + 1e-6);
    expect(sunk).toBeCloseTo(RUT_MAX_DEPTH, 3);
  });

  it('ignores wheels that are not in contact and non-mud cells', () => {
    const terrain = makeMudTerrain();
    terrain.surfaces.fill(Surface.Road);
    const buf = new RutBuffer(terrain);
    buf.recordWheel(0, 0, 1, true);
    expect(buf.flush()).toHaveLength(0);

    terrain.surfaces.fill(Surface.Mud);
    buf.recordWheel(0, 0, 1, false);
    expect(buf.flush()).toHaveLength(0);
  });
});
