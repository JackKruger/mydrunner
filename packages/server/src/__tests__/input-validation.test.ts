// Direct-call hardening for owner-state relay. The wire decoder rejects
// malformed tuples first; Room also refuses non-finite or stale updates so
// tests and future call sites cannot poison every peer's snapshot.

import { describe, expect, it } from 'vitest';
import { Net, type VehicleState } from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

function joinedRoom(): { room: Room; messages: Net.ServerMessage[] } {
  const room = new Room();
  const messages: Net.ServerMessage[] = [];
  const handle: PlayerHandle = {
    id: 'p', name: 'p', carKind: 'patrol',
    send: (bytes) => messages.push(Net.decodeServer(bytes)),
  };
  room.addPlayer(handle);
  room.broadcastSnapshot();
  return { room, messages };
}

function latestState(messages: Net.ServerMessage[]): VehicleState {
  const snapshots = messages.filter((m): m is Extract<Net.ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot');
  return snapshots[snapshots.length - 1]!.snap.players[0]!.vehicle;
}

describe('Room.applyVehicleState hardening', () => {
  it('ignores a non-finite owner state', () => {
    const { room, messages } = joinedRoom();
    const before = latestState(messages);
    room.applyVehicleState('p', {
      seq: 1,
      vehicle: { ...before, position: { ...before.position, x: NaN } },
    });
    room.broadcastSnapshot();
    expect(latestState(messages).position.x).toBe(before.position.x);
    room.stop();
  });

  it('accepts increasing sequences and ignores stale or non-integer ones', () => {
    const { room, messages } = joinedRoom();
    const before = latestState(messages);
    room.applyVehicleState('p', {
      seq: Number.NaN,
      vehicle: { ...before, position: { ...before.position, x: 100 } },
    });
    room.applyVehicleState('p', {
      seq: 2,
      vehicle: { ...before, position: { ...before.position, x: 12 } },
    });
    room.applyVehicleState('p', {
      seq: 1,
      vehicle: { ...before, position: { ...before.position, x: 99 } },
    });
    room.broadcastSnapshot();
    const snapshot = messages.filter((m): m is Extract<Net.ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot').at(-1)!;
    expect(snapshot.snap.players[0]!.stateSeq).toBe(2);
    expect(snapshot.snap.players[0]!.vehicle.position.x).toBe(12);
    room.stop();
  });
});
