import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUTTON_REAR_LOCKER,
  EMPTY_INPUT,
  Physics,
  TUNING,
  createStockBuild,
} from '../index.js';

beforeAll(async () => { await Physics.initRapier(); });

type Mode = 'open' | 'lsd' | 'locked';

function makeSplitWorld(): Physics.World {
  const resolution = 128;
  const size = 80;
  const heights = new Float32Array(resolution * resolution);
  const surfaces = new Uint8Array(resolution * resolution);
  const grade = 0.05;
  for (let z = 0; z < resolution; z++) {
    const worldZ = (z / (resolution - 1) - 0.5) * size;
    for (let x = 0; x < resolution; x++) {
      heights[z * resolution + x] = worldZ * grade;
      surfaces[z * resolution + x] = x < resolution / 2
        ? Physics.Surface.Grass
        : Physics.Surface.Road;
    }
  }
  return new Physics.World({
    terrain: {
      size,
      resolution,
      heights,
      surfaces,
      seed: 7,
      mountain: Physics.mountainFor(size),
      petrolStation: Physics.petrolStationPadFor(size),
      ...Physics.dryWater(resolution),
      bogs: [],
      roads: [],
    },
    obstacles: [],
  });
}

function run(mode: Mode): { progress: number; lowSpin: number; highSpin: number } {
  const originalGrassGrip = TUNING.surfaceFriction.grass;
  TUNING.surfaceFriction.grass = 0.03;
  const world = makeSplitWorld();
  const build = { ...createStockBuild('ridgeback'), rearLocker: true };
  const vehicle = world.spawnVehicle(
    mode,
    { position: { x: 0, y: -20 * 0.05 + 1.6, z: -20 } },
    build,
  ) as Physics.SolidAxleVehicle;
  if (mode === 'lsd') {
    vehicle.geom.spec.differentials.rear.mode = 'lsd';
    vehicle.geom.spec.differentials.rear.torqueBiasRatio = 2.5;
    vehicle.geom.spec.differentials.rear.preloadNm = 40;
  }
  for (let tick = 0; tick < 120; tick++) world.step();
  vehicle.setInput({
    ...EMPTY_INPUT,
    seq: 1,
    transferCase: '2h',
    buttons: mode === 'locked' ? BUTTON_REAR_LOCKER : 0,
  });
  world.step();
  const start = vehicle.getState().position.z;
  let lowSpin = 0;
  let highSpin = 0;
  for (let tick = 0; tick < 6 * 60; tick++) {
    vehicle.setInput({ ...EMPTY_INPUT, seq: tick + 2, throttle: 0.55, transferCase: '2h' });
    world.step();
    const wheels = vehicle.debugTelemetry().wheels;
    lowSpin = Math.max(lowSpin, Math.abs(wheels[2].angularVelocity));
    highSpin = Math.max(highSpin, Math.abs(wheels[3].angularVelocity));
  }
  const progress = vehicle.getState().position.z - start;
  world.dispose();
  TUNING.surfaceFriction.grass = originalGrassGrip;
  return { progress, lowSpin, highSpin };
}

describe('vehicle differential on split friction', () => {
  it('separates open, 2.5:1 LSD, and locked progress over six seconds', () => {
    const open = run('open');
    const lsd = run('lsd');
    const locked = run('locked');
    expect(open.progress).toBeGreaterThan(0);
    expect(Math.max(open.lowSpin, open.highSpin)).toBeGreaterThan(
      Math.min(open.lowSpin, open.highSpin) + 0.25,
    );
    expect(lsd.progress).toBeGreaterThanOrEqual(open.progress + 0.25);
    expect(locked.progress).toBeGreaterThanOrEqual(open.progress + 1);
    expect(locked.progress).toBeGreaterThanOrEqual(lsd.progress + 0.25);
  }, 15_000);
});
