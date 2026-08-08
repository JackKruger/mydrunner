// Boots a real WebSocket relay and validates the complete owner-state path:
// hello -> welcome -> state upload -> aggregated snapshot.

import { describe, it, expect } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { Net, PROTOCOL_VERSION, createStockBuild, type WorldSnapshot, type PlayerId } from '@mydrunner/shared';
import { setTimeout as sleep } from 'node:timers/promises';
import { Room, type PlayerHandle } from '../room.js';

describe('server integration', () => {
  it('serves welcome and relays canonical client state', async () => {
    const room = new Room();
    room.start();

    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    const port = (wss.address() as { port: number }).port;
    let counter = 0;

    wss.on('connection', (ws) => {
      const id = `t${++counter}`;
      const handle: PlayerHandle = {
        id,
        name: 'test',
        carKind: 'patrol',
        send: (m) => { if (ws.readyState === ws.OPEN) ws.send(m, { binary: true }); },
      };
      ws.on('message', (raw) => {
        const msg = Net.decodeClient(raw as Buffer);
        if (msg.t === 'hello') {
          handle.name = msg.name;
          handle.build = msg.build;
          room.addPlayer(handle);
        } else if (msg.t === 'state') {
          room.applyVehicleState(id, msg.update);
        }
      });
      ws.on('close', () => room.removePlayer(id));
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    let myId: PlayerId | null = null;
    const snaps: WorldSnapshot[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open timeout')), 3000);
      client.on('open', () => { clearTimeout(timer); resolve(); });
      client.on('error', reject);
    });
    client.on('message', (raw) => {
      const msg = Net.decodeServer(raw as Buffer);
      if (msg.t === 'welcome') myId = msg.you;
      if (msg.t === 'snapshot') snaps.push(msg.snap);
    });
    client.send(Net.encode({ t: 'hello', name: 'tester', build: createStockBuild(), v: PROTOCOL_VERSION }));

    const start = Date.now();
    while (snaps.length < 3 && Date.now() - start < 3000) await sleep(20);
    expect(myId).not.toBeNull();
    expect(snaps.length).toBeGreaterThanOrEqual(3);
    expect(snaps[0]!.players[0]!.id).toBe(myId);
    expect(snaps.at(-1)!.tick).toBeGreaterThan(snaps[0]!.tick);

    const initial = snaps.at(-1)!.players[0]!.vehicle;
    const uploaded = {
      ...initial,
      position: { x: initial.position.x + 12, y: 1.25, z: initial.position.z - 2 },
      linVel: { x: 8, y: 0, z: -1 },
      rpm: 2400,
      throttle: 1,
    };
    client.send(Net.encode({ t: 'state', update: { seq: 7, vehicle: uploaded } }));
    const uploadStart = Date.now();
    while (snaps.at(-1)!.players[0]!.stateSeq < 7 && Date.now() - uploadStart < 3000) {
      await sleep(20);
    }
    const last = snaps.at(-1)!.players[0]!;
    expect(last.stateSeq).toBe(7);
    expect(last.vehicle.position.x).toBeCloseTo(uploaded.position.x, 2);
    expect(last.vehicle.linVel.x).toBeCloseTo(8, 2);

    client.close();
    await sleep(50);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    room.stop();
  }, 15000);
});
