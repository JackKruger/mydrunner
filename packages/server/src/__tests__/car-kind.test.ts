// The relay preserves the owner's selected rig identity. Physics geometry is
// now constructed by LocalSimulation from the same welcome choice.

import { describe, expect, it } from 'vitest';
import { Net, type CarKind } from '@mydrunner/shared';
import { Room } from '../room.js';

describe('per-kind relay identity', () => {
  it.each<CarKind>(['patrol', 'hilux', 'ute', 'motorbike'])('broadcasts %s unchanged', (carKind) => {
    const room = new Room();
    const messages: Net.ServerMessage[] = [];
    room.addPlayer({
      id: 'p', name: 'p', carKind,
      send: (bytes) => messages.push(Net.decodeServer(bytes)),
    });
    room.broadcastSnapshot();
    const snapshot = messages.find((m): m is Extract<Net.ServerMessage, { t: 'snapshot' }> => m.t === 'snapshot')!;
    expect(snapshot.snap.players[0]!.carKind).toBe(carKind);
  });
});
