// The relay preserves the owner's selected rig identity. Physics geometry is
// now constructed by LocalSimulation from the same welcome choice.

import { describe, expect, it } from 'vitest';
import { Net, VEHICLE_BASE_IDS, createStockBuild, type VehicleBaseId } from '@mydrunner/shared';
import { Room } from '../room.js';

describe('complete build relay identity', () => {
  it.each<VehicleBaseId>([...VEHICLE_BASE_IDS])('broadcasts %s unchanged', (baseId) => {
    const room = new Room();
    const messages: Net.ServerMessage[] = [];
    room.addPlayer({
      id: 'p', name: 'p', build: createStockBuild(baseId),
      send: (bytes) => messages.push(Net.decodeServer(bytes)),
    });
    room.broadcastSnapshot();
    const snapshot = messages.find((m): m is Extract<Net.ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot')!;
    expect(snapshot.snap.players[0]!.build).toEqual(createStockBuild(baseId));
  });
});
