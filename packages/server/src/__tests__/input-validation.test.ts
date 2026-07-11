// Hostile-input hardening. decodeClient is the first line of defense;
// Room.applyInput is defense in depth for the direct-call path. Either
// way, no client-supplied value may reach the physics as NaN/Infinity —
// a single NaN force corrupts the sender's rigid body state.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, type PlayerInput } from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function join(room: Room, id: string): PlayerHandle {
  const handle: PlayerHandle = { id, name: id, carKind: 'patrol', send: () => {} };
  room.addPlayer(handle);
  return handle;
}

function tick(room: Room, n: number): void {
  for (let i = 0; i < n; i++) {
    (room as unknown as { tickOnce(): void }).tickOnce();
  }
}

describe('Room.applyInput hardening', () => {
  it('neutralises NaN / Infinity input fields and keeps the body finite', () => {
    const room = new Room();
    join(room, 'p');
    const hostile: PlayerInput = {
      seq: 1,
      throttle: NaN,
      steer: Infinity,
      brake: -Infinity,
      handbrake: NaN,
      buttons: 0,
    };
    room.applyInput('p', hostile);
    tick(room, 30);
    const t = room.world.vehicles.get('p')!.body.translation();
    expect(Number.isFinite(t.x)).toBe(true);
    expect(Number.isFinite(t.y)).toBe(true);
    expect(Number.isFinite(t.z)).toBe(true);
    room.stop();
    room.world.dispose();
  });

  it('ignores inputs with a non-integer seq instead of muting the player', () => {
    const room = new Room();
    join(room, 'p');
    room.applyInput('p', { seq: NaN, throttle: 1, steer: 0, brake: 0, handbrake: 0, buttons: 0 });
    room.applyInput('p', { seq: 1, throttle: 0.5, steer: 0, brake: 0, handbrake: 0, buttons: 0 });
    tick(room, 60);
    // The valid seq=1 input must still be applied: full throttle for a
    // second moves the truck forward.
    const v = room.world.vehicles.get('p')!.body.linvel();
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(0.1);
    room.stop();
    room.world.dispose();
  });
});
