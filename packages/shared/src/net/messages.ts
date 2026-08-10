import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import {
  VEHICLE_BASE_IDS,
  VEHICLE_PART_SLOTS,
  createStockBuild,
  normalizeVehicleBuildDetailed,
  partListsFor,
} from '../vehicleBuild.js';
import type {
  PlayerId,
  PlayerSnapshot,
  VehicleBuild,
  VehicleState,
  VehicleStateUpdate,
  WinchLinkSnapshot,
  WinchRuntimeUpdate,
  WinchTarget,
  WheelState,
  WorldSnapshot,
} from '../types.js';
import type { PredictedRutStamp, RutStamp, RutTilePayload } from '../physics/ruts.js';

export type WinchAttachTarget =
  | { kind: 'obstacle'; obstacleId: string }
  | { kind: 'vehicle'; playerId: PlayerId; point: 'front' | 'rear' };

// Client -> Server
export type ClientMessage =
  /** `v` is the sender's PROTOCOL_VERSION. Absent means a build from
   *  before the handshake existed, which is by definition incompatible;
   *  decodeClient reports it as 0 so the server can refuse it with a
   *  reason rather than admitting a client that would rubber-band. */
  | { t: 'hello'; name: string; build: VehicleBuild; v: number }
  | { t: 'state'; update: VehicleStateUpdate }
  | { t: 'ping'; clientTimeMs: number }
  | { t: 'chat'; text: string }
  | { t: 'workshop-enter'; bayId: string }
  | { t: 'workshop-exit'; leaseId: string }
  | { t: 'build-update'; leaseId: string; build: VehicleBuild; normalizationIssues?: string[] }
  | { t: 'winch-command'; seq: number; action: 'attach'; target: WinchAttachTarget }
  | { t: 'winch-command'; seq: number; action: 'detach' | 'break' }
  | { t: 'rut-stamp'; stamp: PredictedRutStamp };

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
      build: VehicleBuild;
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
  | {
      t: 'workshop-ack';
      action: 'enter' | 'exit' | 'apply';
      ok: boolean;
      reason?: string;
      leaseId?: string;
      bayId?: string;
      pose?: SpawnHandshake;
      build?: VehicleBuild;
      buildRevision?: number;
    }
  | { t: 'winch-ack'; seq: number; ok: boolean; link?: WinchLinkSnapshot; reason?: string }
  | { t: 'winch-event'; linkId: string; reason: 'broken' | 'target-lost' | 'invalid' }
  | { t: 'rut-sync-start'; globalSequence: number; tileCount: number }
  | { t: 'rut-tile'; tile: RutTilePayload }
  | { t: 'rut-sync-end'; globalSequence: number }
  | { t: 'rut-batch'; stamps: RutStamp[] }
  | { t: 'rut-result'; ownerSequence: number; accepted: boolean; globalSequence?: number }
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
// precision is well below human-visible error. The owning client keeps its
// full-precision state; only remote visuals and collision proxies consume
// the relay's quantized copy.
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
const TIRE_DEFLECTION_SCALE = 1000; // millimetres
const NORMAL_SCALE = 32767;
const TWO_PI = Math.PI * 2;

function q(v: number, scale: number): number {
  return Math.round(v * scale) | 0;
}

const DAMAGE_SCALE = 1000;
const VEHICLE_TUPLE_LENGTH = 63;

function packVehicle(v: VehicleState): number[] {
  const out: number[] = [
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
    v.drivetrain.transferCase === '4l' ? 1 : v.drivetrain.transferCase === '2h' ? 2 : 0,
    v.drivetrain.frontLocked ? 1 : 0,
    v.drivetrain.rearLocked ? 1 : 0,
    q(v.damage.body, DAMAGE_SCALE),
    q(v.damage.engine, DAMAGE_SCALE),
    q(v.damage.steering, DAMAGE_SCALE),
    v.damage.stoppedCause === 'collision' ? 1 : v.damage.stoppedCause === 'flooding' ? 2 : 0,
  ];
  for (const w of v.wheels) {
    const spinMod = ((w.spin % TWO_PI) + TWO_PI) % TWO_PI;
    out.push(
      q(w.steer, STEER_SCALE),
      q(spinMod, SPIN_SCALE),
      w.contact ? 1 : 0,
      q(w.suspensionLength, SUSP_SCALE),
      q(w.angVel, WHEEL_ANGVEL_SCALE),
      q(w.tireDeflection, TIRE_DEFLECTION_SCALE),
      q(w.tireContactNormal.x, NORMAL_SCALE),
      q(w.tireContactNormal.y, NORMAL_SCALE),
      q(w.tireContactNormal.z, NORMAL_SCALE),
    );
  }
  for (const a of v.axles) {
    out.push(q(a.rideY, RIDEY_SCALE), q(a.rollAngle, ROLL_SCALE));
  }
  return out;
}

function unpackVehicle(arr: unknown[]): VehicleState {
  if (arr.length !== VEHICLE_TUPLE_LENGTH || arr.some((v) => !isFiniteNum(v))) {
    throw new Error('vehicle state: malformed tuple');
  }
  let i = 0;
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
  const transferCaseWire = arr[i++] as number;
  const frontLockedWire = arr[i++] as number;
  const rearLockedWire = arr[i++] as number;
  const bodyWire = arr[i++] as number;
  const engineWire = arr[i++] as number;
  const steeringWire = arr[i++] as number;
  const causeWire = arr[i++] as number;
  if (
    ![0, 1, 2].includes(transferCaseWire) || ![0, 1].includes(frontLockedWire) || ![0, 1].includes(rearLockedWire)
    || bodyWire < 0 || bodyWire > DAMAGE_SCALE
    || engineWire < 0 || engineWire > DAMAGE_SCALE
    || steeringWire < 0 || steeringWire > DAMAGE_SCALE
    || ![0, 1, 2].includes(causeWire)
  ) {
    throw new Error('vehicle state: drivetrain/damage out of range');
  }
  const wheels: WheelState[] = [];
  for (let w = 0; w < 4; w++) {
    const steer = (arr[i++] as number) / STEER_SCALE;
    const spin = (arr[i++] as number) / SPIN_SCALE;
    const contactWire = arr[i++] as number;
    const contact = contactWire === 1;
    const suspensionLength = (arr[i++] as number) / SUSP_SCALE;
    const angVel = (arr[i++] as number) / WHEEL_ANGVEL_SCALE;
    const tireDeflectionWire = arr[i++] as number;
    const nxWire = arr[i++] as number;
    const nyWire = arr[i++] as number;
    const nzWire = arr[i++] as number;
    if (
      ![0, 1].includes(contactWire)
      || tireDeflectionWire < 0 || tireDeflectionWire > TIRE_DEFLECTION_SCALE
      || Math.abs(nxWire) > NORMAL_SCALE || Math.abs(nyWire) > NORMAL_SCALE || Math.abs(nzWire) > NORMAL_SCALE
      || nxWire * nxWire + nyWire * nyWire + nzWire * nzWire < 1
    ) throw new Error('vehicle state: wheel contact/carcass out of range');
    const tireDeflection = tireDeflectionWire / TIRE_DEFLECTION_SCALE;
    let nx = nxWire / NORMAL_SCALE;
    let ny = nyWire / NORMAL_SCALE;
    let nz = nzWire / NORMAL_SCALE;
    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength > 1e-6) {
      nx /= normalLength; ny /= normalLength; nz /= normalLength;
    } else {
      nx = 0; ny = 1; nz = 0;
    }
    wheels.push({
      steer, spin, contact, suspensionLength, angVel, tireDeflection,
      tireContactNormal: { x: nx, y: ny, z: nz },
    });
  }
  const axles: VehicleState['axles'] = [
    { rideY: (arr[i++] as number) / RIDEY_SCALE, rollAngle: (arr[i++] as number) / ROLL_SCALE },
    { rideY: (arr[i++] as number) / RIDEY_SCALE, rollAngle: (arr[i++] as number) / ROLL_SCALE },
  ];
  return {
    position: { x: px, y: py, z: pz },
    rotation: { x: rx, y: ry, z: rz, w: rw },
    linVel: { x: lvx, y: lvy, z: lvz },
    angVel: { x: avx, y: avy, z: avz },
    rpm,
    gear,
    throttle,
    drivetrain: {
      transferCase: transferCaseWire === 1 ? '4l' : transferCaseWire === 2 ? '2h' : '4h',
      frontLocked: frontLockedWire === 1,
      rearLocked: rearLockedWire === 1,
    },
    damage: {
      body: bodyWire / DAMAGE_SCALE,
      engine: engineWire / DAMAGE_SCALE,
      steering: steeringWire / DAMAGE_SCALE,
      stoppedCause: causeWire === 1 ? 'collision' : causeWire === 2 ? 'flooding' : 'none',
    },
    wheels,
    axles,
  };
}

// [baseId, paintColor, paintFinish, ...one index per part slot, lockers].
// Both ends walk VEHICLE_PART_SLOTS rather than restating the nine slot
// names in order: the two lists were hand-written and hand-ordered, and a
// slot inserted into one but not the other shifts every later index by one.
// Nothing would throw - every field would decode as its neighbour and each
// remote truck would silently wear somebody else's parts.
const BUILD_HEADER_LENGTH = 3;
const BUILD_TUPLE_LENGTH = BUILD_HEADER_LENGTH + VEHICLE_PART_SLOTS.length + 1;

function packBuild(build: VehicleBuild): number[] {
  const result = normalizeVehicleBuildDetailed(build).build;
  const lists = partListsFor(result.baseId);
  const out: number[] = [
    VEHICLE_BASE_IDS.indexOf(result.baseId),
    Number.parseInt(result.paintColor.slice(1), 16),
    result.paintFinish === 'satin' ? 1 : result.paintFinish === 'matte' ? 2 : 0,
  ];
  for (let i = 0; i < VEHICLE_PART_SLOTS.length; i++) {
    const selected = result[VEHICLE_PART_SLOTS[i]!];
    out.push(lists[i]!.findIndex((part) => part.id === selected));
  }
  out.push((result.frontLocker ? 1 : 0) | (result.rearLocker ? 2 : 0));
  return out;
}

function unpackBuild(value: unknown): VehicleBuild {
  if (!Array.isArray(value) || value.length !== BUILD_TUPLE_LENGTH || value.some((v) => !Number.isSafeInteger(v))) {
    throw new Error('build: malformed tuple');
  }
  const baseId = VEHICLE_BASE_IDS[value[0] as number];
  const paint = value[1] as number;
  const finish = value[2] as number;
  const lockers = value[BUILD_TUPLE_LENGTH - 1] as number;
  if (!baseId || paint < 0 || paint > 0xffffff || finish < 0 || finish > 2 || lockers < 0 || lockers > 3) {
    throw new Error('build: out of range');
  }
  const lists = partListsFor(baseId);
  const raw: Record<string, unknown> = {
    ...createStockBuild(baseId),
    paintColor: `#${paint.toString(16).padStart(6, '0')}`,
    paintFinish: finish === 1 ? 'satin' : finish === 2 ? 'matte' : 'gloss',
    frontLocker: (lockers & 1) !== 0,
    rearLocker: (lockers & 2) !== 0,
  };
  for (let i = 0; i < VEHICLE_PART_SLOTS.length; i++) {
    const id = lists[i]![value[BUILD_HEADER_LENGTH + i] as number]?.id;
    if (!id) throw new Error('build: part index out of range');
    raw[VEHICLE_PART_SLOTS[i]!] = id;
  }
  const result = normalizeVehicleBuildDetailed(raw);
  if (result.issues.length > 0) throw new Error(`build: incompatible (${result.issues[0]})`);
  return result.build;
}

function packPlayer(p: PlayerSnapshot): unknown[] {
  return [
    p.id,
    p.name,
    packBuild(p.build),
    p.buildRevision | 0,
    p.workshopMode ? 1 : 0,
    p.stateSeq | 0,
    ...packVehicle(p.vehicle),
  ];
}

function unpackPlayer(arr: unknown[]): PlayerSnapshot {
  if (
    arr.length !== VEHICLE_TUPLE_LENGTH + 6 ||
    typeof arr[0] !== 'string' ||
    typeof arr[1] !== 'string' ||
    !Array.isArray(arr[2]) ||
    !Number.isSafeInteger(arr[3]) ||
    (arr[4] !== 0 && arr[4] !== 1) ||
    !Number.isSafeInteger(arr[5])
  ) {
    throw new Error('snapshot: malformed player tuple');
  }
  const id = arr[0] as PlayerId;
  const name = arr[1] as string;
  const build = unpackBuild(arr[2]);
  const buildRevision = arr[3] as number;
  const workshopMode = arr[4] === 1;
  const stateSeq = arr[5] as number;
  return { id, name, build, buildRevision, workshopMode, vehicle: unpackVehicle(arr.slice(6)), stateSeq };
}

/** Per-player tuple layout version. Bump whenever packPlayer's fields or
 *  any nested positional tuple (including VehicleBuild) changes; a stale
 *  decoder would otherwise silently misread values by position. */
export const SNAPSHOT_SCHEMA = 6;

const CABLE_SCALE = 1000;
const TENSION_SCALE = 0.1;

function packWinchTarget(target: WinchTarget): unknown[] {
  return target.kind === 'vehicle'
    ? [1, target.playerId, target.point === 'rear' ? 1 : 0]
    : [0, target.obstacleId, q(target.anchor.x, POS_SCALE), q(target.anchor.y, POS_SCALE), q(target.anchor.z, POS_SCALE)];
}

function unpackWinchTarget(value: unknown): WinchTarget {
  if (!Array.isArray(value)) throw new Error('winch target: malformed');
  if (value[0] === 1 && value.length === 3 && typeof value[1] === 'string' && (value[2] === 0 || value[2] === 1)) {
    return { kind: 'vehicle', playerId: value[1], point: value[2] === 1 ? 'rear' : 'front' };
  }
  if (value[0] === 0 && value.length === 5 && typeof value[1] === 'string'
    && value.slice(2).every(isFiniteNum)) {
    return {
      kind: 'obstacle', obstacleId: value[1],
      anchor: {
        x: (value[2] as number) / POS_SCALE,
        y: (value[3] as number) / POS_SCALE,
        z: (value[4] as number) / POS_SCALE,
      },
    };
  }
  throw new Error('winch target: malformed');
}

function packWinch(link: WinchLinkSnapshot): unknown[] {
  const status = link.status === 'stalled' ? 1 : link.status === 'overload' ? 2 : 0;
  return [link.id, link.ownerId, packWinchTarget(link.target), q(link.cableLength, CABLE_SCALE), link.motor, q(link.tension, TENSION_SCALE), status];
}

function unpackWinch(value: unknown): WinchLinkSnapshot {
  if (!Array.isArray(value) || value.length !== 7 || typeof value[0] !== 'string'
    || typeof value[1] !== 'string' || !Number.isSafeInteger(value[3])
    || ![-1, 0, 1].includes(value[4] as number) || !Number.isSafeInteger(value[5])
    || ![0, 1, 2].includes(value[6] as number)) {
    throw new Error('winch link: malformed');
  }
  return {
    id: value[0], ownerId: value[1], target: unpackWinchTarget(value[2]),
    cableLength: (value[3] as number) / CABLE_SCALE,
    motor: value[4] as -1 | 0 | 1,
    tension: (value[5] as number) / TENSION_SCALE,
    status: value[6] === 1 ? 'stalled' : value[6] === 2 ? 'overload' : 'attached',
  };
}

function packWinchRuntime(runtime: WinchRuntimeUpdate | undefined): unknown[] | null {
  return runtime
    ? [runtime.linkId, q(runtime.cableLength, CABLE_SCALE), runtime.motor, q(runtime.tension, TENSION_SCALE)]
    : null;
}

function unpackWinchRuntime(value: unknown): WinchRuntimeUpdate | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== 'string'
    || !Number.isSafeInteger(value[1]) || ![-1, 0, 1].includes(value[2] as number)
    || !Number.isSafeInteger(value[3])) throw new Error('winch runtime: malformed');
  return {
    linkId: value[0], cableLength: (value[1] as number) / CABLE_SCALE,
    motor: value[2] as -1 | 0 | 1, tension: (value[3] as number) / TENSION_SCALE,
  };
}

function packSnapshot(snap: WorldSnapshot): unknown {
  return {
    t: 'snapshot',
    s: SNAPSHOT_SCHEMA,
    T: snap.tick | 0,
    M: snap.serverTimeMs | 0,
    P: snap.players.map(packPlayer),
    W: (snap.winches ?? []).map(packWinch),
  };
}

function unpackSnapshot(obj: { T: number; M: number; P: unknown[][]; W?: unknown[] }): WorldSnapshot {
  return {
    tick: obj.T,
    serverTimeMs: obj.M,
    players: obj.P.map(unpackPlayer),
    winches: (obj.W ?? []).map(unpackWinch),
  };
}

export function encode(msg: ClientMessage | ServerMessage): Uint8Array {
  if ((msg as ServerMessage).t === 'snapshot') {
    return msgpackEncode(packSnapshot((msg as { snap: WorldSnapshot }).snap));
  }
  if ((msg as ClientMessage).t === 'state') {
    const update = (msg as { t: 'state'; update: VehicleStateUpdate }).update;
    return msgpackEncode({
      t: 'state',
      s: SNAPSHOT_SCHEMA,
      Q: update.seq,
      V: packVehicle(update.vehicle),
      R: packWinchRuntime(update.winch),
    });
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
 *  crash the whole room. NaN/Infinity in owner state is rejected here so
 *  malformed state cannot poison every remote renderer. */
export function decodeClient(raw: Wire): ClientMessage {
  const m = msgpackDecode(toBytes(raw)) as Record<string, unknown> | null;
  if (m === null || typeof m !== 'object') throw new Error('client message: not an object');
  switch (m.t) {
    case 'hello': {
      if (typeof m.name !== 'string') throw new Error('hello: name must be a string');
      // Old clients/saves sent carKind. It is accepted only as a migration
      // source and immediately expanded to a complete stock VehicleBuild.
      const build = normalizeVehicleBuildDetailed(
        m.build ?? { carKind: typeof m.carKind === 'string' ? m.carKind : undefined },
      ).build;
      // A mismatched version is NOT thrown here. Throwing lands in the ws
      // handler's catch, which returns silently - the player would sit on
      // a connected socket that never sends a welcome, with nothing on
      // screen explaining why. Pass the value through instead and let the
      // caller answer with a `bye` the client can display.
      const v = Number.isSafeInteger(m.v) ? (m.v as number) : 0;
      return { t: 'hello', name: sanitiseUserText(m.name, NAME_MAX_LEN), build, v };
    }
    case 'state': {
      if (m.s !== SNAPSHOT_SCHEMA) {
        throw new Error(`state: unsupported schema ${String(m.s)}`);
      }
      if (!Number.isSafeInteger(m.Q) || !Array.isArray(m.V)) {
        throw new Error('state: malformed payload');
      }
      return {
        t: 'state',
        update: { seq: m.Q as number, vehicle: unpackVehicle(m.V), winch: unpackWinchRuntime(m.R) },
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
    case 'workshop-enter': {
      if (typeof m.bayId !== 'string' || m.bayId.length > 64) throw new Error('workshop-enter: invalid bay');
      return { t: 'workshop-enter', bayId: m.bayId };
    }
    case 'workshop-exit': {
      if (typeof m.leaseId !== 'string' || m.leaseId.length > 128) throw new Error('workshop-exit: invalid lease');
      return { t: 'workshop-exit', leaseId: m.leaseId };
    }
    case 'build-update': {
      if (typeof m.leaseId !== 'string' || m.leaseId.length > 128) throw new Error('build-update: invalid lease');
      const result = normalizeVehicleBuildDetailed(m.build);
      return {
        t: 'build-update',
        leaseId: m.leaseId,
        build: result.build,
        normalizationIssues: result.issues,
      };
    }
    case 'winch-command': {
      if (!Number.isSafeInteger(m.seq) || (m.action !== 'attach' && m.action !== 'detach' && m.action !== 'break')) {
        throw new Error('winch-command: malformed');
      }
      if (m.action === 'attach') {
        const target = m.target as Record<string, unknown> | null;
        if (!target || typeof target !== 'object') throw new Error('winch-command: target required');
        if (target.kind === 'obstacle' && typeof target.obstacleId === 'string'
          && target.obstacleId.length > 0 && target.obstacleId.length <= 128) {
          return { t: 'winch-command', seq: m.seq as number, action: 'attach', target: { kind: 'obstacle', obstacleId: target.obstacleId } };
        }
        if (target.kind === 'vehicle' && typeof target.playerId === 'string'
          && target.playerId.length > 0 && target.playerId.length <= 128
          && (target.point === 'front' || target.point === 'rear')) {
          return { t: 'winch-command', seq: m.seq as number, action: 'attach', target: { kind: 'vehicle', playerId: target.playerId, point: target.point } };
        }
        throw new Error('winch-command: invalid target');
      }
      return { t: 'winch-command', seq: m.seq as number, action: m.action };
    }
    case 'rut-stamp': {
      const stamp = m.stamp as Record<string, unknown> | null;
      if (!stamp || typeof stamp !== 'object'
        || !Number.isSafeInteger(stamp.ownerSequence) || (stamp.ownerSequence as number) <= 0
        || !isFiniteNum(stamp.x) || !isFiniteNum(stamp.z) || !isFiniteNum(stamp.heading)
        || !isFiniteNum(stamp.radiusLong) || !isFiniteNum(stamp.radiusLat) || !isFiniteNum(stamp.depth)
        || stamp.radiusLong < 0.25 || stamp.radiusLong > 1.5
        || stamp.radiusLat < 0.125 || stamp.radiusLat > 0.8
        || stamp.depth <= 0 || stamp.depth > 0.04) {
        throw new Error('rut-stamp: malformed or out of range');
      }
      return { t: 'rut-stamp', stamp: stamp as unknown as PredictedRutStamp };
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
    return { t: 'snapshot', snap: unpackSnapshot(decoded as unknown as { T: number; M: number; P: unknown[][]; W?: unknown[] }) };
  }
  if (decoded.t === 'rut-tile') {
    const tile = decoded.tile as Record<string, unknown> | null;
    if (!tile || !Number.isSafeInteger(tile.tileX) || !Number.isSafeInteger(tile.tileZ)
      || Math.abs(tile.tileX as number) > 32_767 || Math.abs(tile.tileZ as number) > 32_767
      || !(tile.depths instanceof Uint8Array) || tile.depths.length !== 256) {
      throw new Error('rut-tile: malformed');
    }
  } else if (decoded.t === 'rut-sync-start') {
    if (!Number.isSafeInteger(decoded.globalSequence) || !Number.isSafeInteger(decoded.tileCount)
      || (decoded.globalSequence as number) < 0
      || (decoded.tileCount as number) < 0 || (decoded.tileCount as number) > 65_536) {
      throw new Error('rut-sync-start: malformed');
    }
  } else if (decoded.t === 'rut-sync-end') {
    if (!Number.isSafeInteger(decoded.globalSequence)
      || (decoded.globalSequence as number) < 0) throw new Error('rut-sync-end: malformed');
  } else if (decoded.t === 'rut-batch') {
    if (!Array.isArray(decoded.stamps) || decoded.stamps.length > 16) throw new Error('rut-batch: malformed');
    for (const value of decoded.stamps) {
      const stamp = value as Record<string, unknown>;
      if (typeof stamp.ownerId !== 'string' || stamp.ownerId.length < 1 || stamp.ownerId.length > 128
        || !Number.isSafeInteger(stamp.ownerSequence) || (stamp.ownerSequence as number) <= 0
        || !Number.isSafeInteger(stamp.globalSequence) || !isFiniteNum(stamp.x)
        || !isFiniteNum(stamp.z) || !isFiniteNum(stamp.heading)
        || !isFiniteNum(stamp.radiusLong) || !isFiniteNum(stamp.radiusLat)
        || !isFiniteNum(stamp.depth) || (stamp.globalSequence as number) <= 0
        || (stamp.radiusLong as number) < 0.25 || (stamp.radiusLong as number) > 1.5
        || (stamp.radiusLat as number) < 0.125 || (stamp.radiusLat as number) > 0.8
        || (stamp.depth as number) <= 0 || (stamp.depth as number) > 0.04) {
        throw new Error('rut-batch: invalid stamp');
      }
    }
  } else if (decoded.t === 'rut-result') {
    if (!Number.isSafeInteger(decoded.ownerSequence) || (decoded.ownerSequence as number) <= 0
      || typeof decoded.accepted !== 'boolean'
      || (decoded.accepted
        ? !Number.isSafeInteger(decoded.globalSequence) || (decoded.globalSequence as number) <= 0
        : decoded.globalSequence !== undefined)) {
      throw new Error('rut-result: malformed');
    }
  }
  return decoded as unknown as ServerMessage;
}
