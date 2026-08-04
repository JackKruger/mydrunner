import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { CarKind, PlayerId, PlayerInput, PlayerSnapshot, VehicleState, WheelState, WorldSnapshot } from '../types.js';

// Client -> Server
export type ClientMessage =
  /** `v` is the sender's PROTOCOL_VERSION. Absent means a build from
   *  before the handshake existed, which is by definition incompatible;
   *  decodeClient reports it as 0 so the server can refuse it with a
   *  reason rather than admitting a client that would rubber-band. */
  | { t: 'hello'; name: string; carKind?: CarKind; v: number }
  | { t: 'input'; input: PlayerInput }
  | { t: 'ping'; clientTimeMs: number }
  | { t: 'chat'; text: string };

/** Which world to build. Both sides compile the map registry in, so the
 *  wire carries an identity rather than the map: a baked document is
 *  ~65 KB against a 4 KiB message cap (server/src/index.ts).
 *
 *  `rev` is the document's content hash in the SERVER's build. The client
 *  compares it against its own copy of the same map, which is the only
 *  thing that catches half a deploy — Pages and Railway ship separately,
 *  and two builds of "procedural" that disagree would otherwise put the
 *  players on quietly different ground. PROTOCOL_VERSION cannot cover it:
 *  editing a map changes no code either side compiles. */
export interface MapHandshake {
  id: string;
  rev: number;
}

export interface SpawnHandshake {
  position: { x: number; y: number; z: number };
  yaw: number;
}

// Server -> Client
export type ServerMessage =
  | {
      t: 'welcome';
      you: PlayerId;
      tick: number;
      serverTimeMs: number;
      map: MapHandshake;
      spawn: SpawnHandshake;
      /** Server's PROTOCOL_VERSION. The server already refused the join
       *  on a mismatch, so this is informational - it lets the client log
       *  which build it is actually talking to. */
      protocolVersion: number;
    }
  | { t: 'snapshot'; snap: WorldSnapshot }
  | { t: 'pong'; clientTimeMs: number; serverTimeMs: number }
  /** Chat relay - includes the sender's id and display name plus the
   *  server's monotonic time so clients can show "X seconds ago". */
  | { t: 'chat'; from: PlayerId; fromName: string; text: string; serverTimeMs: number }
  | { t: 'bye'; reason: string };

// Wire format: MessagePack binary plus snapshot quantization. The naive
// shape (one keyed object per player, full float64 per number) saturated
// real-world downlinks at 7+ players and triggered TCP buffer-bloat. We
// transform the snapshot to a positional array of integers per player
// before msgpack encoding, then reverse on decode. This is purely a wire
// transformation; the WorldSnapshot interface seen by the rest of the code
// is unchanged.
//
// Quantization is lossy by design - millimetre / centimetre / millirad
// precision is well below human-visible error, and the values are only
// consumed by visuals + the prediction's soft-correction target. They
// never feed back into Rapier on either side, so determinism (client/
// server prediction lockstep on full-precision floats) is preserved.
type Wire = string | Uint8Array | ArrayBuffer;

function toBytes(raw: Wire): Uint8Array {
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}

const POS_SCALE = 100;       // cm
const QUAT_SCALE = 32767;
const VEL_SCALE = 100;       // cm/s
const ANGVEL_SCALE = 1000;   // millirad/s
const THROTTLE_SCALE = 100;
const STEER_SCALE = 100;
const SPIN_SCALE = 1000;     // millirad (mod 2pi to keep in int16)
const SUSP_SCALE = 1000;     // mm
const RIDEY_SCALE = 1000;    // mm
const ROLL_SCALE = 1000;     // millirad
const WHEEL_ANGVEL_SCALE = 100; // centirads/s; ±327 rad/s fits int16
const TWO_PI = Math.PI * 2;

const CAR_KIND_TO_IDX: Record<CarKind, number> = { patrol: 0, hilux: 1, ute: 2, motorbike: 3 };
const CAR_KIND_FROM_IDX: CarKind[] = ['patrol', 'hilux', 'ute', 'motorbike'];

function q(v: number, scale: number): number {
  return Math.round(v * scale) | 0;
}

function packPlayer(p: PlayerSnapshot): unknown[] {
  const v = p.vehicle;
  const out: (number | string)[] = [
    p.id,
    p.name,
    CAR_KIND_TO_IDX[p.carKind] ?? 0,
    p.lastAckSeq | 0,
    q(v.position.x, POS_SCALE),
    q(v.position.y, POS_SCALE),
    q(v.position.z, POS_SCALE),
    q(v.rotation.x, QUAT_SCALE),
    q(v.rotation.y, QUAT_SCALE),
    q(v.rotation.z, QUAT_SCALE),
    q(v.rotation.w, QUAT_SCALE),
    q(v.linVel.x, VEL_SCALE),
    q(v.linVel.y, VEL_SCALE),
    q(v.linVel.z, VEL_SCALE),
    q(v.angVel.x, ANGVEL_SCALE),
    q(v.angVel.y, ANGVEL_SCALE),
    q(v.angVel.z, ANGVEL_SCALE),
    Math.round(v.rpm) | 0,
    v.gear | 0,
    q(v.throttle, THROTTLE_SCALE),
  ];
  for (const w of v.wheels) {
    const spinMod = ((w.spin % TWO_PI) + TWO_PI) % TWO_PI;
    out.push(
      q(w.steer, STEER_SCALE),
      q(spinMod, SPIN_SCALE),
      w.contact ? 1 : 0,
      q(w.suspensionLength, SUSP_SCALE),
      q(w.angVel, WHEEL_ANGVEL_SCALE),
    );
  }
  if (v.axles) {
    for (const a of v.axles) {
      out.push(q(a.rideY, RIDEY_SCALE), q(a.rollAngle, ROLL_SCALE));
    }
  } else {
    out.push(0, 0, 0, 0);
  }
  return out;
}

function unpackPlayer(arr: unknown[]): PlayerSnapshot {
  let i = 0;
  const id = arr[i++] as PlayerId;
  const name = arr[i++] as string;
  const carKind = CAR_KIND_FROM_IDX[arr[i++] as number] ?? 'patrol';
  const lastAckSeq = arr[i++] as number;
  const px = (arr[i++] as number) / POS_SCALE;
  const py = (arr[i++] as number) / POS_SCALE;
  const pz = (arr[i++] as number) / POS_SCALE;
  const rx = (arr[i++] as number) / QUAT_SCALE;
  const ry = (arr[i++] as number) / QUAT_SCALE;
  const rz = (arr[i++] as number) / QUAT_SCALE;
  const rw = (arr[i++] as number) / QUAT_SCALE;
  const lvx = (arr[i++] as number) / VEL_SCALE;
  const lvy = (arr[i++] as number) / VEL_SCALE;
  const lvz = (arr[i++] as number) / VEL_SCALE;
  const avx = (arr[i++] as number) / ANGVEL_SCALE;
  const avy = (arr[i++] as number) / ANGVEL_SCALE;
  const avz = (arr[i++] as number) / ANGVEL_SCALE;
  const rpm = arr[i++] as number;
  const gear = arr[i++] as number;
  const throttle = (arr[i++] as number) / THROTTLE_SCALE;
  const wheels: WheelState[] = [];
  for (let w = 0; w < 4; w++) {
    wheels.push({
      steer: (arr[i++] as number) / STEER_SCALE,
      spin: (arr[i++] as number) / SPIN_SCALE,
      contact: (arr[i++] as number) === 1,
      suspensionLength: (arr[i++] as number) / SUSP_SCALE,
      angVel: (arr[i++] as number) / WHEEL_ANGVEL_SCALE,
    });
  }
  const axles: VehicleState['axles'] = [
    { rideY: (arr[i++] as number) / RIDEY_SCALE, rollAngle: (arr[i++] as number) / ROLL_SCALE },
    { rideY: (arr[i++] as number) / RIDEY_SCALE, rollAngle: (arr[i++] as number) / ROLL_SCALE },
  ];
  const vehicle: VehicleState = {
    position: { x: px, y: py, z: pz },
    rotation: { x: rx, y: ry, z: rz, w: rw },
    linVel: { x: lvx, y: lvy, z: lvz },
    angVel: { x: avx, y: avy, z: avz },
    rpm,
    gear,
    throttle,
    wheels,
    axles,
  };
  return { id, name, carKind, vehicle, lastAckSeq };
}

/** Per-player tuple layout version. Bump whenever packPlayer's field
 *  order or count changes; unpackPlayer reads by position, so a stale
 *  decoder would silently misread every field as its neighbour. */
export const SNAPSHOT_SCHEMA = 2;

function packSnapshot(snap: WorldSnapshot): unknown {
  return {
    t: 'snapshot',
    s: SNAPSHOT_SCHEMA,
    T: snap.tick | 0,
    M: snap.serverTimeMs | 0,
    P: snap.players.map(packPlayer),
  };
}

function unpackSnapshot(obj: { T: number; M: number; P: unknown[][] }): WorldSnapshot {
  return {
    tick: obj.T,
    serverTimeMs: obj.M,
    players: obj.P.map(unpackPlayer),
  };
}

export function encode(msg: ClientMessage | ServerMessage): Uint8Array {
  if ((msg as ServerMessage).t === 'snapshot') {
    return msgpackEncode(packSnapshot((msg as { snap: WorldSnapshot }).snap));
  }
  return msgpackEncode(msg);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Max length of a player display name after sanitisation. */
export const NAME_MAX_LEN = 32;
/** Max length of a chat message after sanitisation. */
export const CHAT_MAX_LEN = 200;

/** Characters no display name or chat line has a legitimate use for:
 *   - C0 controls + DEL, and C1 controls: newlines and friends break the
 *     nameplate layout and the chat log.
 *   - Bidi embeddings / overrides / isolates (U+202A-202E, U+2066-2069):
 *     the classic display-spoofing vector - they let a name render as
 *     somebody else's.
 *   - Zero-width space and BOM: invisible padding, so two players can
 *     appear to share a name.
 *
 *  Deliberately NOT stripped: ZWJ / ZWNJ (U+200C-200D), which real emoji
 *  sequences and Arabic / Indic scripts need, and LRM / RLM (U+200E-200F),
 *  which mixed-direction names legitimately use. */
//  Expressed as codepoint ranges rather than a regex character class so
//  this file stays plain ASCII - writing the characters as literals makes
//  git treat the source as a binary blob, and escape sequences for them
//  are easy to mangle silently.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],     // C0 controls
  [0x7f, 0x9f],     // DEL + C1 controls
  [0x200b, 0x200b], // zero-width space
  [0x202a, 0x202e], // bidi embeddings + overrides
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function isUnsafeChar(code: number): boolean {
  for (const [lo, hi] of UNSAFE_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

/** Strip unsafe characters and clamp length on any free-text field a
 *  client can send. Applied at decode time (below) rather than at each
 *  consumer: player names used to skip this entirely while chat text got
 *  a weaker version of it in Room.broadcastChat, so a crafted name
 *  reached every client's nameplate and chat log.
 *
 *  Length is clamped in code units, matching the previous slice(0, max)
 *  behaviour. A name of astral-plane characters therefore holds fewer
 *  than maxLen glyphs - the cap exists to bound what goes on the wire,
 *  not to promise an exact glyph count. */
export function sanitiseUserText(raw: string, maxLen: number): string {
  let out = '';
  // Iterating the string yields whole code points, so a surrogate pair is
  // one `chr` and can never be half-stripped into a lone surrogate.
  for (const chr of raw) {
    if (!isUnsafeChar(chr.codePointAt(0)!)) out += chr;
  }
  out = out.trim().slice(0, maxLen);
  // The slice above cuts on code units, so it can land between the halves
  // of a surrogate pair (e.g. one ASCII char followed by emoji). A lone
  // high surrogate is ill-formed UTF-16 and msgpack encodes it as U+FFFD,
  // putting a replacement glyph on every client's nameplate. Drop it.
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Decode + validate a client->server message. Throws on malformed bytes
 *  AND on wrong-shaped-but-valid msgpack: this is the trust boundary for
 *  everything a client can send, and a thrown TypeError further in (e.g.
 *  `name.slice` on a number) would escape the ws message handler and
 *  crash the whole room. NaN/Infinity in input fields are rejected here
 *  too — a NaN throttle would otherwise poison the sender's Rapier body. */
export function decodeClient(raw: Wire): ClientMessage {
  const m = msgpackDecode(toBytes(raw)) as Record<string, unknown> | null;
  if (m === null || typeof m !== 'object') throw new Error('client message: not an object');
  switch (m.t) {
    case 'hello': {
      if (typeof m.name !== 'string') throw new Error('hello: name must be a string');
      const carKind = typeof m.carKind === 'string' ? (m.carKind as CarKind) : undefined;
      // A mismatched version is NOT thrown here. Throwing lands in the ws
      // handler's catch, which returns silently - the player would sit on
      // a connected socket that never sends a welcome, with nothing on
      // screen explaining why. Pass the value through instead and let the
      // caller answer with a `bye` the client can display.
      const v = Number.isSafeInteger(m.v) ? (m.v as number) : 0;
      return { t: 'hello', name: sanitiseUserText(m.name, NAME_MAX_LEN), carKind, v };
    }
    case 'input': {
      const i = m.input as Record<string, unknown> | null | undefined;
      if (i === null || i === undefined || typeof i !== 'object') {
        throw new Error('input: missing payload');
      }
      if (
        !Number.isSafeInteger(i.seq) ||
        !isFiniteNum(i.throttle) ||
        !isFiniteNum(i.steer) ||
        !isFiniteNum(i.brake) ||
        !isFiniteNum(i.handbrake)
      ) {
        throw new Error('input: non-finite field');
      }
      return {
        t: 'input',
        input: {
          seq: i.seq as number,
          throttle: i.throttle,
          steer: i.steer,
          brake: i.brake,
          handbrake: i.handbrake,
          buttons: isFiniteNum(i.buttons) ? i.buttons | 0 : 0,
        },
      };
    }
    case 'ping': {
      if (!isFiniteNum(m.clientTimeMs)) throw new Error('ping: clientTimeMs must be a number');
      return { t: 'ping', clientTimeMs: m.clientTimeMs };
    }
    case 'chat': {
      if (typeof m.text !== 'string') throw new Error('chat: text must be a string');
      return { t: 'chat', text: sanitiseUserText(m.text, CHAT_MAX_LEN) };
    }
    default:
      throw new Error('client message: unknown type');
  }
}

export function decodeServer(raw: Wire): ServerMessage {
  const decoded = msgpackDecode(toBytes(raw)) as { t: string } & Record<string, unknown>;
  if (decoded.t === 'snapshot' && Array.isArray(decoded.P)) {
    // The tuple is read by position, so decoding a schema we don't know
    // would not fail - it would quietly assign every field to whatever
    // now sits at that index and drive the truck from garbage. Refuse it
    // instead; the caller drops the frame.
    if (decoded.s !== SNAPSHOT_SCHEMA) {
      throw new Error(`snapshot: unsupported schema ${String(decoded.s)}`);
    }
    return { t: 'snapshot', snap: unpackSnapshot(decoded as unknown as { T: number; M: number; P: unknown[][] }) };
  }
  return decoded as unknown as ServerMessage;
}
