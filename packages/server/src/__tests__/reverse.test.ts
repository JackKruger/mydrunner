// Reverse-gear performance tests.
//
// The original tune (gear ratio -1.8) gave a high theoretical reverse
// top end but anaemic acceleration — only ~5 m/s after 10 s of full
// reverse from a stop on flat road. After bumping the reverse ratio
// to -2.5 the truck pulls away in reverse the way it should.
//
// These tests pin the *floor* on reverse responsiveness so a future
// gearbox tweak that quietly nerfs reverse will fail loudly.

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

function speedXZ(v: Physics.VehicleLike): number {
  const s = v.getState();
  return Math.hypot(s.linVel.x, s.linVel.z);
}

function makeRoadWorld(): Physics.World {
  const n = 32;
  const size = 200;
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

describe('reverse acceleration', () => {
  it('reaches at least 5 m/s within 5 s of full reverse from a stop', () => {
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(world, 1); // settle
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: -1 });
    simSeconds(world, 5);
    const speed = speedXZ(v);
    expect(
      speed,
      `reverse speed after 5 s = ${speed.toFixed(2)} m/s; should be ≥ 5 m/s`,
    ).toBeGreaterThanOrEqual(5);
    world.dispose();
  });

  it('covers at least 12 m of ground in 5 s of full reverse from a stop', () => {
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(world, 1);
    const z0 = v.getState().position.z;
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: -1 });
    simSeconds(world, 5);
    const dz = v.getState().position.z - z0;
    expect(
      dz,
      `reverse Δz after 5 s = ${dz.toFixed(2)} m; should be ≤ -12 m (i.e. travelled at least 12 m backward)`,
    ).toBeLessThanOrEqual(-12);
    world.dispose();
  });

  it('top reverse speed exceeds 12 m/s within 10 s of full reverse', () => {
    // Sanity check on the top end: even if the user keeps reversing,
    // the truck should be able to actually MOVE in reverse — not
    // gear-limited to a crawl.
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(world, 1);
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: -1 });
    let peak = 0;
    for (let s = 0; s < 10; s++) {
      simSeconds(world, 1);
      const sp = speedXZ(v);
      if (sp > peak) peak = sp;
    }
    expect(
      peak,
      `peak reverse speed in 10 s = ${peak.toFixed(2)} m/s; should be > 12 m/s`,
    ).toBeGreaterThan(12);
    world.dispose();
  });

  it('reverse acceleration is faster than the previous (-1.8 ratio) tune', () => {
    // Regression bound: 2 s reverse from a stop must clear 2 m/s. The
    // old tune (gear -1.8) only managed ~1.9 m/s in 2 s; the new tune
    // (gear -2.5) hits ~2.25 m/s. Bound is set just above the old tune
    // so accidental reverse-ratio softening is caught.
    const world = makeRoadWorld();
    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(world, 1);
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: -1 });
    simSeconds(world, 2);
    const speed = speedXZ(v);
    expect(
      speed,
      `reverse speed after 2 s = ${speed.toFixed(2)} m/s; should be > 2 m/s`,
    ).toBeGreaterThan(2);
    world.dispose();
  });
});
