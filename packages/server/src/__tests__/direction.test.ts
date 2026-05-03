// Direction-of-travel tests. The user reports that pressing W moves the
// car backward and S either does the same or no clear reverse. These
// tests pin down whether the bug is in the engine sign logic or in
// Rapier's force application.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

const FIXED_DT = 1 / 60;
function simSeconds(world: Physics.World, seconds: number): void {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) world.step();
}

function makeRoadWorld(): Physics.World {
  const n = 32;
  const size = 100;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(Physics.Surface.Road);
  return new Physics.World({
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
}

describe('direction of travel', () => {
  it('throttle=+1 from a stop moves the car along its local +Z (forward)', () => {
    const world = makeRoadWorld();
    // yaw=0 spawn so local +Z = world +Z. No yaw rotation = no ambiguity.
    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(world, 1); // settle

    const z0 = v.getState().position.z;
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    simSeconds(world, 4);
    const z1 = v.getState().position.z;
    const dz = z1 - z0;
    expect(dz, `dz after W = ${dz.toFixed(3)}m`).toBeGreaterThan(1);
    world.dispose();
  });

  it('throttle=-1 from a stop moves the car along its local -Z (backward)', () => {
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(world, 1);

    const z0 = v.getState().position.z;
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: -1 });
    simSeconds(world, 4);
    const z1 = v.getState().position.z;
    const dz = z1 - z0;
    expect(dz, `dz after S = ${dz.toFixed(3)}m`).toBeLessThan(-1);
    world.dispose();
  });

  it('with yaw=pi/2, throttle=+1 moves the car along world +X', () => {
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', {
      position: { x: 0, y: 1.5, z: 0 },
      yaw: Math.PI / 2,
    });
    simSeconds(world, 1);

    const x0 = v.getState().position.x;
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    simSeconds(world, 4);
    const x1 = v.getState().position.x;
    const dx = x1 - x0;
    expect(dx, `dx after W with yaw=pi/2 = ${dx.toFixed(3)}m`).toBeGreaterThan(1);
    world.dispose();
  });

  it('with yaw=pi/2, throttle=-1 moves the car along world -X', () => {
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', {
      position: { x: 0, y: 1.5, z: 0 },
      yaw: Math.PI / 2,
    });
    simSeconds(world, 1);

    const x0 = v.getState().position.x;
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: -1 });
    simSeconds(world, 4);
    const x1 = v.getState().position.x;
    const dx = x1 - x0;
    expect(dx, `dx after S with yaw=pi/2 = ${dx.toFixed(3)}m`).toBeLessThan(-1);
    world.dispose();
  });
});
