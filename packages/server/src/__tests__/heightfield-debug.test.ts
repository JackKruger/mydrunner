// Debug: drop a vehicle on a known-flat heightfield at the spawn coords
// the room would use, and check it actually settles on top.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, FIXED_DT, EMPTY_INPUT } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

describe('heightfield orientation', () => {
  it('vehicle settles on top of an all-zero heightfield at room-spawn coords', () => {
    const n = 64;
    const size = 200;
    const heights = new Float32Array(n * n); // all zeros
    const surfaces = new Uint8Array(n * n);
    surfaces.fill(Physics.Surface.Road);
    const world = new Physics.World({
      terrain: {
        size,
        resolution: n,
        heights,
        surfaces,
        seed: 0,
        mountain: Physics.mountainFor(size),
        petrolStation: Physics.petrolStationPadFor(size),
        bogs: [],
        roads: [],
      },
    });
    // Same spawn pose Room uses for the first player.
    const v = world.spawnVehicle('p', {
      position: { x: -14, y: 1.5, z: -1.2 },
      yaw: Math.PI / 2,
    });
    for (let i = 0; i < 240; i++) world.step();
    const s = v.getState();
    // On a flat plane at y=0, the chassis should settle around chassis
    // half-extent + suspension compression - so somewhere near y=0.5.
    expect(s.position.y).toBeGreaterThan(0);
    expect(s.position.y).toBeLessThan(1.5);
    // Should not have tipped over - quaternion w near cos(pi/4) ~ 0.707.
    expect(Math.abs(s.rotation.w)).toBeGreaterThan(0.6);
    world.dispose();
    void FIXED_DT;
  });
});
