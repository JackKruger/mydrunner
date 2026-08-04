// The maps this build knows about.
//
// Both the server and the client compile the registry in, and the wire
// carries only a map id plus a revision. That is forced rather than
// chosen: the client is served from GitHub Pages and the server from
// Railway, they deploy independently, and the WebSocket cap is 4 KiB
// (server/src/index.ts) against a baked map of ~65 KB. Shipping the
// document in both bundles and comparing revisions is what turns a
// half-finished deploy into a visible error instead of two players
// driving on quietly different ground.
//
// Authored maps are committed as .ts modules rather than .json: Node 22
// ESM needs `with { type: 'json' }` for JSON imports and tsx papers over
// that today, so a JSON registry would break in production only. A .ts
// module also makes a malformed map a `pnpm typecheck` failure. JSON
// stays the editor's import/export interchange format.

import { proceduralDoc } from './applyMapDoc.js';
import { mapDocRev, type MapDoc } from './mapDoc.js';

/** The generated world, with no authored edits. The default, and what
 *  every existing test and screenshot is framed against. */
export const PROCEDURAL_MAP_ID = 'procedural';

/** Authored maps. Add an entry per committed map module:
 *
 *      import { canyon } from './maps/canyon.js';
 *      const AUTHORED: readonly MapDoc[] = [canyon];
 */
const AUTHORED: readonly MapDoc[] = [];

// proceduralDoc() runs the full generator to compute its base checksum,
// which is ~50 ms. Built once on first use rather than at module load so
// importing the registry stays free for callers that never resolve a map.
let proceduralCache: MapDoc | null = null;
function procedural(): MapDoc {
  if (!proceduralCache) proceduralCache = proceduralDoc();
  return proceduralCache;
}

export function getMap(id: string): MapDoc | null {
  if (id === PROCEDURAL_MAP_ID) return procedural();
  return AUTHORED.find((m) => m.id === id) ?? null;
}

export function listMaps(): Array<{ id: string; name: string }> {
  return [
    { id: PROCEDURAL_MAP_ID, name: procedural().name },
    ...AUTHORED.map((m) => ({ id: m.id, name: m.name })),
  ];
}

const revCache = new Map<string, number>();

/** Content revision of a map in THIS build. The server sends its value,
 *  the client compares against its own, and a mismatch means one side is
 *  running a stale bundle. */
export function mapRevOf(id: string): number {
  const cached = revCache.get(id);
  if (cached !== undefined) return cached;
  const doc = getMap(id);
  if (!doc) throw new Error(`unknown map "${id}"`);
  const rev = mapDocRev(doc);
  revCache.set(id, rev);
  return rev;
}
