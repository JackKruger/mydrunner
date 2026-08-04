// Tiny client wrapper around the shared message protocol.

import { Net, INTERPOLATION_DELAY_MS, PROTOCOL_VERSION, type CarKind, type WorldSnapshot, type PlayerInput, type PlayerId } from '@mydrunner/shared';
import type { MapHandshake, SpawnHandshake } from '@mydrunner/shared/net';

export interface NetEvents {
  onWelcome(id: PlayerId, serverTimeMs: number, map: MapHandshake, spawn: SpawnHandshake): void;
  onSnapshot(snap: WorldSnapshot, recvAtMs: number): void;
  onChat(from: PlayerId, fromName: string, text: string, serverTimeMs: number): void;
  /** `fatal` marks a close that retrying cannot fix - currently only a
   *  server `bye`, which it sends for a protocol-version mismatch. The
   *  caller must stop reconnecting: every attempt would be refused
   *  identically, and the backoff would hide the reason behind a
   *  "reconnecting..." message forever. */
  onClose(reason: string, fatal: boolean): void;
  onOpen(): void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private events: NetEvents;
  private url: string;
  private name: string;
  private carKind: CarKind;
  /** Set once a `bye` arrives. The server closes the socket right after
   *  sending one, so the 'close' listener below fires immediately after -
   *  without this it would report a second, non-fatal close and undo the
   *  fatal one, putting the client straight back into the retry loop. */
  private fatal = false;

  constructor(url: string, name: string, carKind: CarKind, events: NetEvents) {
    this.url = url;
    this.name = name;
    this.carKind = carKind;
    this.events = events;
  }

  connect(): void {
    this.fatal = false;
    const ws = new WebSocket(this.url);
    // Wire format is MessagePack binary; default 'blob' would force an
    // async FileReader hop on every snapshot. ArrayBuffer is sync.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      ws.send(
        Net.encode({ t: 'hello', name: this.name, carKind: this.carKind, v: PROTOCOL_VERSION }),
      );
      this.events.onOpen();
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = Net.decodeServer(ev.data as ArrayBuffer);
      } catch {
        return;
      }
      switch (msg.t) {
        case 'welcome':
          this.events.onWelcome(msg.you, msg.serverTimeMs, msg.map, msg.spawn);
          break;
        case 'snapshot':
          this.events.onSnapshot(msg.snap, performance.now());
          break;
        case 'chat':
          this.events.onChat(msg.from, msg.fromName, msg.text, msg.serverTimeMs);
          break;
        case 'bye':
          this.fatal = true;
          this.events.onClose(msg.reason, true);
          break;
      }
    });
    // Ignore events from superseded sockets: connect() may be called again
    // (auto-reconnect) while an old socket is still winding down, and its
    // late 'close' must not report the NEW connection as dead.
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      if (this.fatal) return; // already reported with its real reason
      this.events.onClose('socket closed', false);
    });
    ws.addEventListener('error', () => {/* surfaced via close */});
  }

  /** Give up on this connection for a reason retrying cannot fix.
   *
   *  The `bye` path covers what the SERVER can detect; this covers what
   *  only the client can — a welcome naming a map this build does not
   *  have, or has at a different revision. Marks the close fatal before
   *  closing the socket so the socket's own 'close' event doesn't report
   *  a second, retryable one on top and restart the backoff loop. */
  abort(reason: string): void {
    if (this.fatal) return;
    this.fatal = true;
    this.ws?.close();
    this.events.onClose(reason, true);
  }

  sendInput(input: PlayerInput): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Net.encode({ t: 'input', input }));
  }

  sendChat(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Net.encode({ t: 'chat', text }));
  }

  close(): void {
    this.ws?.close();
  }
}

export const RENDER_DELAY_MS = INTERPOLATION_DELAY_MS;
