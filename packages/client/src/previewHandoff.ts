// Handing the map you're editing to the game page.
//
// The editor holds a document in memory; the game page needs one to build a
// world from. They are separate pages, and the document cannot travel via
// the server — it is ~65 KB baked against a 4 KiB WebSocket payload cap,
// and the whole point is to drive a map that was never committed to the
// registry anyway.
//
// sessionStorage rather than localStorage: a tab opened with window.open
// inherits a copy of its opener's sessionStorage, so the handoff arrives
// scoped to the editor tab that started it and two editors previewing at
// once cannot clobber each other. That inheritance is the mechanism, and it
// is also the trap — a window.open with `noopener` gets a *blank*
// sessionStorage, so the editor must not pass it.
//
// The read side runs the same strict decoder a picked file goes through.
// Storage is user-editable and a stale envelope from an older format
// version has to fail readably rather than build a world full of NaN.

import { Maps, normalizeVehicleBaseId, type VehicleBaseId } from '@mydrunner/shared';

export const PREVIEW_KEY = 'mydrunner:preview';

/** Envelope version, bumped if this wrapper's shape changes. Independent
 *  of MAP_FORMAT_VERSION, which guards the document inside it. */
const ENVELOPE_VERSION = 1;

/** sessionStorage is around 5 MB and a baked document is ~65 KB, so this is
 *  not a budget so much as a guarantee that a click handler never eats a
 *  QuotaExceededError with nowhere to report it. */
export const PREVIEW_MAX_BYTES = 4_000_000;

export interface PreviewPayload {
  doc: Maps.MapDoc;
  carKind: VehicleBaseId;
}

export type PreviewWriteResult = { ok: true } | { ok: false; reason: string };

export function writePreview(doc: Maps.MapDoc, carKind: VehicleBaseId): PreviewWriteResult {
  let text: string;
  try {
    text = JSON.stringify({ v: ENVELOPE_VERSION, carKind, doc: JSON.parse(Maps.encodeMapDoc(doc)) });
  } catch (err) {
    return { ok: false, reason: `could not serialise the map: ${(err as Error).message}` };
  }
  if (text.length > PREVIEW_MAX_BYTES) {
    return { ok: false, reason: `map is ${(text.length / 1e6).toFixed(1)} MB, too big to hand over` };
  }
  try {
    sessionStorage.setItem(PREVIEW_KEY, text);
  } catch (err) {
    return { ok: false, reason: `browser refused to store the map: ${(err as Error).message}` };
  }
  return { ok: true };
}

/** The map the editor handed over, or null if this is an ordinary visit.
 *
 *  Deliberately does NOT clear the key: reloading the preview tab has to
 *  keep working, and the tab's sessionStorage dies with the tab anyway. */
export function readPreview(): PreviewPayload | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(PREVIEW_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as { v?: unknown; carKind?: unknown; doc?: unknown };
    if (env.v !== ENVELOPE_VERSION) return null;
    return {
      doc: Maps.decodeMapDoc(env.doc),
      carKind: normalizeVehicleBaseId(env.carKind),
    };
  } catch {
    return null;
  }
}

export function clearPreview(): void {
  try {
    sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    // Nothing to do — the tab is closing or storage is blocked.
  }
}
