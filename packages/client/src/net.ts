// Tiny client wrapper around the shared message protocol.

import {
  Net,
  INTERPOLATION_DELAY_MS,
  PROTOCOL_VERSION,
  type PlayerId,
  type VehicleBuild,
  type WorldSnapshot,
  type VehicleStateUpdate,
} from '@mydrunner/shared';
import type { MapHandshake, SpawnHandshake } from '@mydrunner/shared/net';
import type { WinchAttachTarget } from '@mydrunner/shared/net';

export interface NetEvents {
  onWelcome(id: PlayerId, serverTimeMs: number, map: MapHandshake, spawn: SpawnHandshake, build: VehicleBuild): void;
  onSnapshot(snap: WorldSnapshot, recvAtMs: number): void;
  onChat(from: PlayerId, fromName: string, text: string, serverTimeMs: number): void;
  /** `fatal` marks a close that retrying cannot fix - currently only a
   *  server `bye`, which it sends for a protocol-version mismatch. The
   *  caller must stop reconnecting: every attempt would be refused
   *  identically, and the backoff would hide the reason behind a
   *  "reconnecting..." message forever. */
  onClose(reason: string, fatal: boolean): void;
  onOpen(): void;
  onWorkshopAck(msg: Extract<Net.ServerMessage, { t: 'workshop-ack' }>): void;
  onWinchAck(msg: Extract<Net.ServerMessage, { t: 'winch-ack' }>): void;
  onWinchEvent(msg: Extract<Net.ServerMessage, { t: 'winch-event' }>): void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private events: NetEvents;
  private url: string;
  private name: string;
  private build: VehicleBuild;
  /** Set once a `bye` arrives. The server closes the socket right after
   *  sending one, so the 'close' listener below fires immediately after -
   *  without this it would report a second, non-fatal close and undo the
   *  fatal one, putting the client straight back into the retry loop. */
  private fatal = false;

  constructor(url: string, name: string, build: VehicleBuild, events: NetEvents) {
    this.url = url;
    this.name = name;
    this.build = build;
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
        Net.encode({ t: 'hello', name: this.name, build: this.build, v: PROTOCOL_VERSION }),
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
          this.build = msg.build;
          this.events.onWelcome(msg.you, msg.serverTimeMs, msg.map, msg.spawn, msg.build);
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
        case 'workshop-ack':
          if (msg.ok && msg.build) this.build = msg.build;
          this.events.onWorkshopAck(msg);
          break;
        case 'winch-ack':
          this.events.onWinchAck(msg);
          break;
        case 'winch-event':
          this.events.onWinchEvent(msg);
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

  sendVehicleState(update: VehicleStateUpdate): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Net.encode({ t: 'state', update }));
  }

  sendChat(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Net.encode({ t: 'chat', text }));
  }

  enterWorkshop(bayId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Net.encode({ t: 'workshop-enter', bayId }));
  }

  applyBuild(leaseId: string, build: VehicleBuild): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Net.encode({ t: 'build-update', leaseId, build }));
  }

  exitWorkshop(leaseId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Net.encode({ t: 'workshop-exit', leaseId }));
  }

  sendWinchCommand(seq: number, action: 'attach', target: WinchAttachTarget): void;
  sendWinchCommand(seq: number, action: 'detach' | 'break'): void;
  sendWinchCommand(seq: number, action: 'attach' | 'detach' | 'break', target?: WinchAttachTarget): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const message: Net.ClientMessage = action === 'attach'
      ? { t: 'winch-command', seq, action, target: target! }
      : { t: 'winch-command', seq, action };
    this.ws.send(Net.encode(message));
  }

  close(): void {
    this.ws?.close();
  }
}

export const RENDER_DELAY_MS = INTERPOLATION_DELAY_MS;
