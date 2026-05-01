// Determinism / prediction-convergence test.
//
// Given the same terrain seed and the same input sequence applied at the
// same fixed step, two World instances should produce the same vehicle
// state to within a small tolerance. This is the foundation of client-side
// prediction: if the local sim drifts even with identical inputs, no
// amount of reconciliation will hide it.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

function makeWorld(): { world: Physics.World; vehicle: Physics.Vehicle } {
  const world = new Physics.World({ generate: { size: 100, resolution: 32, seed: 42 } });
  const vehicle = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
  return { world, vehicle };
}

describe('client prediction', () => {
  it('two worlds with same seed and inputs produce the same state', () => {
    const a = makeWorld();
    const b = makeWorld();
    // Settle.
    for (let i = 0; i < 60; i++) {
      a.world.step();
      b.world.step();
    }
    // Apply the same input sequence to both.
    for (let i = 1; i <= 200; i++) {
      const input = {
        ...EMPTY_INPUT,
        seq: i,
        throttle: 1,
        steer: i > 60 ? 0.5 : 0, // straight then turn
      };
      a.vehicle.setInput(input);
      b.vehicle.setInput(input);
      a.world.step();
      b.world.step();
    }
    const sa = a.vehicle.getState();
    const sb = b.vehicle.getState();
    // Under bit-perfect determinism this would be exact. Even without
    // strict determinism, identical IEEE-754 ops on identical inputs
    // typically match to many digits in single-threaded Rapier.
    expect(sa.position.x).toBeCloseTo(sb.position.x, 3);
    expect(sa.position.y).toBeCloseTo(sb.position.y, 3);
    expect(sa.position.z).toBeCloseTo(sb.position.z, 3);
    a.world.dispose();
    b.world.dispose();
  });

  it('reset returns vehicle to spawn pose with zero velocity', () => {
    const { world, vehicle } = makeWorld();
    // Drive forward a bit. With the engine + gearbox model the car needs a
    // moment to shift out of neutral into 1st before it accelerates -
    // 0.5m in 2 seconds is still conclusive evidence it drove.
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    for (let i = 0; i < 120; i++) world.step();
    expect(Math.abs(vehicle.getState().position.z)).toBeGreaterThan(0.5);

    vehicle.resetTo({ position: { x: 0, y: 1.5, z: 0 }, yaw: 0 });
    const s = vehicle.getState();
    expect(s.position.x).toBeCloseTo(0, 5);
    expect(s.position.y).toBeCloseTo(1.5, 5);
    expect(s.position.z).toBeCloseTo(0, 5);
    expect(Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z)).toBeLessThan(0.01);
    world.dispose();
  });
});
