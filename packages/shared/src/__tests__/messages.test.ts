// decodeClient is the trust boundary for everything a client can send.
// Wrong-shaped-but-valid msgpack must throw (the server catches and drops)
// rather than escape as a TypeError later — an uncaught throw in the ws
// message handler would crash the whole room.

import { describe, expect, it } from 'vitest';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { CHAT_MAX_LEN, NAME_MAX_LEN, decodeClient, encode } from '../net/messages.js';

const raw = (obj: unknown): Uint8Array => msgpackEncode(obj);

describe('decodeClient validation', () => {
  it('round-trips a valid hello', () => {
    const msg = decodeClient(encode({ t: 'hello', name: 'jack', carKind: 'hilux' }));
    expect(msg).toEqual({ t: 'hello', name: 'jack', carKind: 'hilux' });
  });

  it('round-trips a valid input', () => {
    const input = { seq: 42, throttle: 1, steer: -0.5, brake: 0, handbrake: 0, buttons: 1 };
    const msg = decodeClient(encode({ t: 'input', input }));
    expect(msg).toEqual({ t: 'input', input });
  });

  it('rejects hello with a non-string name', () => {
    expect(() => decodeClient(raw({ t: 'hello', name: 42 }))).toThrow();
    expect(() => decodeClient(raw({ t: 'hello' }))).toThrow();
  });

  it('rejects chat with a non-string text', () => {
    expect(() => decodeClient(raw({ t: 'chat', text: { a: 1 } }))).toThrow();
  });

  it('rejects input with NaN / Infinity fields', () => {
    const base = { seq: 1, throttle: 0, steer: 0, brake: 0, handbrake: 0, buttons: 0 };
    expect(() => decodeClient(raw({ t: 'input', input: { ...base, throttle: NaN } }))).toThrow();
    expect(() => decodeClient(raw({ t: 'input', input: { ...base, steer: Infinity } }))).toThrow();
    expect(() => decodeClient(raw({ t: 'input', input: { ...base, brake: 'x' } }))).toThrow();
  });

  it('rejects input with a missing or non-integer seq', () => {
    const base = { throttle: 0, steer: 0, brake: 0, handbrake: 0, buttons: 0 };
    expect(() => decodeClient(raw({ t: 'input', input: base }))).toThrow();
    expect(() => decodeClient(raw({ t: 'input', input: { ...base, seq: 1.5 } }))).toThrow();
    expect(() => decodeClient(raw({ t: 'input', input: { ...base, seq: '9' } }))).toThrow();
  });

  it('rejects missing input payload and unknown message types', () => {
    expect(() => decodeClient(raw({ t: 'input' }))).toThrow();
    expect(() => decodeClient(raw({ t: 'nope' }))).toThrow();
    expect(() => decodeClient(raw('just a string'))).toThrow();
  });

  it('coerces a non-numeric buttons field to 0 instead of throwing', () => {
    const input = { seq: 2, throttle: 0, steer: 0, brake: 0, handbrake: 0, buttons: 'x' };
    const msg = decodeClient(raw({ t: 'input', input }));
    if (msg.t !== 'input') throw new Error('expected input');
    expect(msg.input.buttons).toBe(0);
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
