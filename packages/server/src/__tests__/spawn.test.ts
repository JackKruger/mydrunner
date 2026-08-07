// Spawn-slot allocation remains server-owned even though vehicle physics is
// not. Welcome poses must stay distinct across joins, leaves and churn.

import { describe, expect, it } from 'vitest';
import { Net, type CarKind } from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

function join(room: Room, id: string, positions: Map<string, { x: number; z: number }>, carKind: CarKind = 'patrol'): void {
  const handle: PlayerHandle = {
    id, name: id, carKind,
    send: (bytes) => {
      const msg = Net.decodeServer(bytes);
      if (msg.t === 'welcome') positions.set(id, { x: msg.spawn.position.x, z: msg.spawn.position.z });
    },
  };
  room.addPlayer(handle);
}

function minPairwiseDistance(pts: Array<{ x: number; z: number }>): number {
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      min = Math.min(min, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.z - pts[j]!.z));
    }
  }
  return min;
}

describe('spawn slots', () => {
  it('gives every concurrent player a distinct spawn', () => {
    const room = new Room();
    const positions = new Map<string, { x: number; z: number }>();
    for (let i = 0; i < 8; i++) join(room, `p${i}`, positions);
    expect(positions.size).toBe(8);
    expect(minPairwiseDistance([...positions.values()])).toBeGreaterThan(2);
  });

  it('reuses a freed slot without colliding with a live one', () => {
    const room = new Room();
    const positions = new Map<string, { x: number; z: number }>();
    join(room, 'a', positions);
    join(room, 'b', positions);
    join(room, 'c', positions);
    const cPos = positions.get('c')!;
    room.removePlayer('b');
    positions.delete('b');
    join(room, 'd', positions);
    const dPos = positions.get('d')!;
    expect(Math.hypot(dPos.x - cPos.x, dPos.z - cPos.z)).toBeGreaterThan(2);
    expect(minPairwiseDistance([...positions.values()])).toBeGreaterThan(2);
  });

  it('keeps slots distinct across repeated churn', () => {
    const room = new Room();
    const positions = new Map<string, { x: number; z: number }>();
    join(room, 'keep', positions);
    for (let i = 0; i < 10; i++) {
      const id = `churn${i}`;
      join(room, id, positions);
      expect(minPairwiseDistance([...positions.values()])).toBeGreaterThan(2);
      room.removePlayer(id);
      positions.delete(id);
    }
    expect(room.playerCount).toBe(1);
  });
});
