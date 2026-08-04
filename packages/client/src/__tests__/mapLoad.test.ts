// The client must refuse a map it cannot reproduce.
//
// Accepting one is the quiet failure this whole check exists for: the
// game connects, renders, drives, and only the physics disagrees. These
// assert the refusal happens and that the reason names both revisions,
// because "one side is stale" is useless to whoever has to decide which
// deploy to re-run.

import { describe, expect, it } from 'vitest';
import { Maps } from '@mydrunner/shared';
import { resolveHandshakeMap } from '../mapLoad.js';

const PROCEDURAL = Maps.PROCEDURAL_MAP_ID;

describe('resolveHandshakeMap', () => {
  it('accepts a map this build has at the same revision', () => {
    const res = resolveHandshakeMap({ id: PROCEDURAL, rev: Maps.mapRevOf(PROCEDURAL) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.doc.id).toBe(PROCEDURAL);
  });

  it('refuses a map id this build does not have', () => {
    const res = resolveHandshakeMap({ id: 'canyon', rev: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('canyon');
  });

  it('refuses a matching id at a different revision', () => {
    const localRev = Maps.mapRevOf(PROCEDURAL);
    const res = resolveHandshakeMap({ id: PROCEDURAL, rev: localRev + 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain(String(localRev));
      expect(res.reason).toContain(String(localRev + 1));
    }
  });

  it('is not fooled by a revision of 0', () => {
    // A server that failed to compute a rev would send 0, and a truthy
    // check would wave it through onto whatever this build happens to
    // hold.
    const res = resolveHandshakeMap({ id: PROCEDURAL, rev: 0 });
    expect(res.ok).toBe(false);
  });
});
