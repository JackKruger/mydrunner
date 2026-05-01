// Tiny client wrapper around the shared message protocol.

import { Net, INTERPOLATION_DELAY_MS, type WorldSnapshot, type PlayerInput, type PlayerId } from '@mydrunner/shared';
import type { TerrainHandshake, SpawnHandshake } from '@mydrunner/shared/net';

export interface NetEvents {
  onWelcome(id: PlayerId, serverTimeMs: number, terrain: TerrainHandshake, spawn: SpawnHandshake): void;
  onSnapshot(snap: WorldSnapshot, recvAtMs: number): void;
  onRut(version: number, cells: { i: number; dy: number }[]): void;
  onClose(reason: string): void;
  onOpen(): void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private events: NetEvents;
  private url: string;
  private name: string;

  constructor(url: string, name: string, events: NetEvents) {
    this.url = url;
    this.name = name;
    this.events = events;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(Net.encode({ t: 'hello', name: this.name }));
      this.events.onOpen();
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = Net.decodeServer(ev.data as string);
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
        case 'rut':
          this.events.onRut(msg.version, msg.cells);
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

  close(): void {
    this.ws?.close();
  }
}

export const RENDER_DELAY_MS = INTERPOLATION_DELAY_MS;
