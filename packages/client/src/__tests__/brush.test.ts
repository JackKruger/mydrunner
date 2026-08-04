// Brush geometry. A half-cell error here reads as "the brush paints off
// to one side of the cursor", which is easy to see and hard to diagnose
// from the rendered result, so the mapping is pinned directly.

import { describe, expect, it } from 'vitest';
import {
  brushRect, brushWeight, cellCenter, cellPitch, forEachBrushCell,
} from '../editor/brush.js';

const G = { size: 320, resolution: 128 };

describe('cell centres', () => {
  it('put cell 0 on the -size/2 edge and the last cell on +size/2', () => {
    expect(cellCenter(G, 0)).toBeCloseTo(-160, 6);
    expect(cellCenter(G, 127)).toBeCloseTo(160, 6);
  });

  it('agree with the sampler the physics uses', () => {
    // worldToTerrainIndex maps world -> cell; cellCenter must be its
    // inverse or strokes land in a different cell than they highlight.
    for (const c of [0, 1, 63, 100, 127]) {
      const x = cellCenter(G, c);
      const u = (x / G.size + 0.5) * (G.resolution - 1);
      expect(Math.round(u)).toBe(c);
    }
  });

  it('report the pitch between adjacent cells', () => {
    expect(cellPitch(G)).toBeCloseTo(320 / 127, 6);
  });
});

describe('brushRect', () => {
  it('covers the brush and stays inside the grid', () => {
    const rect = brushRect(G, 0, 0, 10);
    expect(rect.r0).toBeGreaterThanOrEqual(0);
    expect(rect.c0).toBeGreaterThanOrEqual(0);
    expect(rect.r0 + rect.rows).toBeLessThanOrEqual(G.resolution);
    expect(rect.c0 + rect.cols).toBeLessThanOrEqual(G.resolution);
    // A 10 m radius at ~2.5 m pitch is 4 cells each way, plus the centre.
    expect(rect.rows).toBeGreaterThanOrEqual(8);
  });

  it('clamps at the map corner instead of going negative', () => {
    const rect = brushRect(G, -160, -160, 20);
    expect(rect.r0).toBe(0);
    expect(rect.c0).toBe(0);
    expect(rect.rows).toBeGreaterThan(0);
  });

  it('is empty when the brush is entirely off the map', () => {
    expect(brushRect(G, 5000, 5000, 5).rows).toBe(0);
  });
});

describe('brushWeight', () => {
  it('is 1 at the centre and 0 at the rim', () => {
    expect(brushWeight(0, 10, 0)).toBe(1);
    expect(brushWeight(10, 10, 0)).toBe(0);
    expect(brushWeight(11, 10, 0)).toBe(0);
  });

  it('holds full strength inside the hard core', () => {
    expect(brushWeight(4, 10, 0.5)).toBe(1);
    expect(brushWeight(6, 10, 0.5)).toBeLessThan(1);
  });

  it('falls off monotonically', () => {
    let prev = Infinity;
    for (let d = 0; d <= 10; d += 0.5) {
      const w = brushWeight(d, 10, 0.2);
      expect(w).toBeLessThanOrEqual(prev + 1e-9);
      prev = w;
    }
  });

  it('never returns a negative weight for a zero radius', () => {
    expect(brushWeight(0, 0, 1)).toBe(0);
  });
});

describe('forEachBrushCell', () => {
  it('visits cells centred on the cursor', () => {
    const seen: number[] = [];
    forEachBrushCell(G, 0, 0, 6, 1, ({ index }) => seen.push(index));
    const n = G.resolution;
    // (0,0) in world is the grid centre: u = v = 63.5, so the four cells
    // around 63/64 are all within a 6 m brush.
    for (const [r, c] of [[63, 63], [63, 64], [64, 63], [64, 64]]) {
      expect(seen).toContain(r! * n + c!);
    }
  });

  it('visits nothing off the map', () => {
    let count = 0;
    forEachBrushCell(G, 900, 0, 5, 1, () => count++);
    expect(count).toBe(0);
  });

  it('returns a rect containing every cell it visited', () => {
    const cells: { r: number; c: number }[] = [];
    const rect = forEachBrushCell(G, 40, -20, 12, 0.3, ({ r, c }) => cells.push({ r, c }));
    expect(cells.length).toBeGreaterThan(0);
    for (const { r, c } of cells) {
      expect(r).toBeGreaterThanOrEqual(rect.r0);
      expect(r).toBeLessThan(rect.r0 + rect.rows);
      expect(c).toBeGreaterThanOrEqual(rect.c0);
      expect(c).toBeLessThan(rect.c0 + rect.cols);
    }
  });
});
