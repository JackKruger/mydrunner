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

describe('physics audit: side slope and progression', () => {
  it('can make progress when horizontal on a slope', () => {
    // Create a world with a significant slope (e.g. 20%)
    const n = 64;
    const heights = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        // Slope in X direction: 0.2m per metre
        const x = (c / (n - 1) - 0.5) * 200;
        heights[r * n + c] = x * 0.2;
      }
    }
    const surfaces = new Uint8Array(n * n);
    surfaces.fill(Physics.Surface.Dirt);
    const terrainData: Physics.TerrainData = {
      size: 200, resolution: n, heights, surfaces, seed: 0,
      mountain: mountainFor(200),
      petrolStation: petrolStationPadFor(200),
      bogs: [],
      roads: [],
    };
    const world = new Physics.World({ terrain: terrainData });
    // Spawn vehicle perpendicular to slope (facing along Z)
    const vehicle = new Physics.SolidAxleVehicle(
      world,
      'p',
      { position: { x: 0, y: 5, z: 0 } },
      'patrol',
    );
    world.vehicles.set(vehicle.id, vehicle);

    settle(world, 180); // settle on slope

    const startZ = vehicle.getState().position.z;

    // Apply throttle
    for (let i = 0; i < 180; i++) {
        vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1 });
        world.step();
    }

    const endZ = vehicle.getState().position.z;
    // Should have moved forward significantly despite being on a slope
    expect(endZ - startZ).toBeGreaterThan(1.0);
    world.dispose();
  });
});

describe('physics audit: suspension droop', () => {
  it('extends wheels when the chassis is lifted', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 120);

    const restRideY = vehicle.getState().axles[0].rideY;

    // Lift the car into the air
    const pos = vehicle.body.translation();
    vehicle.body.setTranslation({ x: pos.x, y: pos.y + 2.0, z: pos.z }, true);

    // Step once to update raycasts and axle state
    world.step();

    const airRideY = vehicle.getState().axles[0].rideY;
    // rideY should be negative (droop) in the air
    expect(airRideY).toBeLessThan(0);
    expect(airRideY).toBeLessThan(restRideY);

    world.dispose();
  });
});

describe('physics audit: rolling resistance', () => {
  it('slows down faster on mud than on road when coasting', () => {
    const road = makeWorld(Physics.Surface.Road);
    const mud = makeWorld(Physics.Surface.Mud);

    settle(road.world, 60);
    settle(mud.world, 60);

    for (let i = 0; i < 60; i++) {
        road.vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1 });
        road.world.step();
    }
    for (let i = 0; i < 120; i++) {
        mud.vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1 });
        mud.world.step();
    }

    const vRoadStart = Math.hypot(road.vehicle.body.linvel().x, road.vehicle.body.linvel().z);
    const vMudStart = Math.hypot(mud.vehicle.body.linvel().x, mud.vehicle.body.linvel().z);

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

    expect(mudRatio).toBeLessThan(roadRatio);

    road.world.dispose();
    mud.world.dispose();
  });
});

describe('physics audit: engine braking', () => {
    it('slows down significantly when throttle is released in gear', () => {
        const { world, vehicle } = makeWorld();
        settle(world, 60);

        for (let i = 0; i < 200; i++) {
            vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1 });
            world.step();
        }

        const vStart = Math.hypot(vehicle.body.linvel().x, vehicle.body.linvel().z);

        for (let i = 0; i < 120; i++) {
            vehicle.setInput(EMPTY_INPUT);
            world.step();
        }

        const vEnd = Math.hypot(vehicle.body.linvel().x, vehicle.body.linvel().z);

        expect(vEnd).toBeLessThan(vStart * 0.85);
        world.dispose();
    });
});
