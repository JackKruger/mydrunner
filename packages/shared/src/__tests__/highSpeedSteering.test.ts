import { beforeAll, describe, expect, it } from 'vitest';
import { createStockBuild, EMPTY_INPUT, Physics, VEHICLE } from '../index.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function makeInclineWorld(): Physics.World {
  const resolution = 129;
  const size = 128;
  const grade = 0.15;
  const heights = new Float32Array(resolution * resolution);
  const surfaces = new Uint8Array(resolution * resolution);
  surfaces.fill(Physics.Surface.Road);

  for (let row = 0; row < resolution; row++) {
    const z = -size / 2 + row * size / (resolution - 1);
    for (let col = 0; col < resolution; col++) {
      heights[row * resolution + col] = z * grade;
    }
  }

  return new Physics.World({
    terrain: {
      size,
      resolution,
      heights,
      surfaces,
      seed: 0,
      mountain: Physics.mountainFor(size),
      petrolStation: Physics.petrolStationPadFor(size),
      ...Physics.dryWater(resolution),
      bogs: [],
      roads: [],
    },
    obstacles: [],
  });
}

describe('speed-sensitive steering', () => {
  it('keeps full mechanical lock at trail speed and narrows it at road speed', () => {
    const mechanicalLimit = VEHICLE.maxSteer;
    const wheelbase = 2.42;

    expect(Physics.steeringLimitForSpeed(mechanicalLimit, wheelbase, 3))
      .toBe(mechanicalLimit);
    expect(Physics.steeringLimitForSpeed(mechanicalLimit, wheelbase, 20))
      .toBeLessThan(0.04);
  });

  it('keeps a fast uphill keyboard-steer tap below the rollover threshold', () => {
    const world = makeInclineWorld();
    const vehicle = world.spawnVehicle(
      'high-speed-steer',
      { position: { x: 0, y: 1.5, z: 0 } },
      createStockBuild('dustback-rs'),
    );
    for (let i = 0; i < 120; i++) world.step();

    const pitch = Math.atan(0.15);
    vehicle.body.setLinvel({
      x: 0,
      y: Math.sin(pitch) * 20,
      z: Math.cos(pitch) * 20,
    }, true);

    let minUpY = 1;
    let maxSideTilt = 0;
    let maxSteer = 0;
    for (let tick = 0; tick < 60; tick++) {
      vehicle.setInput({
        ...EMPTY_INPUT,
        seq: tick + 1,
        steer: tick < 15 ? 1 : 0,
      });
      world.step();

      const state = vehicle.getState();
      const q = state.rotation;
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      const rightY = 2 * (q.x * q.y + q.w * q.z);
      minUpY = Math.min(minUpY, upY);
      maxSideTilt = Math.max(maxSideTilt, Math.abs(rightY));
      maxSteer = Math.max(maxSteer, Math.abs(state.wheels[0]!.steer));
    }

    expect(maxSteer).toBeLessThan(0.1);
    expect(minUpY).toBeGreaterThan(0.9);
    expect(maxSideTilt).toBeLessThan(0.15);
    world.dispose();
  });
});
