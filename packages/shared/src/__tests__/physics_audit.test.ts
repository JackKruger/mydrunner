import { describe, it, expect, beforeAll } from 'vitest';
import {
  Physics,
  EMPTY_INPUT,
  createStockBuild,
  type PlayerInput,
  type VehicleBuild,
} from '../index.js';
import { mountainFor, petrolStationPadFor,
  dryWater,
} from '../physics/terrain.js';

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
    ...dryWater(n),
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

function makePlanarSlopeWorld(
  slopeDeg: number,
  surface: Physics.Surface,
  yaw = 0,
  build: VehicleBuild | 'patrol' = 'patrol',
) {
  const n = 64;
  const size = 100;
  const grade = Math.tan(slopeDeg * Math.PI / 180);
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(surface);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = (col / (n - 1) - 0.5) * size;
      heights[row * n + col] = x * grade;
    }
  }
  const terrainData: Physics.TerrainData = {
    size, resolution: n, heights, surfaces, seed: 0,
    mountain: mountainFor(size),
    petrolStation: petrolStationPadFor(size),
    ...dryWater(n),
    bogs: [],
    roads: [],
  };
  const world = new Physics.World({ terrain: terrainData, obstacles: [] });
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'slope',
    { position: { x: 0, y: 1.5, z: 0 }, yaw },
    build,
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

  it('holds a stationary tyre across mirrored road slopes', () => {
    const driftOn = (slopeDeg: number): number => {
      const { world, vehicle } = makePlanarSlopeWorld(
        slopeDeg,
        Physics.Surface.Road,
      );
      settle(world, 300);
      const start = vehicle.getState().position.x;
      settle(world, 300);
      const drift = vehicle.getState().position.x - start;
      world.dispose();
      return drift;
    };

    const uphillRight = driftOn(15);
    const uphillLeft = driftOn(-15);
    expect(Math.abs(uphillRight)).toBeLessThan(0.01);
    expect(Math.abs(uphillLeft)).toBeLessThan(0.01);
    expect(Math.abs(Math.abs(uphillRight) - Math.abs(uphillLeft))).toBeLessThan(0.005);
  });

  it('holds representative light, heavy, narrow, and wide builds', () => {
    const buildIds = ['overlander', 'outclaw', 'dustback-rs'] as const;
    for (const id of buildIds) {
      const { world, vehicle } = makePlanarSlopeWorld(
        12,
        Physics.Surface.Road,
        0,
        createStockBuild(id),
      );
      settle(world, 480);
      const start = { ...vehicle.getState().position };
      settle(world, 300);
      const end = vehicle.getState().position;
      const dx = end.x - start.x;
      const dz = end.z - start.z;
      expect(
        Math.abs(dx),
        `${id} lateral drift (dx=${dx}, longitudinal dz=${dz})`,
      ).toBeLessThan(0.015);
      world.dispose();
    }
  });

  it('still slides laterally when a deep-mud slope exceeds available grip', () => {
    const { world, vehicle } = makePlanarSlopeWorld(15, Physics.Surface.DeepMud);
    settle(world, 180);
    const start = vehicle.getState().position.x;
    settle(world, 180);
    expect(start - vehicle.getState().position.x).toBeGreaterThan(0.1);
    world.dispose();
  });

  it('still rolls longitudinally downhill without a brake', () => {
    const { world, vehicle } = makePlanarSlopeWorld(
      15,
      Physics.Surface.Road,
      Math.PI / 2,
    );
    settle(world, 60);
    const start = vehicle.getState().position.x;
    settle(world, 180);
    expect(start - vehicle.getState().position.x).toBeGreaterThan(0.1);
    world.dispose();
  });

  it('holds longitudinally and laterally with the foot brake applied', () => {
    const { world, vehicle } = makePlanarSlopeWorld(
      15,
      Physics.Surface.Road,
      Math.PI / 4,
    );
    vehicle.setInput({ ...EMPTY_INPUT, brake: 1 });
    settle(world, 300);
    const start = { ...vehicle.getState().position };
    settle(world, 300);
    const end = vehicle.getState().position;
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(0.02);
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
      ...dryWater(n),
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

    const state0 = vehicle.getState();
    const restRideY = state0.axles![0].rideY;

    // Lift the car into the air
    const pos = vehicle.body.translation();
    vehicle.body.setTranslation({ x: pos.x, y: pos.y + 2.0, z: pos.z }, true);

    // The first step starts the unsprung axle moving toward droop without
    // teleporting the wheel assembly there in one rendered frame.
    world.step();

    const state1 = vehicle.getState();
    const firstAirRideY = state1.axles![0].rideY;
    expect(firstAirRideY).toBeLessThan(restRideY);

    for (let i = 0; i < 30; i++) world.step();
    const airRideY = vehicle.getState().axles![0].rideY;
    expect(airRideY).toBeLessThan(0);
    expect(airRideY).toBeLessThan(firstAirRideY);

    world.dispose();
  });
});

describe('physics audit: rolling resistance', () => {
  it('slows down faster on mud than on road when coasting', () => {
    const road = makeWorld(Physics.Surface.Road);
    const mud = makeWorld(Physics.Surface.Mud);

    settle(road.world, 60);
    settle(mud.world, 60);

    // Establish comparable rolling states with controlled throttle. Full
    // throttle is intentionally a poor launch strategy in mud now: it spins
    // and digs instead of being a useful way to seed a coasting test.
    for (let i = 0; i < 120; i++) {
        road.vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 0.35 });
        mud.vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 0.35 });
        road.world.step();
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
    it('slows down meaningfully when throttle is released in gear', () => {
        // Off-throttle coasting in gear should bleed speed via engine
        // braking + tyre rolling resistance, not just sit at the
        // accelerated speed forever. Threshold is intentionally loose:
        // earlier this test required > 15% loss over 2 s, but that
        // bound was only achievable when the chassis carried a
        // phantom Rapier linearDamping of 0.1 (≈ 9.5 %/s velocity
        // bleed unrelated to physical drag). With realistic damping
        // (0.02) a heavy truck off-throttle in 2nd gear loses ~10%
        // over 2 s — measurable, but not 15%.
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

        // Want at least 5% bleed over 2s of in-gear coast — confirms
        // engine braking is doing actual work, without baking in
        // phantom-damping numbers.
        expect(vEnd).toBeLessThan(vStart * 0.95);
        // And ≥ 0.5 m/s absolute loss so the test isn't trivially
        // satisfied by very-low-speed scenarios where 5% is tiny.
        expect(vStart - vEnd).toBeGreaterThan(0.5);
        world.dispose();
    });
});
