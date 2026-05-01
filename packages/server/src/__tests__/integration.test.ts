// Boots a real server on a random port and connects a WebSocket client.
// Validates the full happy path: hello -> welcome -> input -> snapshot.

import { describe, it, expect } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { spawn, type ChildProcess } from 'node:child_process';
import { Net, EMPTY_INPUT, type WorldSnapshot, type PlayerId } from '@mydrunner/shared';
import { setTimeout as sleep } from 'node:timers/promises';

// We start the server in-process via the same code path. Easier and faster.
import { Physics } from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

describe('server integration', () => {
  it('serves welcome and broadcasts snapshots over WebSocket', async () => {
    await Physics.initRapier();
    const room = new Room();
    room.start();

    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;
    const handles = new Map<string, PlayerHandle>();
    let counter = 0;

    wss.on('connection', (ws) => {
      const id = `t${++counter}`;
      const handle: PlayerHandle = {
        id,
        name: 'test',
        send: (m: string) => ws.readyState === ws.OPEN && ws.send(m),
      };
      handles.set(id, handle);
      ws.on('message', (raw) => {
        const msg = Net.decodeClient(raw as Buffer);
        if (msg.t === 'hello') {
          handle.name = msg.name;
          room.addPlayer(handle);
        } else if (msg.t === 'input') {
          room.applyInput(id, msg.input);
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

    client.send(Net.encode({ t: 'hello', name: 'tester' }));

    // Wait for at least 3 snapshots.
    const start = Date.now();
    while (snaps.length < 3 && Date.now() - start < 3000) {
      await sleep(20);
    }

    expect(myId).not.toBeNull();
    expect(snaps.length).toBeGreaterThanOrEqual(3);
    expect(snaps[0]!.players.length).toBe(1);
    expect(snaps[0]!.players[0]!.id).toBe(myId);

    // Ticks should be advancing.
    expect(snaps[snaps.length - 1]!.tick).toBeGreaterThan(snaps[0]!.tick);

    // Send throttle inputs and verify the vehicle moves. Cars now spawn
    // facing +X (along the road), so check overall horizontal displacement
    // rather than a specific axis.
    const p0 = snaps[snaps.length - 1]!.players[0]!.vehicle.position;
    for (let s = 1; s <= 60; s++) {
      client.send(Net.encode({ t: 'input', input: { ...EMPTY_INPUT, seq: s, throttle: 1 } }));
      await sleep(16);
    }
    await sleep(200);
    const last = snaps[snaps.length - 1]!.players[0]!;
    expect(last.lastAckSeq).toBeGreaterThan(0);
    const dx = last.vehicle.position.x - p0.x;
    const dz = last.vehicle.position.z - p0.z;
    expect(Math.hypot(dx, dz)).toBeGreaterThan(0.1);

    client.close();
    await sleep(50);
    wss.close();
    room.stop();
    room.world.dispose();
  }, 15000);

  // Silence unused import warnings from a future TS strictness pass.
  void spawn;
  void (null as unknown as ChildProcess);
});
