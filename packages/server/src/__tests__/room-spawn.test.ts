// Reproduces the playwright scenario: add a player to a Room, run for a
// few seconds with throttle held, and verify the vehicle ends up upright
// on the road instead of underground.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT } from '@mydrunner/shared';
import { Room } from '../room.js';

beforeAll(async () => {
  await Physics.initRapier();
});

describe('room spawn behavior', () => {
  it('first player settles on the road, upright', () => {
    const room = new Room();
    const sent: Uint8Array[] = [];
    const handle = {
      id: 'p1',
      name: 'tester',
      carKind: 'patrol' as const,
      send: (m: Uint8Array) => sent.push(m),
    };
    room.addPlayer(handle);
    // Drive forward.
    for (let s = 1; s <= 240; s++) {
      room.applyInput('p1', { ...EMPTY_INPUT, seq: s, throttle: 1 });
      // Manually tick the room one step.
      // tickOnce is private; use the public start/stop loop... but that
      // uses real time. For tests, step the world directly via the room's
      // exposed world.
      room.world.step();
    }
    const v = room.world.vehicles.get('p1')!;
    const s = v.getState();
    expect(s.position.y, `final y was ${s.position.y}`).toBeGreaterThan(0);
    expect(s.position.y).toBeLessThan(2);
    expect(Math.abs(s.rotation.w)).toBeGreaterThan(0.5);
    room.stop();
    room.world.dispose();
  });
});
