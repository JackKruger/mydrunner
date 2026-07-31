// Surface-dependent rolling resistance.
//
// WHEEL.rollingResistance is a viscous drag torque (N*m per rad/s of
// wheel speed) that WHEEL.rollingMultMud / rollingMultDeepMud scale up on
// soft ground. The constant's comment promises that "mud drags far more
// than hardpack", but at the shipped 0.010 the torque was ~0.2 N*m at
// 20 rad/s against per-wheel drive torques in the thousands - about 0.1%,
// i.e. nothing. All of deep mud's resistance actually came from
// surfaceFriction.deepMud, and the three rolling constants were inert.
//
// These tests pin the property the constants claim: coasting off-throttle
// through a bog must bleed speed faster than coasting on tarmac.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT } from '../index.js';
import { mountainFor, petrolStationPadFor } from '../physics/terrain.js';

beforeAll(async () => {
  await Physics.initRapier();
});

const FIXED_DT = 1 / 60;

function makeWorld(surface: number) {
  const n = 64;
  const size = 400; // long enough to coast down without leaving the map
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(surface);
  const terrain: Physics.TerrainData = {
    size, resolution: n, heights, surfaces, seed: 0,
    mountain: mountainFor(size),
    petrolStation: petrolStationPadFor(size),
    bogs: [],
    roads: [],
  };
  const world = new Physics.World({ terrain });
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: 0, y: 1.5, z: 0 } },
    'patrol',
  );
  world.vehicles.set(vehicle.id, vehicle);
  return { world, vehicle };
}

function speedXZ(v: Physics.VehicleLike): number {
  const s = v.getState();
  return Math.hypot(s.linVel.x, s.linVel.z);
}

/** Bring a truck up to `target` m/s on road, then coast it off-throttle
 *  on `surface` and report how much speed it kept after `coastSeconds`.
 *
 *  The launch always happens on road so the two runs start from the same
 *  speed - accelerating in a bog would confound "reaches the target more
 *  slowly" with "coasts down faster". The surface is swapped in place
 *  once the truck is up to speed. */
function coastFrom(surface: number, target: number, coastSeconds: number): number {
  const { world, vehicle } = makeWorld(Physics.Surface.Road);
  for (let i = 0; i < 60; i++) world.step(); // settle
  vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
  for (let i = 0; i < 20 * 60; i++) {
    world.step();
    if (speedXZ(vehicle) >= target) break;
  }
  world.terrain.surfaces.fill(surface);
  vehicle.setInput({ ...EMPTY_INPUT, seq: 2 }); // coast
  for (let i = 0; i < Math.round(coastSeconds / FIXED_DT); i++) world.step();
  const remaining = speedXZ(vehicle);
  world.dispose();
  return remaining;
}

describe('rolling resistance by surface', () => {
  it('bleeds speed faster coasting in deep mud than on road', () => {
    const road = coastFrom(Physics.Surface.Road, 10, 3);
    const deepMud = coastFrom(Physics.Surface.DeepMud, 10, 3);
    expect(
      deepMud,
      `after 3 s coasting from 10 m/s: road kept ${road.toFixed(2)} m/s, ` +
        `deep mud kept ${deepMud.toFixed(2)} m/s — deep mud must bleed off clearly faster`,
    ).toBeLessThan(road - 1.5);
  });

  it('orders road, mud and deep mud by drag', () => {
    const road = coastFrom(Physics.Surface.Road, 10, 3);
    const mud = coastFrom(Physics.Surface.Mud, 10, 3);
    const deepMud = coastFrom(Physics.Surface.DeepMud, 10, 3);
    expect(mud).toBeLessThan(road);
    expect(deepMud).toBeLessThan(mud);
  });

  it('still lets the truck coast a meaningful distance on road', () => {
    // The counterweight to the assertions above: road coasting must not
    // feel like dragging an anchor. Off-throttle from 10 m/s the truck
    // should still be rolling after 3 s.
    const road = coastFrom(Physics.Surface.Road, 10, 3);
    expect(road).toBeGreaterThan(3);
  });
});
