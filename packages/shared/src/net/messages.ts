import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { CarKind, PlayerId, PlayerInput, PlayerSnapshot, VehicleState, WheelState, WorldSnapshot } from '../types.js';

// Client -> Server
export type ClientMessage =
  | { t: 'hello'; name: string; carKind?: CarKind }
  | { t: 'input'; input: PlayerInput }
  | { t: 'ping'; clientTimeMs: number }
  | { t: 'chat'; text: string };

export interface TerrainHandshake {
  seed: number;
  size: number;
  resolution: number;
  /** Optional rut deltas applied since terrain was generated (for late-joiners). */
  rutVersion?: number;
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
      terrain: TerrainHandshake;
      spawn: SpawnHandshake;
    }
  | { t: 'snapshot'; snap: WorldSnapshot }
  | { t: 'pong'; clientTimeMs: number; serverTimeMs: number }
  /** Broadcast when the heightmap mutates (ruts deepen). Coalesced by version. */
  | { t: 'rut'; version: number; cells: { i: number; dy: number }[] }
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
// consumed by visuals + the reconcile snap target. They never feed back
// into Rapier on either side, so determinism (client/server prediction
// lockstep on full-precision floats) is preserved.
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
const TWO_PI = Math.PI * 2;

const CAR_KIND_TO_IDX: Record<CarKind, number> = { patrol: 0, hilux: 1 };
const CAR_KIND_FROM_IDX: CarKind[] = ['patrol', 'hilux'];

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

function packSnapshot(snap: WorldSnapshot): unknown {
  return {
    t: 'snapshot',
    s: 1, // schema version - bump if the per-player tuple changes
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

export function decodeClient(raw: Wire): ClientMessage {
  return msgpackDecode(toBytes(raw)) as ClientMessage;
}

export function decodeServer(raw: Wire): ServerMessage {
  const decoded = msgpackDecode(toBytes(raw)) as { t: string } & Record<string, unknown>;
  if (decoded.t === 'snapshot' && Array.isArray(decoded.P)) {
    return { t: 'snapshot', snap: unpackSnapshot(decoded as unknown as { T: number; M: number; P: unknown[][] }) };
  }
  return decoded as unknown as ServerMessage;
}
