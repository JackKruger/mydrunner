// The editor→game handoff. Every failure path here is one where the user
// clicks Preview and gets a blank page, so they all need to end in a
// readable message rather than a throw out of a click handler.

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { Maps, Physics } from '@mydrunner/shared';
import {
  PREVIEW_KEY, clearPreview, readPreview, writePreview,
} from '../previewHandoff.js';

let doc: Maps.MapDoc;

beforeAll(async () => {
  await Physics.initRapier();
  doc = Maps.proceduralDoc();
});

beforeEach(() => {
  sessionStorage.clear();
});

describe('preview handoff', () => {
  it('round-trips a document and the car kind', () => {
    expect(writePreview(doc, 'stockman-dual')).toEqual({ ok: true });
    const got = readPreview();
    expect(got).not.toBeNull();
    expect(got!.carKind).toBe('stockman-dual');
    expect(got!.doc.id).toBe(doc.id);
    // Revision equality is the real check: it hashes the whole document,
    // so a field lost in transit shows up here and nowhere else.
    expect(Maps.mapDocRev(got!.doc)).toBe(Maps.mapDocRev(doc));
  });

  it('survives a baked document, which is what the editor actually sends', () => {
    const baked: Maps.MapDoc = { ...doc, bake: undefined };
    expect(writePreview(baked, 'ridgeback').ok).toBe(true);
    expect(readPreview()!.doc.id).toBe(doc.id);
  });

  it('reads null on an ordinary visit', () => {
    expect(readPreview()).toBeNull();
  });

  // Deliberate: reloading the preview tab has to keep working. The entry
  // dies with the tab anyway, because it is sessionStorage.
  it('does not consume the entry on read', () => {
    writePreview(doc, 'ridgeback');
    expect(readPreview()).not.toBeNull();
    expect(readPreview()).not.toBeNull();
    clearPreview();
    expect(readPreview()).toBeNull();
  });

  it('reads null rather than throwing on garbage', () => {
    sessionStorage.setItem(PREVIEW_KEY, 'not json at all');
    expect(readPreview()).toBeNull();
  });

  it('reads null on an envelope from another version', () => {
    sessionStorage.setItem(PREVIEW_KEY, JSON.stringify({ v: 99, carKind: 'patrol', doc }));
    expect(readPreview()).toBeNull();
  });

  // Storage is user-editable, so the document goes through the same strict
  // decoder a picked file does — a malformed map must fail here, not build
  // a world full of NaN.
  it('reads null on a document the decoder rejects', () => {
    sessionStorage.setItem(PREVIEW_KEY, JSON.stringify({
      v: 1, carKind: 'patrol', doc: { ...doc, base: { seed: 'nope' } },
    }));
    expect(readPreview()).toBeNull();
  });

  it('falls back to a known car kind rather than trusting the envelope', () => {
    writePreview(doc, 'ridgeback');
    const raw = JSON.parse(sessionStorage.getItem(PREVIEW_KEY)!);
    raw.carKind = 'monstertruck';
    sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(raw));
    expect(readPreview()!.carKind).toBe('ridgeback');
  });
});
