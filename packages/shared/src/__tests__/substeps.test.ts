// Physics substeps: N force-evaluation + solve passes inside one 60 Hz tick.
//
// The point of running more than one is that the answer should stop
// depending on the step. These tests pin that for the case that exposed the
// last big step-size artefact (deep mud, where sign(v) bulldozing drag used
// to chatter a truck forward at 60 Hz and leave it stuck at 240 Hz), and pin
// that counters written in ticks still mean ticks whatever N is.

import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT, Physics, createStockBuild } from '../index.js';
import { PHYSICS_SUBSTEPS, WATER } from '../constants.js';
import { createEngineState, stepEngineFlooding } from '../physics/engine.js';
import { dryWater, mountainFor, petrolStationPadFor } from '../physics/terrain.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function deepMudProgress(substeps: number, throttle: number): number {
  const n = 64;
  const world = new Physics.World({
    substeps,
    terrain: {
      size: 200, resolution: n, seed: 0,
      heights: new Float32Array(n * n),
      surfaces: new Uint8Array(n * n).fill(Physics.Surface.DeepMud),
      mountain: mountainFor(200),
      petrolStation: petrolStationPadFor(200),
      ...dryWater(n),
      bogs: [],
      roads: [],
    },
  });
  const vehicle = new Physics.SolidAxleVehicle(
    world, 'p', { position: { x: 0, y: 1.5, z: 0 } },
    { ...createStockBuild('ridgeback'), tireId: 'ridgeback.tire.mt-35-wide' },
  );
  world.vehicles.set(vehicle.id, vehicle);
  for (let i = 0; i < 120; i++) world.step();
  const start = vehicle.getState().position.z;
  vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle });
  for (let i = 0; i < 10 * 60; i++) world.step();
  const progress = vehicle.getState().position.z - start;
  world.dispose();
  return progress;
}

describe('physics substeps', () => {
  it('defaults the world to PHYSICS_SUBSTEPS', () => {
    const world = new Physics.World({ generate: { size: 40, resolution: 16 }, obstacles: [] });
    expect(world.substeps).toBe(PHYSICS_SUBSTEPS);
    expect(world.substepDt * world.substeps).toBeCloseTo(1 / 60, 12);
    world.dispose();
  });

  it('gives the same deep-mud crawl at 1, 2 and 4 substeps', () => {
    // Before the drag became a dissipative constraint: 1.72 / 0.45 / 0.14 m.
    const runs = [1, 2, 4].map((substeps) => deepMudProgress(substeps, 0.35));
    const label = runs.map((m) => m.toFixed(3)).join(' / ');
    expect(Math.min(...runs), label).toBeGreaterThan(0.5);
    expect(Math.max(...runs) / Math.min(...runs), label).toBeLessThan(1.25);
  }, 60_000);

  it('keeps tick-denominated counters in ticks', () => {
    for (const substeps of [1, 2, 4]) {
      const engine = createEngineState();
      engine.drowned = true;
      let calls = 0;
      while (engine.drowned && calls < 10_000) {
        stepEngineFlooding(engine, false, false, true, substeps);
        calls++;
      }
      expect(calls / substeps).toBe(WATER.crankTicks);
    }
  });
});
