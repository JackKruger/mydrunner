// Driving a car through mud carves ruts: the heightmap below the wheels
// becomes lower than its initial value. This is the headline MudRunner
// mechanic - if it regresses, the game stops being a mud game.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, FIXED_DT, EMPTY_INPUT } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

describe('rut formation', () => {
  it('driving on deep mud lowers the heightmap below initial', () => {
    // All-deep-mud world, flat terrain.
    const n = 32;
    const size = 60;
    const heights = new Float32Array(n * n);
    const surfaces = new Uint8Array(n * n);
    surfaces.fill(Physics.Surface.DeepMud);
    const initial = new Float32Array(heights); // copy

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
    const ruts = new Physics.RutBuffer(world.terrain);

    const vehicle = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: -10 } });

    // Settle.
    for (let i = 0; i < 60; i++) world.step();

    // Drive forward at full throttle for a few seconds while accumulating
    // rut samples each tick.
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    for (let i = 0; i < 240; i++) {
      world.step();
      for (const w of vehicle.wheelSamples()) {
        ruts.recordWheel(w.x, w.z, w.slip, w.contact);
      }
    }

    const deltas = ruts.flush();
    expect(deltas.length).toBeGreaterThan(0);
    // At least one cell along the path lowered below initial.
    let maxDrop = 0;
    for (const d of deltas) {
      if (d.dy > maxDrop) maxDrop = d.dy;
    }
    expect(maxDrop).toBeGreaterThan(0.01);

    // And the underlying heights array reflects it.
    let anyLowered = false;
    for (let i = 0; i < heights.length; i++) {
      if ((heights[i] ?? 0) < (initial[i] ?? 0) - 1e-4) {
        anyLowered = true;
        break;
      }
    }
    expect(anyLowered).toBe(true);

    world.dispose();
    void FIXED_DT;
  });

  it('driving on road does not carve ruts', () => {
    const n = 32;
    const size = 60;
    const heights = new Float32Array(n * n);
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
    const ruts = new Physics.RutBuffer(world.terrain);
    const vehicle = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: -10 } });

    for (let i = 0; i < 60; i++) world.step();

    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    for (let i = 0; i < 240; i++) {
      world.step();
      for (const w of vehicle.wheelSamples()) {
        ruts.recordWheel(w.x, w.z, w.slip, w.contact);
      }
    }

    const deltas = ruts.flush();
    expect(deltas).toEqual([]);
    world.dispose();
  });
});
