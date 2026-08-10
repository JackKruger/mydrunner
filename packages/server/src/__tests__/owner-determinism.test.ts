// Owner-simulation determinism test.
//
// Given the same terrain seed and the same input sequence applied at the
// same fixed step, two World instances should produce the same vehicle
// state to within a small tolerance. If identical owner simulations drift,
// recordings, replays and regression comparisons cannot be trusted.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT, TERRAIN } from '@mydrunner/shared';

const ROAD_Z = TERRAIN.roadZ;

beforeAll(async () => {
  await Physics.initRapier();
});

function makeWorld(): { world: Physics.World; vehicle: Physics.VehicleLike } {
  const world = new Physics.World({ generate: { size: 100, resolution: 32, seed: 42 } });
  const vehicle = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: ROAD_Z } });
  return { world, vehicle };
}

describe('owner simulation determinism', () => {
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
    const serialize = (rig: ReturnType<typeof makeWorld>, state: typeof sa): string => JSON.stringify({
      state,
      axles: rig.vehicle.axleSnaps?.(),
      pressure: rig.vehicle.pressureStatus?.(),
      drivetrain: rig.vehicle.drivetrainStatus?.(),
      soil: rig.vehicle.debugTelemetry?.().wheels.map((wheel) => ({
        sinkDepth: wheel.sinkDepth,
        soilDrag: wheel.soilDrag,
        slipWork: wheel.slipWork,
      })),
      ruts: (rig.world.ruts as Physics.SparseRutField).exportTiles(),
    });
    expect(serialize(a, sa)).toBe(serialize(b, sb));
    a.world.dispose();
    b.world.dispose();
  });

  it('reset returns vehicle to spawn pose with zero velocity', () => {
    const { world, vehicle } = makeWorld();
    // Settle on the ground first — without this the truck is still
    // bouncing on its suspension when throttle is applied, and the
    // amount it covers in the next 2 s depends on bounce phase.
    for (let i = 0; i < 60; i++) world.step();
    // Drive forward a bit. With the engine + gearbox model the car needs a
    // moment to shift out of neutral into 1st before it accelerates -
    // 0.5m in 2 seconds is still conclusive evidence it drove.
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    for (let i = 0; i < 120; i++) world.step();
    expect(Math.abs(vehicle.getState().position.z - ROAD_Z)).toBeGreaterThan(0.5);

    vehicle.resetTo({ position: { x: 0, y: 1.5, z: ROAD_Z }, yaw: 0 });
    const s = vehicle.getState();
    expect(s.position.x).toBeCloseTo(0, 5);
    expect(s.position.y).toBeCloseTo(1.5, 5);
    expect(s.position.z).toBeCloseTo(ROAD_Z, 5);
    expect(Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z)).toBeLessThan(0.01);
    world.dispose();
  });
});
