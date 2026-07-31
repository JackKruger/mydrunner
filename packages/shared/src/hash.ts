// FNV-1a, 32-bit. Not a cryptographic hash — it is a content fingerprint
// for two jobs: pinning the generated world in tests, and giving a map
// document a revision number the client and server can compare.
//
// Chosen over a rolling sum or JSON.stringify comparison because it is
// order-sensitive, avalanches on a one-bit change, and produces a number
// small enough to put on the wire and read in a test failure.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Continue a hash over raw bytes. Pass the previous result as `seed` to
 *  chain several buffers into one fingerprint. */
export function fnv1aBytes(bytes: Uint8Array, seed: number = FNV_OFFSET): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

export function fnv1a32(str: string, seed: number = FNV_OFFSET): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    // Hash UTF-16 code units as two bytes so the result is independent of
    // the platform's string encoding.
    const c = str.charCodeAt(i);
    h ^= c & 0xff;
    h = Math.imul(h, FNV_PRIME);
    h ^= (c >>> 8) & 0xff;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/** Fingerprint a typed array by its bytes.
 *
 *  Float32Array is hashed exactly, bit for bit — that is the point when
 *  pinning a heightfield, but it also means a hash mismatch can come from
 *  a last-ulp difference rather than a visible change. Test failures
 *  should be read as "the world moved, go look at it", not "someone broke
 *  the build". */
export function fnv1aArray(
  arr: Float32Array | Uint8Array | Int16Array | Int32Array,
  seed: number = FNV_OFFSET,
): number {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return fnv1aBytes(bytes, seed);
}

/** JSON with recursively sorted object keys.
 *
 *  Map revisions must track content, not formatting: a hand-edit that
 *  reorders fields, or a different key insertion order between the editor
 *  and a committed file, must not read as a different map. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (src[key] === undefined) continue; // JSON drops these anyway; be explicit
    out[key] = canonicalise(src[key]);
  }
  return out;
}
