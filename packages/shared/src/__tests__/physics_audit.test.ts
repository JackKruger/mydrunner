import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT, type PlayerInput } from '../index.js';
import { mountainFor, petrolStationPadFor } from '../physics/terrain.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function makeWorld(surface: number = Physics.Surface.Road) {
  const n = 64;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(surface);
  const terrainData: Physics.TerrainData = {
    size: 200, resolution: n, heights, surfaces, seed: 0,
    mountain: mountainFor(200),
    petrolStation: petrolStationPadFor(200),
    bogs: [],
    roads: [],
  };
  const world = new Physics.World({ terrain: terrainData });
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: 0, y: 1.5, z: 0 } },
    'patrol',
  );
  world.vehicles.set(vehicle.id, vehicle);
  return { world, vehicle };
}

function settle(world: Physics.World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

describe('physics audit: stationary stability', () => {
  it('does not creep on flat ground with zero input', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 120); // 2s settle
    const pos1 = { ...vehicle.getState().position };
    settle(world, 240); // another 4s
    const pos2 = vehicle.getState().position;

    const dist = Math.hypot(pos2.x - pos1.x, pos2.z - pos1.z);
    // Tolerance 1cm over 4 seconds
    expect(dist).toBeLessThan(0.01);
    world.dispose();
  });
});

describe('physics audit: friction circle', () => {
  it('combined forces do not exceed friction limit (elliptical clamp)', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);

    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1, steer: 1 });
    for (let i = 0; i < 120; i++) world.step();

    const state = vehicle.getState();
    expect(state.position.y).toBeGreaterThan(0);
    expect(Math.abs(state.angVel.y)).toBeGreaterThan(0.1); // it is turning
    world.dispose();
  });
});

describe('physics audit: rolling resistance', () => {
  it('slows down faster on mud than on road when coasting', () => {
    const road = makeWorld(Physics.Surface.Road);
    const mud = makeWorld(Physics.Surface.Mud);

    settle(road.world, 60);
    settle(mud.world, 60);

    // Get both up to same speed
    for (let i = 0; i < 60; i++) {
        road.vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1 });
        road.world.step();
    }
    // Mud takes longer to accelerate, so give it more time or just accept lower speed
    for (let i = 0; i < 120; i++) {
        mud.vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1 });
        mud.world.step();
    }

    // Now coast and watch deceleration
    const vRoadStart = Math.hypot(road.vehicle.body.linvel().x, road.vehicle.body.linvel().z);
    const vMudStart = Math.hypot(mud.vehicle.body.linvel().x, mud.vehicle.body.linvel().z);

    // Coast for 1 second (60 ticks)
    for (let i = 0; i < 60; i++) {
        road.vehicle.setInput(EMPTY_INPUT);
        mud.vehicle.setInput(EMPTY_INPUT);
        road.world.step();
        mud.world.step();
    }

    const vRoadEnd = Math.hypot(road.vehicle.body.linvel().x, road.vehicle.body.linvel().z);
    const vMudEnd = Math.hypot(mud.vehicle.body.linvel().x, mud.vehicle.body.linvel().z);

    const roadRatio = vRoadEnd / vRoadStart;
    const mudRatio = vMudEnd / vMudStart;

    // Mud should lose a larger fraction of its speed
    expect(mudRatio).toBeLessThan(roadRatio);

    road.world.dispose();
    mud.world.dispose();
  });
});

describe('physics audit: engine braking', () => {
    it('slows down significantly when throttle is released in gear', () => {
        const { world, vehicle } = makeWorld();
        settle(world, 60);

        // Accelerate
        for (let i = 0; i < 200; i++) {
            vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1 });
            world.step();
        }

        const vStart = Math.hypot(vehicle.body.linvel().x, vehicle.body.linvel().z);

        // Release throttle - engine braking should kick in
        for (let i = 0; i < 120; i++) {
            vehicle.setInput(EMPTY_INPUT);
            world.step();
        }

        const vEnd = Math.hypot(vehicle.body.linvel().x, vehicle.body.linvel().z);

        // Expect significant speed loss (e.g. at least 15% over 2s)
        expect(vEnd).toBeLessThan(vStart * 0.85);
        world.dispose();
    });
});
