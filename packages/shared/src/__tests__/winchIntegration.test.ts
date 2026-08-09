import { beforeAll, describe, expect, it } from 'vitest';
import { Physics, WINCH, createStockBuild } from '../index.js';
import { dryWater, mountainFor, petrolStationPadFor } from '../physics/terrain.js';

beforeAll(async () => {
  await Physics.initRapier();
});

describe('winch vehicle integration', () => {
  it('pulls a resting vehicle toward a static anchor through queued point loads', () => {
    const n = 64;
    const surfaces = new Uint8Array(n * n);
    surfaces.fill(Physics.Surface.Road);
    const terrain: Physics.TerrainData = {
      size: 200, resolution: n, heights: new Float32Array(n * n),
      surfaces, seed: 1, mountain: mountainFor(200),
      petrolStation: petrolStationPadFor(200), ...dryWater(n), bogs: [], roads: [],
    };
    const world = new Physics.World({ terrain, obstacles: [] });
    const build = createStockBuild('ridgeback');
    const vehicle = world.spawnVehicle('local', { position: { x: 0, y: 1.5, z: 0 } }, build);
    for (let i = 0; i < 240; i++) world.step();
    const startZ = vehicle.getState().position.z;
    const target = { position: { x: 0, y: 1, z: 20 }, velocity: { x: 0, y: 0, z: 0 } };
    for (let i = 0; i < 120; i++) {
      const state = vehicle.getState();
      const local = Physics.geomFor(build).recoveryPoints.fairlead;
      const source = {
        position: Physics.transformPoint(local, state.position, state.rotation),
        velocity: Physics.pointVelocity(local, state.rotation, state.linVel, state.angVel),
      };
      const result = Physics.computeWinchForce(source, target, 17);
      vehicle.queueExternalPointLoad({
        point: source.position,
        force: {
          x: result.direction.x * result.tension,
          y: result.direction.y * result.tension,
          z: result.direction.z * result.tension,
        },
      });
      world.step();
    }
    expect(vehicle.getState().position.z).toBeGreaterThan(startZ + 0.5);
    expect(WINCH.ratedPull).toBeLessThan(WINCH.breakForce);
    world.dispose();
  });
});
