import type { PlayerId, PlayerInput, WorldSnapshot } from '../types.js';

// Client -> Server
export type ClientMessage =
  | { t: 'hello'; name: string }
  | { t: 'input'; input: PlayerInput }
  | { t: 'ping'; clientTimeMs: number };

export interface TerrainHandshake {
  seed: number;
  size: number;
  resolution: number;
  /** Optional rut deltas applied since terrain was generated (for late-joiners). */
  rutVersion?: number;
}

// Server -> Client
export type ServerMessage =
  | {
      t: 'welcome';
      you: PlayerId;
      tick: number;
      serverTimeMs: number;
      terrain: TerrainHandshake;
    }
  | { t: 'snapshot'; snap: WorldSnapshot }
  | { t: 'pong'; clientTimeMs: number; serverTimeMs: number }
  /** Broadcast when the heightmap mutates (ruts deepen). Coalesced by version. */
  | { t: 'rut'; version: number; cells: { i: number; dy: number }[] }
  | { t: 'bye'; reason: string };

// Wire format: JSON for now (simple, debuggable). Can swap to msgpack later by
// changing only encode/decode here - everything else uses these types.
type Wire = string | Uint8Array | ArrayBuffer;

const decoder = new TextDecoder('utf-8');
function toText(raw: Wire): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return decoder.decode(new Uint8Array(raw));
  return decoder.decode(raw);
}

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: Wire): ClientMessage {
  return JSON.parse(toText(raw)) as ClientMessage;
}

export function decodeServer(raw: Wire): ServerMessage {
  return JSON.parse(toText(raw)) as ServerMessage;
}
