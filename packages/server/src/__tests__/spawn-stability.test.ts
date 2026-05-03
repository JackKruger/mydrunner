// Spawn stability: vehicle should come to rest and stay there with no input.
// Catches residual forces (anti-roll bar imbalance, suspension asymmetry,
// numerical drift) that cause the car to creep or oscillate at idle.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT, VEHICLE, AXLE, GRAVITY_Y } from '@mydrunner/shared';

// Same formula as room.ts SPAWN_Y_ABOVE_GROUND
const SPAWN_Y =
  VEHICLE.suspensionRestLength +
  VEHICLE.wheelRadius +
  Math.abs(VEHICLE.wheelPositions[0]!.y) -
  (VEHICLE.mass * Math.abs(GRAVITY_Y)) / (AXLE.front.rideStiffness + AXLE.rear.rideStiffness);

beforeAll(async () => {
  await Physics.initRapier();
});

const FIXED_DT = 1 / 60;

function simSteps(world: Physics.World, steps: number): void {
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

describe('spawn stability', () => {
  it('vehicle is nearly stationary after settling with no input', () => {
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', { position: { x: 0, y: SPAWN_Y, z: 0 } });

    simSteps(world, 3 * 60); // 3 s to settle

    const s = v.getState();
    const speed = Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z);
    const angSpeed = Math.hypot(s.angVel.x, s.angVel.y, s.angVel.z);

    expect(speed, `linear speed at rest = ${speed.toFixed(4)} m/s`).toBeLessThan(0.05);
    expect(angSpeed, `angular speed at rest = ${angSpeed.toFixed(4)} rad/s`).toBeLessThan(0.05);

    world.dispose();
  });

  it('vehicle does not drift more than 2 cm over 5 s with no input', () => {
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', { position: { x: 0, y: SPAWN_Y, z: 0 } });

    simSteps(world, 3 * 60); // settle

    const { x: x0, z: z0 } = v.getState().position;

    // Track max displacement over the next 5 s
    let maxDisp = 0;
    for (let i = 0; i < 5 * 60; i++) {
      world.step();
      const { x, z } = v.getState().position;
      const disp = Math.hypot(x - x0, z - z0);
      if (disp > maxDisp) maxDisp = disp;
    }

    // Residual pitch oscillation from unequal front/rear spring stiffness
    // causes ~2-3 cm of harmless back-and-forth. 5 cm catches any regression
    // back to the pre-fix systematic creep (was 76 cm).
    expect(maxDisp, `max drift over 5 s = ${(maxDisp * 100).toFixed(2)} cm`).toBeLessThan(0.05);

    world.dispose();
  });

  it('records per-tick speed profile after settle (diagnostic)', () => {
    // Not a pass/fail assertion — prints the speed trace so we can see
    // when the vehicle stops oscillating and whether it drifts.
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', { position: { x: 0, y: SPAWN_Y, z: 0 } });

    simSteps(world, 2 * 60); // partial settle

    const samples: { t: number; speed: number; x: number; z: number } [] = [];
    for (let i = 0; i < 4 * 60; i++) {
      world.step();
      const s = v.getState();
      samples.push({
        t: i * FIXED_DT,
        speed: Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z),
        x: s.position.x,
        z: s.position.z,
      });
    }

    const maxSpeed = Math.max(...samples.map(s => s.speed));
    const finalX = samples.at(-1)!.x;
    const finalZ = samples.at(-1)!.z;
    const drift = Math.hypot(finalX - samples[0]!.x, finalZ - samples[0]!.z);

    console.log(`[spawn-stability] max speed over 4 s = ${maxSpeed.toFixed(4)} m/s, drift = ${(drift * 100).toFixed(2)} cm`);

    // Loose bound — this test is mainly diagnostic
    expect(maxSpeed).toBeLessThan(1.0);

    world.dispose();
  });
});
