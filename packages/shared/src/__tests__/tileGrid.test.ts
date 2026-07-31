// The tile codec is the only lossy-looking step between what an author
// sculpts and what ships, so it gets the edge cases: empty, all-default,
// all-dirty, negative values, a grid whose side is not a multiple of the
// tile, and a corrupt document.

import { describe, it, expect } from 'vitest';
import {
  TILE, tilesPerSide,
  encodeInt16Grid, decodeInt16Grid,
  encodeUint8Grid, decodeUint8Grid,
} from '../map/tileGrid.js';

const N = 128;

function roundTripI16(data: Int16Array, n = N): Int16Array {
  return decodeInt16Grid(encodeInt16Grid(data, n));
}

describe('int16 tile grid', () => {
  it('stores nothing when every cell is the default', () => {
    const grid = encodeInt16Grid(new Int16Array(N * N), N);
    expect(grid.cells).toEqual([]);
    expect(grid.n).toBe(N);
    expect(grid.tile).toBe(TILE);
    expect(Array.from(decodeInt16Grid(grid))).toEqual(Array.from(new Int16Array(N * N)));
  });

  it('round-trips a single edited cell and stores exactly one tile', () => {
    const data = new Int16Array(N * N);
    data[70 * N + 33] = 250;
    const grid = encodeInt16Grid(data, N);
    expect(grid.cells).toHaveLength(1);
    expect(Array.from(roundTripI16(data))).toEqual(Array.from(data));
  });

  it('round-trips negative values (cut, not fill)', () => {
    const data = new Int16Array(N * N);
    data[10 * N + 10] = -1234;
    data[10 * N + 11] = -32768;
    data[10 * N + 12] = 32767;
    expect(Array.from(roundTripI16(data))).toEqual(Array.from(data));
  });

  it('round-trips a fully dirty grid', () => {
    const data = new Int16Array(N * N);
    for (let i = 0; i < data.length; i++) data[i] = ((i * 37) % 2000) - 1000;
    const grid = encodeInt16Grid(data, N);
    expect(grid.cells).toHaveLength(tilesPerSide(N) ** 2);
    expect(Array.from(decodeInt16Grid(grid))).toEqual(Array.from(data));
  });

  it('only stores the tiles a localised edit touched', () => {
    const data = new Int16Array(N * N);
    // A blob wholly inside one 16x16 tile.
    for (let r = 32; r < 40; r++) for (let c = 32; c < 40; c++) data[r * N + c] = 100;
    expect(encodeInt16Grid(data, N).cells).toHaveLength(1);
  });

  it('handles a grid whose side is not a multiple of the tile', () => {
    const n = 20; // 2x2 tiles, trailing 4 cells
    const data = new Int16Array(n * n);
    data[19 * n + 19] = 77; // last cell, in the partial corner tile
    const grid = encodeInt16Grid(data, n);
    expect(decodeInt16Grid(grid)[19 * n + 19]).toBe(77);
    expect(Array.from(decodeInt16Grid(grid))).toEqual(Array.from(data));
  });

  it('rejects a data array of the wrong length', () => {
    expect(() => encodeInt16Grid(new Int16Array(10), N)).toThrow(/expected/);
  });

  it('rejects a tile size this build cannot read', () => {
    const grid = encodeInt16Grid(new Int16Array(N * N), N);
    expect(() => decodeInt16Grid({ ...grid, tile: 8 })).toThrow(/tile size/);
  });

  it('rejects an out-of-range tile index', () => {
    const data = new Int16Array(N * N);
    data[0] = 5;
    const grid = encodeInt16Grid(data, N);
    grid.cells[0]!.i = 9999;
    expect(() => decodeInt16Grid(grid)).toThrow(/out of range/);
  });

  it('rejects a truncated tile payload', () => {
    const data = new Int16Array(N * N);
    data[0] = 5;
    const grid = encodeInt16Grid(data, N);
    grid.cells[0]!.b = btoa('short');
    expect(() => decodeInt16Grid(grid)).toThrow(/bytes, expected/);
  });
});

describe('uint8 tile grid', () => {
  // 0xFF means "no override" — the default must be absent, not zero,
  // because 0 is a real surface id (Road).
  it('treats 0xFF as the default and stores nothing for an untouched grid', () => {
    const data = new Uint8Array(N * N).fill(0xff);
    expect(encodeUint8Grid(data, N).cells).toEqual([]);
  });

  it('decodes an empty grid back to all-0xFF', () => {
    const grid = encodeUint8Grid(new Uint8Array(N * N).fill(0xff), N);
    const out = decodeUint8Grid(grid);
    expect(out).toHaveLength(N * N);
    expect(out.every((v) => v === 0xff)).toBe(true);
  });

  it('round-trips surface id 0, which is a real surface and not the default', () => {
    const data = new Uint8Array(N * N).fill(0xff);
    data[5 * N + 5] = 0; // Road
    const out = decodeUint8Grid(encodeUint8Grid(data, N));
    expect(out[5 * N + 5]).toBe(0);
    expect(out[5 * N + 6]).toBe(0xff);
  });

  it('round-trips a painted patch', () => {
    const data = new Uint8Array(N * N).fill(0xff);
    for (let r = 60; r < 75; r++) for (let c = 20; c < 44; c++) data[r * N + c] = 2;
    expect(Array.from(decodeUint8Grid(encodeUint8Grid(data, N)))).toEqual(Array.from(data));
  });
});

describe('encoded size', () => {
  it('keeps a typical localised sculpt well under a dense encoding', () => {
    const data = new Int16Array(N * N);
    // ~15% of the map, as a contiguous region.
    for (let r = 40; r < 90; r++) for (let c = 40; c < 90; c++) data[r * N + c] = 300;
    const json = JSON.stringify(encodeInt16Grid(data, N));
    const dense = Math.ceil((N * N * 2) / 3) * 4; // base64 of the whole grid
    expect(json.length).toBeLessThan(dense * 0.6);
  });
});
