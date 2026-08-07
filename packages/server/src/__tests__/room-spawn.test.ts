// A joining player receives a spawn, then its first client-owned state
// replaces the room's placeholder and is relayed unchanged.

import { describe, expect, it } from 'vitest';
import { Net } from '@mydrunner/shared';
import { Room } from '../room.js';

describe('room owner-state handoff', () => {
  it('relays the state uploaded after welcome', () => {
    const room = new Room();
    const received: Net.ServerMessage[] = [];
    room.addPlayer({
      id: 'p1', name: 'tester', carKind: 'patrol',
      send: (bytes) => received.push(Net.decodeServer(bytes)),
    });
    room.broadcastSnapshot();
    const initial = received.find((m): m is Extract<Net.ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot')!
      .snap.players[0]!.vehicle;
    const moved = { ...initial, position: { x: initial.position.x + 8, y: 1.2, z: initial.position.z } };
    room.applyVehicleState('p1', { seq: 1, vehicle: moved });
    room.broadcastSnapshot();
    const latest = received.filter((m): m is Extract<Net.ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot').at(-1)!;
    expect(latest.snap.players[0]!.stateSeq).toBe(1);
    expect(latest.snap.players[0]!.vehicle.position).toEqual(moved.position);
    room.stop();
  });
});
