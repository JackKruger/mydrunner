// Stopping-distance tests for the brake pedal.
//
// Before the wheel-spin-clamp fix in physics/wheelDynamics.ts, a strong
// brake torque would flip the wheel's angular-velocity sign in a single
// tick, then flip it back the next tick. The friction circle saw
// alternating signed slip, which mostly cancelled itself, so the truck
// took ~38 m to stop from 12 m/s with full brake — far longer than any
// player would expect for a hard pedal stop.
//
// With the clamp + the bumped brakeForce, full brake from 12 m/s now
// stops in roughly 18 m / 6 s. These tests pin the floor on that
// behaviour so the brakes can't silently regress.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

const FIXED_DT = 1 / 60;

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

/** Spawn, settle, accelerate to ~targetSpeed m/s, return the world+vehicle
 *  positioned for a brake test along with the start position. */
function setupAtSpeed(targetSpeed: number): {
  world: Physics.World;
  v: Physics.VehicleLike;
  startSpeed: number;
  startZ: number;
} {
  const world = makeRoadWorld();
  const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
  for (let i = 0; i < 60; i++) world.step(); // settle
  v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
  // Accelerate up to target speed (cap at 20 s to avoid infinite loops).
  const maxAccelSteps = 20 * 60;
  for (let i = 0; i < maxAccelSteps; i++) {
    world.step();
    if (speedXZ(v) >= targetSpeed) break;
  }
  return { world, v, startSpeed: speedXZ(v), startZ: v.getState().position.z };
}

describe('brake stopping distance', () => {
  it('stops within 25 m from 12 m/s under full brake', () => {
    // Pre-fix baseline: ~38 m and didn't actually stop within 10 s.
    // Post-fix (clamp + brakeForce 4500): ~18 m / ~6 s.
    const { world, v, startSpeed, startZ } = setupAtSpeed(12);
    expect(startSpeed).toBeGreaterThanOrEqual(11.5); // sanity: did we actually reach 12?
    v.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    let ticks = 0;
    const cap = 15 * 60; // 15 s safety
    while (ticks < cap) {
      world.step();
      ticks++;
      if (speedXZ(v) < 0.3) break;
    }
    const dist = Math.abs(v.getState().position.z - startZ);
    expect(
      dist,
      `stopping distance from ${startSpeed.toFixed(2)} m/s = ${dist.toFixed(2)} m; should be ≤ 25 m`,
    ).toBeLessThanOrEqual(25);
    world.dispose();
  });

  it('comes to a near-stop within 8 s from 12 m/s under full brake', () => {
    const { world, v } = setupAtSpeed(12);
    v.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    for (let i = 0; i < 8 * 60; i++) world.step();
    const sp = speedXZ(v);
    expect(
      sp,
      `speed after 8 s of full brake from ~12 m/s = ${sp.toFixed(2)} m/s; should be < 1 m/s`,
    ).toBeLessThan(1);
    world.dispose();
  });

  it('decelerates at over 4 m/s² on average over the first second of braking', () => {
    // The brake should *bite* immediately, not just bleed speed off.
    // Average decel = (v0 - v1) / 1 s. Pre-fix this was ~0.5 m/s²
    // (because of the wheel-sign-flip oscillation); post-fix this is
    // around 5 m/s².
    const { world, v, startSpeed } = setupAtSpeed(12);
    v.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    for (let i = 0; i < 60; i++) world.step();
    const after = speedXZ(v);
    const decel = (startSpeed - after) / 1.0;
    expect(
      decel,
      `avg decel over first 1 s = ${decel.toFixed(2)} m/s²; should be > 4 m/s²`,
    ).toBeGreaterThan(4);
    world.dispose();
  });

  it('full brake stops the truck faster than coasting (no input) over the same window', () => {
    // Sanity check: the brake pedal must do meaningful work beyond
    // engine braking + rolling resistance alone. (handbrake.test.ts
    // covers a similar property for the handbrake; this guards the
    // foot brake specifically.)
    const a = setupAtSpeed(12);
    const b = setupAtSpeed(12);
    a.v.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    b.v.setInput({ ...EMPTY_INPUT, seq: 2 }); // coast
    for (let i = 0; i < 3 * 60; i++) {
      a.world.step();
      b.world.step();
    }
    const brakeSp = speedXZ(a.v);
    const coastSp = speedXZ(b.v);
    expect(
      brakeSp,
      `brake speed ${brakeSp.toFixed(2)} should be much less than coast speed ${coastSp.toFixed(2)} after 3 s`,
    ).toBeLessThan(coastSp - 4);
    a.world.dispose();
    b.world.dispose();
  });
});
