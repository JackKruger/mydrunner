import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { CarKind, PlayerId, PlayerInput, WorldSnapshot } from '../types.js';

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

// Wire format: MessagePack binary. Roughly half the bytes of JSON for the
// snapshot shape we send (lots of small numbers + repeated keys), which
// matters because snapshot bandwidth was filling client downlinks and
// causing TCP buffer-bloat / congestion collapse. Legacy JSON path was
// removed in the buffer-bloat fix; if a future regression makes payloads
// useful to inspect by hand again, swap msgpackEncode for JSON.stringify
// in this file only.
type Wire = string | Uint8Array | ArrayBuffer;

function toBytes(raw: Wire): Uint8Array {
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}

export function encode(msg: ClientMessage | ServerMessage): Uint8Array {
  return msgpackEncode(msg);
}

export function decodeClient(raw: Wire): ClientMessage {
  return msgpackDecode(toBytes(raw)) as ClientMessage;
}

export function decodeServer(raw: Wire): ServerMessage {
  return msgpackDecode(toBytes(raw)) as ServerMessage;
}
