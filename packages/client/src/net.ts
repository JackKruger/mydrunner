// Tiny client wrapper around the shared message protocol.

import { Net, INTERPOLATION_DELAY_MS, type CarKind, type WorldSnapshot, type PlayerInput, type PlayerId } from '@mydrunner/shared';
import type { TerrainHandshake, SpawnHandshake } from '@mydrunner/shared/net';

export interface NetEvents {
  onWelcome(id: PlayerId, serverTimeMs: number, terrain: TerrainHandshake, spawn: SpawnHandshake): void;
  onSnapshot(snap: WorldSnapshot, recvAtMs: number): void;
  onChat(from: PlayerId, fromName: string, text: string, serverTimeMs: number): void;
  onClose(reason: string): void;
  onOpen(): void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private events: NetEvents;
  private url: string;
  private name: string;
  private carKind: CarKind;

  constructor(url: string, name: string, carKind: CarKind, events: NetEvents) {
    this.url = url;
    this.name = name;
    this.carKind = carKind;
    this.events = events;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    // Wire format is MessagePack binary; default 'blob' would force an
    // async FileReader hop on every snapshot. ArrayBuffer is sync.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(Net.encode({ t: 'hello', name: this.name, carKind: this.carKind }));
      this.events.onOpen();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = Net.decodeServer(ev.data as ArrayBuffer);
      } catch {
        return;
      }
      switch (msg.t) {
        case 'welcome':
          this.events.onWelcome(msg.you, msg.serverTimeMs, msg.terrain, msg.spawn);
          break;
        case 'snapshot':
          this.events.onSnapshot(msg.snap, performance.now());
          break;
        case 'chat':
          this.events.onChat(msg.from, msg.fromName, msg.text, msg.serverTimeMs);
          break;
        case 'bye':
          this.events.onClose(msg.reason);
          break;
      }
    });
    ws.addEventListener('close', () => this.events.onClose('socket closed'));
    ws.addEventListener('error', () => {/* surfaced via close */});
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
