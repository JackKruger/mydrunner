// Rollover behavior tests. Verifies that a flipped vehicle's chassis
// collider prevents the roof from clipping through the ground.

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

describe('rollover / flipped vehicle', () => {
  it('does not sink below terrain when spawned upside-down', () => {
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p1', { position: { x: 0, y: 3, z: 0 } });

    // 180° around Z axis: {x:0, y:0, z:sin(π/2), w:cos(π/2)} = {0,0,1,0}
    v.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);

    simSeconds(world, 3);

    const y = v.getState().position.y;
    // Terrain is flat at y=0; the vehicle chassis must not penetrate it.
    expect(y, `flipped vehicle y=${y.toFixed(3)}`).toBeGreaterThan(0);
    world.dispose();
  });

  it('roof-spanning collider keeps flipped vehicle significantly above ground', () => {
    // The chassis collider covers chassis-bottom → cabin-roof so when inverted
    // the roof (now at the bottom) acts as the collision surface, keeping the
    // body center at approximately cabinRoofY + chassisHalfY from the ground.
    //   cabinRoofY=1.2, chassisHalfY=0.45 → colHalfH=(1.2+0.45)/2=0.825
    // Body centre ≈ 1.2m above terrain. An old collider sized to chassisHalfY
    // only would settle the body at ≈ 0.45m.
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p1', { position: { x: 0, y: 4, z: 0 } });

    v.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    simSeconds(world, 4);

    const y = v.getState().position.y;
    // With the full roof collider the body settles near ~1.2m, not ~0.45m.
    // Threshold of 0.8 cleanly separates the two cases.
    expect(y, `flipped y=${y.toFixed(3)}`).toBeGreaterThan(0.8);
    world.dispose();
  });

  it('upright vehicle on steep lateral slope does not sink below terrain', () => {
    // Drive onto a rock face / extreme lateral tilt; chassis must not clip.
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p1', { position: { x: 0, y: 2, z: 0 } });

    // 90° roll (one side on the ground): rotation 90° around Z
    const angle = Math.PI / 2;
    v.body.setRotation({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) }, true);
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);

    simSeconds(world, 3);

    const y = v.getState().position.y;
    expect(y, `side-tilted y=${y.toFixed(3)}`).toBeGreaterThan(0);
    world.dispose();
  });
});
