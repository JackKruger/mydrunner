// decodeClient is the trust boundary for everything a client can send.
// Wrong-shaped-but-valid msgpack must throw (the server catches and drops)
// rather than escape as a TypeError later — an uncaught throw in the ws
// message handler would crash the whole room.

import { describe, expect, it } from 'vitest';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import {
  CHAT_MAX_LEN,
  NAME_MAX_LEN,
  SNAPSHOT_SCHEMA,
  decodeClient,
  decodeServer,
  encode,
} from '../net/messages.js';
import { PROTOCOL_VERSION } from '../constants.js';
import type { VehicleState } from '../types.js';

const raw = (obj: unknown): Uint8Array => msgpackEncode(obj);

const vehicle: VehicleState = {
  position: { x: 1.234, y: 2, z: -3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  linVel: { x: 4, y: 0, z: 1 },
  angVel: { x: 0, y: 0.2, z: 0 },
  rpm: 900,
  gear: 2,
  throttle: 0.5,
  wheels: Array.from({ length: 4 }, () => ({
    steer: 0,
    spin: 0,
    contact: true,
    suspensionLength: 0.3,
    angVel: 0,
  })),
  axles: [
    { rideY: 0, rollAngle: 0 },
    { rideY: 0, rollAngle: 0 },
  ],
};

describe('decodeClient validation', () => {
  it('round-trips a valid hello', () => {
    const msg = decodeClient(
      encode({ t: 'hello', name: 'jack', carKind: 'hilux', v: PROTOCOL_VERSION }),
    );
    expect(msg).toEqual({ t: 'hello', name: 'jack', carKind: 'hilux', v: PROTOCOL_VERSION });
  });

  it('reports a missing or malformed hello version as 0 rather than throwing', () => {
    // A build from before the handshake existed sends no `v`. It must
    // still decode: the server needs a well-formed message to answer with
    // a `bye` explaining the mismatch. Throwing here would drop the
    // message and leave that client connected to nothing.
    for (const hello of [
      { t: 'hello', name: 'jack' },
      { t: 'hello', name: 'jack', v: 'two' },
      { t: 'hello', name: 'jack', v: 1.5 },
    ]) {
      const msg = decodeClient(raw(hello));
      if (msg.t !== 'hello') throw new Error('expected hello');
      expect(msg.v).toBe(0);
    }
  });

  it('round-trips a valid quantized owner state', () => {
    const msg = decodeClient(encode({ t: 'state', update: { seq: 42, vehicle } }));
    if (msg.t !== 'state') throw new Error('expected state');
    expect(msg.update.seq).toBe(42);
    expect(msg.update.vehicle.position.x).toBeCloseTo(1.23, 2);
  });

  it('rejects hello with a non-string name', () => {
    expect(() => decodeClient(raw({ t: 'hello', name: 42 }))).toThrow();
    expect(() => decodeClient(raw({ t: 'hello' }))).toThrow();
  });

  it('rejects chat with a non-string text', () => {
    expect(() => decodeClient(raw({ t: 'chat', text: { a: 1 } }))).toThrow();
  });

  it('rejects owner state with non-finite tuple fields', () => {
    const packed = msgpackDecode(encode({ t: 'state', update: { seq: 1, vehicle } })) as Record<string, unknown>;
    const tuple = [...(packed.V as number[])];
    tuple[0] = NaN;
    expect(() => decodeClient(raw({ ...packed, V: tuple }))).toThrow();
    tuple[0] = Infinity;
    expect(() => decodeClient(raw({ ...packed, V: tuple }))).toThrow();
  });

  it('rejects owner state with a missing or non-integer sequence', () => {
    const packed = msgpackDecode(encode({ t: 'state', update: { seq: 1, vehicle } })) as Record<string, unknown>;
    expect(() => decodeClient(raw({ ...packed, Q: undefined }))).toThrow();
    expect(() => decodeClient(raw({ ...packed, Q: 1.5 }))).toThrow();
    expect(() => decodeClient(raw({ ...packed, Q: '9' }))).toThrow();
  });

  it('rejects malformed state payloads and unknown message types', () => {
    expect(() => decodeClient(raw({ t: 'state', s: SNAPSHOT_SCHEMA, Q: 1 }))).toThrow();
    expect(() => decodeClient(raw({ t: 'state', s: SNAPSHOT_SCHEMA + 1, Q: 1, V: [] }))).toThrow();
    expect(() => decodeClient(raw({ t: 'nope' }))).toThrow();
    expect(() => decodeClient(raw('just a string'))).toThrow();
  });
});

// The per-player snapshot tuple is decoded BY POSITION, so a decoder that
// doesn't know the schema it's reading won't fail - it reads every field
// as whatever now sits at that index and drives the truck from garbage.
describe('decodeServer schema guard', () => {
  const snap = {
    tick: 7,
    serverTimeMs: 1234,
    players: [
      {
        id: 'p1',
        name: 'jack',
        carKind: 'patrol' as const,
        stateSeq: 3,
        vehicle,
      },
    ],
  };

  it('round-trips a snapshot at the current schema', () => {
    const out = decodeServer(encode({ t: 'snapshot', snap }));
    if (out.t !== 'snapshot') throw new Error('expected snapshot');
    expect(out.snap.tick).toBe(7);
    expect(out.snap.players[0]!.vehicle.position.x).toBeCloseTo(vehicle.position.x, 2);
  });

  it('rejects a snapshot from an unknown schema version', () => {
    const packed = msgpackEncode({ t: 'snapshot', s: SNAPSHOT_SCHEMA + 1, T: 1, M: 1, P: [[]] });
    expect(() => decodeServer(packed)).toThrow(/schema/);
    const legacy = msgpackEncode({ t: 'snapshot', T: 1, M: 1, P: [[]] });
    expect(() => decodeServer(legacy)).toThrow(/schema/);
  });
});

// Names used to skip sanitisation entirely (index.ts only length-capped
// them) while chat text got stripped in Room.broadcastChat. A name is
// broadcast in every snapshot and drawn into every other player's
// nameplate, so control characters in one reached everyone.
//
// Control characters are built with fromCharCode rather than written as
// literals so this file stays plain ASCII - a raw NUL in the source makes
// git treat it as a binary blob and the diff becomes unreviewable.
const ch = (code: number): string => String.fromCharCode(code);
const NUL = ch(0x00);
const BEL = ch(0x07);
const DEL = ch(0x7f);
const RLO = ch(0x202e); // right-to-left override - the name-spoofing vector
const ZWSP = ch(0x200b);
const BOM = ch(0xfeff);
const ZWJ = ch(0x200d); // must SURVIVE: real emoji sequences need it

describe('decodeClient free-text sanitisation', () => {
  it('strips control characters from a hello name', () => {
    const msg = decodeClient(raw({ t: 'hello', name: `ja${NUL}ck${BEL}` }));
    if (msg.t !== 'hello') throw new Error('expected hello');
    expect(msg.name).toBe('jack');
  });

  it('strips newlines, tabs and DEL from chat text', () => {
    const msg = decodeClient(raw({ t: 'chat', text: `hi\r\nthe\tre${DEL}` }));
    if (msg.t !== 'chat') throw new Error('expected chat');
    expect(msg.text).toBe('hithere');
  });

  it('clamps an over-long name and over-long chat text', () => {
    const name = decodeClient(raw({ t: 'hello', name: 'x'.repeat(500) }));
    if (name.t !== 'hello') throw new Error('expected hello');
    expect(name.name).toHaveLength(NAME_MAX_LEN);

    const chat = decodeClient(raw({ t: 'chat', text: 'y'.repeat(500) }));
    if (chat.t !== 'chat') throw new Error('expected chat');
    expect(chat.text).toHaveLength(CHAT_MAX_LEN);
  });

  it('leaves a name that is nothing but control characters empty', () => {
    // index.ts falls back to 'anon' on this; the decoder just reports it.
    const msg = decodeClient(raw({ t: 'hello', name: `${NUL}\t ` }));
    if (msg.t !== 'hello') throw new Error('expected hello');
    expect(msg.name).toBe('');
  });

  it('strips bidi overrides, zero-width space and BOM', () => {
    // A right-to-left override lets a name render as somebody else's;
    // zero-width padding lets two players appear to share one.
    const msg = decodeClient(raw({ t: 'hello', name: `${RLO}ja${ZWSP}ck${BOM}` }));
    if (msg.t !== 'hello') throw new Error('expected hello');
    expect(msg.name).toBe('jack');
  });

  it('leaves ordinary unicode and emoji sequences alone', () => {
    // Stripping must not reach legitimate text: another script, an astral
    // -plane emoji, or a ZWJ sequence (which would break into two glyphs
    // if the joiner were removed).
    const name = `Maïa \u{1F6FB} \u{1F468}${ZWJ}\u{1F469}`;
    const msg = decodeClient(raw({ t: 'hello', name }));
    if (msg.t !== 'hello') throw new Error('expected hello');
    expect(msg.name).toBe(name);
  });

  it('never leaves a lone surrogate behind when clamping', () => {
    // The clamp cuts on code units, so an odd-length prefix lands between
    // the halves of a surrogate pair. A lone surrogate is ill-formed
    // UTF-16 and msgpack turns it into U+FFFD, so a replacement glyph
    // would appear on every client's nameplate.
    for (const prefix of ['', 'x', 'xy']) {
      const msg = decodeClient(raw({ t: 'hello', name: prefix + '\u{1F6FB}'.repeat(40) }));
      if (msg.t !== 'hello') throw new Error('expected hello');
      expect(msg.name.length, prefix).toBeLessThanOrEqual(NAME_MAX_LEN);
      expect(hasLoneSurrogate(msg.name), `prefix ${JSON.stringify(prefix)}`).toBe(false);
    }
  });
});

/** True if any UTF-16 code unit is a surrogate without its partner. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}
