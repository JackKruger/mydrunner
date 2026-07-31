// Spawn-slot allocation.
//
// The slot used to be `players.size % 16`, so any disconnect made the
// next joiner reuse a live slot: A/B/C take 0/1/2, B leaves, size drops
// to 2, and the next player spawns inside C. The 5 m slot spacing in
// nextSpawn() exists specifically to stop trucks spawning inside each
// other (which can push one through the heightfield and trip the off-map
// ejector), and slot reuse defeated it entirely.

import { beforeAll, describe, expect, it } from 'vitest';
import { Physics, type CarKind } from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function handle(id: string, carKind: CarKind = 'patrol'): PlayerHandle {
  return { id, name: id, carKind, send: () => {} };
}

/** Where the room actually put each live player's chassis. */
function spawnPositions(room: Room): Array<{ x: number; z: number }> {
  return [...room.world.vehicles.values()].map((v) => {
    const t = v.body.translation();
    return { x: t.x, z: t.z };
  });
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
    for (let i = 0; i < 8; i++) room.addPlayer(handle(`p${i}`));
    const pts = spawnPositions(room);
    expect(pts).toHaveLength(8);
    // Trucks are 3.8 m long; the grid is on 5 m centres.
    expect(minPairwiseDistance(pts)).toBeGreaterThan(2);
  });

  it('reuses a freed slot without colliding with a live one', () => {
    const room = new Room();
    room.addPlayer(handle('a'));
    room.addPlayer(handle('b'));
    room.addPlayer(handle('c'));
    const cPos = { ...room.world.vehicles.get('c')!.body.translation() };

    room.removePlayer('b');
    room.addPlayer(handle('d'));

    const dPos = room.world.vehicles.get('d')!.body.translation();
    // Pre-fix, d landed exactly on top of c.
    expect(Math.hypot(dPos.x - cPos.x, dPos.z - cPos.z)).toBeGreaterThan(2);
    expect(minPairwiseDistance(spawnPositions(room))).toBeGreaterThan(2);
  });

  it('keeps slots distinct across repeated churn', () => {
    const room = new Room();
    room.addPlayer(handle('keep'));
    for (let i = 0; i < 10; i++) {
      room.addPlayer(handle(`churn${i}`));
      expect(minPairwiseDistance(spawnPositions(room))).toBeGreaterThan(2);
      room.removePlayer(`churn${i}`);
    }
    expect(room.playerCount).toBe(1);
  });
});
