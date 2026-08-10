import { describe, expect, it } from 'vitest';
import { Net, Physics, type VehicleState } from '@mydrunner/shared';
import { Room } from '../room.js';

function surfacePoint(room: Room, wanted: Physics.Surface): { x: number; z: number } {
  const half = room.map.terrain.size * 0.5;
  for (let z = -half + 1; z < half; z += 1) {
    for (let x = -half + 1; x < half; x += 1) {
      if (Physics.sampleSurface(room.map.terrain, x, z) === wanted) return { x, z };
    }
  }
  throw new Error(`map has no ${Physics.surfaceInfo(wanted).label} point`);
}

function addPlayer(room: Room, id: string): { messages: Net.ServerMessage[]; bytes: Uint8Array[] } {
  const messages: Net.ServerMessage[] = [];
  const bytes: Uint8Array[] = [];
  room.addPlayer({
    id, name: id, carKind: 'ridgeback',
    send: (value) => { bytes.push(value); messages.push(Net.decodeServer(value)); },
  });
  return { messages, bytes };
}

function currentState(room: Room, received: Net.ServerMessage[]): VehicleState {
  room.broadcastSnapshot();
  const snapshot = received.find(
    (message): message is Extract<Net.ServerMessage, { t: 'snapshot' }> => message.t === 'snapshot',
  );
  if (!snapshot) throw new Error('missing snapshot');
  return snapshot.snap.players[0]!.vehicle;
}

describe('room-session ruts', () => {
  it('validates owner stamps, assigns global order, and syncs sparse tiles to a late joiner', () => {
    const room = new Room();
    const owner = addPlayer(room, 'owner');
    const initial = currentState(room, owner.messages);
    const road = surfacePoint(room, Physics.Surface.Road);
    const mud = surfacePoint(room, Physics.Surface.Mud);

    room.applyVehicleState('owner', {
      seq: 1,
      vehicle: { ...initial, position: { ...initial.position, ...road } },
    });
    const roadStamp = {
      ownerSequence: 1, ...road, heading: 0,
      radiusLong: 0.8, radiusLat: 0.25, depth: 0.02,
    };
    expect(room.applyRutStamp('owner', roadStamp)).toBe(false);
    expect(room.applyRutStamp('owner', { ...roadStamp, x: road.x + 10 })).toBe(false);

    room.applyVehicleState('owner', {
      seq: 2,
      vehicle: { ...initial, position: { ...initial.position, ...mud } },
    });
    const mudStamp = { ...roadStamp, ...mud };
    expect(room.applyRutStamp('owner', mudStamp)).toBe(true);
    expect(room.applyRutStamp('owner', mudStamp)).toBe(false);
    expect(room.applyRutStamp('owner', { ...mudStamp, ownerSequence: 2 })).toBe(false);

    const results = owner.messages.filter(
      (message): message is Extract<Net.ServerMessage, { t: 'rut-result' }> => message.t === 'rut-result',
    );
    expect(results).toContainEqual({ t: 'rut-result', ownerSequence: 1, accepted: true, globalSequence: 1 });
    expect(results.filter((result) => !result.accepted).length).toBe(4);

    const batch = owner.messages.find(
      (message): message is Extract<Net.ServerMessage, { t: 'rut-batch' }> => message.t === 'rut-batch',
    );
    expect(batch?.stamps[0]).toMatchObject({ ownerId: 'owner', ownerSequence: 1, globalSequence: 1 });

    const joiner = addPlayer(room, 'joiner');
    const start = joiner.messages.find(
      (message): message is Extract<Net.ServerMessage, { t: 'rut-sync-start' }> => message.t === 'rut-sync-start',
    );
    const tiles = joiner.messages.filter(
      (message): message is Extract<Net.ServerMessage, { t: 'rut-tile' }> => message.t === 'rut-tile',
    );
    const end = joiner.messages.find(
      (message): message is Extract<Net.ServerMessage, { t: 'rut-sync-end' }> => message.t === 'rut-sync-end',
    );
    expect(start).toMatchObject({ globalSequence: 1, tileCount: tiles.length });
    expect(tiles.length).toBeGreaterThan(0);
    expect(end).toMatchObject({ globalSequence: 1 });
    expect(joiner.bytes.every((value) => value.byteLength < 4096)).toBe(true);
    room.stop();
  });
});
