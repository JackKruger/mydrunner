// Dirty-rect bookkeeping for editor brushes. A rect that is too small
// leaves stale geometry on screen; one that is too large is only slow.
// These helpers exist so the "too small" case is a shared, tested
// definition rather than per-tool index arithmetic.

import { describe, it, expect } from 'vitest';
import { fullGridRect, unionGridRect, type GridRect } from '../physics/terrain.js';

describe('fullGridRect', () => {
  it('covers every cell', () => {
    expect(fullGridRect({ resolution: 128 })).toEqual({ r0: 0, c0: 0, rows: 128, cols: 128 });
  });
});

describe('unionGridRect', () => {
  it('covers both inputs', () => {
    const a: GridRect = { r0: 2, c0: 3, rows: 4, cols: 5 };
    const b: GridRect = { r0: 10, c0: 1, rows: 2, cols: 2 };
    expect(unionGridRect(a, b)).toEqual({ r0: 2, c0: 1, rows: 10, cols: 7 });
  });

  it('is commutative', () => {
    const a: GridRect = { r0: 5, c0: 5, rows: 3, cols: 3 };
    const b: GridRect = { r0: 0, c0: 9, rows: 1, cols: 1 };
    expect(unionGridRect(a, b)).toEqual(unionGridRect(b, a));
  });

  it('absorbs a contained rect without growing', () => {
    const outer: GridRect = { r0: 0, c0: 0, rows: 20, cols: 20 };
    const inner: GridRect = { r0: 5, c0: 5, rows: 2, cols: 2 };
    expect(unionGridRect(outer, inner)).toEqual(outer);
  });

  it('is idempotent', () => {
    const a: GridRect = { r0: 7, c0: 8, rows: 2, cols: 9 };
    expect(unionGridRect(a, a)).toEqual(a);
  });

  // A stroke unions one rect per pointermove; the running union must stay
  // correct however the moves are grouped.
  it('is associative across a stroke', () => {
    const moves: GridRect[] = [
      { r0: 10, c0: 10, rows: 4, cols: 4 },
      { r0: 12, c0: 8, rows: 4, cols: 4 },
      { r0: 3, c0: 20, rows: 2, cols: 6 },
    ];
    const left = moves.reduce((acc, m) => unionGridRect(acc, m));
    const right = unionGridRect(moves[0]!, unionGridRect(moves[1]!, moves[2]!));
    expect(left).toEqual(right);
    expect(left).toEqual({ r0: 3, c0: 8, rows: 13, cols: 18 });
  });
});
