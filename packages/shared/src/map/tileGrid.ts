// Sparse tile encoding for the two full-grid arrays a map document
// carries: the height delta and the surface override.
//
// Why sparse tiles rather than one base64 blob per grid: at 128x128 a
// dense int16 delta is ~43 KB of base64 on a single line, rewritten in
// full every save. Sculpting one hillside touches maybe a fifth of the
// map, so storing only the 16x16 tiles that differ from the default cuts
// a typical map to ~10 KB AND makes the git diff local to the edit
// instead of one churning megaline.
//
// Why one codec for both arrays rather than base64-int16 for heights and
// run-length for surfaces: two codecs is two sets of edge cases (empty,
// all-default, all-dirty, partial trailing tile) for one concept.

/** Tile side length in cells. 16 gives 8x8 = 64 tiles at the shipped
 *  resolution of 128 — fine enough that a brush stroke dirties a handful,
 *  coarse enough that the per-tile overhead stays negligible. */
export const TILE = 16;

export interface TileGrid {
  /** Grid side in cells. Decoders check this against the map's
   *  resolution rather than trusting the array length. */
  n: number;
  /** Tile side in cells. Stored so a future change to TILE does not
   *  silently misread existing maps. */
  tile: number;
  /** Only the tiles that differ from the default value. */
  cells: TileEntry[];
}

export interface TileEntry {
  /** Tile index, row-major: tileRow * tilesPerSide + tileCol. */
  i: number;
  /** Base64 of the tile's raw little-endian bytes. */
  b: string;
}

export function tilesPerSide(n: number, tile: number = TILE): number {
  return Math.ceil(n / tile);
}

export function encodeInt16Grid(data: Int16Array, n: number, fill = 0): TileGrid {
  return encodeGrid(data, n, fill, 2, (buf) => new Int16Array(buf));
}

export function decodeInt16Grid(grid: TileGrid, fill = 0): Int16Array {
  return decodeGrid(grid, fill, 2, (n) => new Int16Array(n)) as Int16Array;
}

export function encodeUint8Grid(data: Uint8Array, n: number, fill = 0xff): TileGrid {
  return encodeGrid(data, n, fill, 1, (buf) => new Uint8Array(buf));
}

export function decodeUint8Grid(grid: TileGrid, fill = 0xff): Uint8Array {
  return decodeGrid(grid, fill, 1, (n) => new Uint8Array(n)) as Uint8Array;
}

type Arr = Int16Array | Uint8Array;

function encodeGrid(
  data: Arr,
  n: number,
  fill: number,
  bytesPer: number,
  make: (buf: ArrayBuffer) => Arr,
): TileGrid {
  if (data.length !== n * n) {
    throw new Error(`tileGrid: expected ${n * n} cells, got ${data.length}`);
  }
  const per = tilesPerSide(n);
  const cells: TileEntry[] = [];
  for (let tr = 0; tr < per; tr++) {
    for (let tc = 0; tc < per; tc++) {
      const tile = make(new ArrayBuffer(TILE * TILE * bytesPer));
      let dirty = false;
      for (let r = 0; r < TILE; r++) {
        const gr = tr * TILE + r;
        for (let c = 0; c < TILE; c++) {
          const gc = tc * TILE + c;
          // Cells past the grid edge (n not a multiple of TILE) stay at
          // fill so they never mark a tile dirty on their own.
          const v = gr < n && gc < n ? data[gr * n + gc]! : fill;
          tile[r * TILE + c] = v;
          if (v !== fill) dirty = true;
        }
      }
      if (dirty) {
        cells.push({ i: tr * per + tc, b: bytesToBase64(asBytes(tile)) });
      }
    }
  }
  return { n, tile: TILE, cells };
}

function decodeGrid(
  grid: TileGrid,
  fill: number,
  bytesPer: number,
  alloc: (n: number) => Arr,
): Arr {
  const { n, tile } = grid;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`tileGrid: bad n ${n}`);
  if (tile !== TILE) {
    throw new Error(`tileGrid: tile size ${tile} but this build uses ${TILE}`);
  }
  const out = alloc(n * n);
  if (fill !== 0) out.fill(fill);

  const per = tilesPerSide(n);
  for (const entry of grid.cells) {
    if (!Number.isInteger(entry.i) || entry.i < 0 || entry.i >= per * per) {
      throw new Error(`tileGrid: tile index ${entry.i} out of range`);
    }
    const bytes = base64ToBytes(entry.b);
    if (bytes.length !== TILE * TILE * bytesPer) {
      throw new Error(
        `tileGrid: tile ${entry.i} has ${bytes.length} bytes, expected ${TILE * TILE * bytesPer}`,
      );
    }
    // Copy rather than view: base64ToBytes may return a buffer whose
    // offset is not aligned for Int16Array.
    const view = alloc(TILE * TILE);
    new Uint8Array(view.buffer).set(bytes);

    const tr = Math.floor(entry.i / per);
    const tc = entry.i % per;
    for (let r = 0; r < TILE; r++) {
      const gr = tr * TILE + r;
      if (gr >= n) break;
      for (let c = 0; c < TILE; c++) {
        const gc = tc * TILE + c;
        if (gc >= n) break;
        out[gr * n + gc] = view[r * TILE + c]!;
      }
    }
  }
  return out;
}

function asBytes(arr: Arr): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

// btoa/atob rather than Buffer (absent in the browser) or
// Uint8Array.toBase64 (not available across our Node and browser targets).
function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  // Chunked so a large tile can't blow the argument limit on apply.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
