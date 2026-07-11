// decodeClient is the trust boundary for everything a client can send.
// Wrong-shaped-but-valid msgpack must throw (the server catches and drops)
// rather than escape as a TypeError later — an uncaught throw in the ws
// message handler would crash the whole room.

import { describe, expect, it } from 'vitest';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { decodeClient, encode } from '../net/messages.js';

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
