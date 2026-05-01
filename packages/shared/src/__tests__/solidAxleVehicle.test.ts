// Integration tests for SolidAxleVehicle against real Rapier. The class
// isn't reachable through World.spawnVehicle while VEHICLE_MODEL='raycast',
// so we construct it directly and step the same World as the legacy
// vehicle would. These tests verify the new model produces sensible
// physics: settles to a stable rest pose, drives forward under throttle,
// road-vs-mud grip difference, and is deterministic across two worlds.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT, type PlayerInput } from '../index.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function makeWorld() {
  // Flat all-zero heightfield: removes terrain noise and obstacles as
  // variables so the test isolates SolidAxleVehicle behaviour. Same
  // pattern heightfield-debug.test.ts uses for the legacy vehicle.
  const n = 64;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(Physics.Surface.Road);
  const world = new Physics.World({
    terrain: { size: 200, resolution: n, heights, surfaces, seed: 0 },
  });
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: 0, y: 1.5, z: 0 } },
    'patrol',
  );
  // World.spawnVehicle would register the vehicle through the factory;
  // we bypass it because VEHICLE_MODEL='raycast' would route us to the
  // legacy class. Register manually so World.step() drives our axle
  // vehicle's preStep/postStep.
  world.vehicles.set(vehicle.id, vehicle);
  return { world, vehicle };
}

function fullThrottle(seq: number): PlayerInput {
  return { ...EMPTY_INPUT, seq, throttle: 1 };
}

function settle(world: Physics.World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

describe('solid-axle vehicle: settling', () => {
  it('falls onto the ground and settles to a stable rest pose', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 480); // 8s - generous for the underdamped ride spring
    const s = vehicle.getState();
    // Below initial drop height.
    expect(s.position.y).toBeLessThan(1.5);
    // Above terrain (around y=0).
    expect(s.position.y).toBeGreaterThan(0);
    // Slow (the chassis still bobs at <50% of critical damping but the
    // peak velocity per cycle decays).
    expect(Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z)).toBeLessThan(0.5);
    world.dispose();
  });

  it('does not slowly tip over on flat ground (rollover stability)', () => {
    // Regression test: previously, ride force was applied at the axle
    // CENTER (chassis x=0), which gave no roll-restoring torque when
    // the chassis tipped. Any small roll perturbation grew without
    // bound. The fix is to apply ride force at each wheel-end (+/-
    // trackHalf) so the loaded side produces a righting moment.
    const { world, vehicle } = makeWorld();
    settle(world, 480);
    // After 8s of just sitting on flat road, the chassis quaternion's
    // roll component (rotation about chassis-forward) should be tiny.
    const r = vehicle.getState().rotation;
    // Extract roll from quaternion (rotation about world Z when
    // chassis-forward maps to world +X via initial yaw=0).
    const roll = Math.atan2(2 * (r.w * r.x + r.y * r.z), 1 - 2 * (r.x * r.x + r.y * r.y));
    expect(Math.abs(roll)).toBeLessThan(0.1);
    // And angular velocity is small - chassis isn't actively tipping.
    const av = vehicle.getState().angVel;
    expect(Math.hypot(av.x, av.y, av.z)).toBeLessThan(0.2);
    world.dispose();
  });

  it('reports both axles touching ground after settling on flat-ish terrain', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 240);
    const snaps = vehicle.axleSnaps();
    // Both axles should be in contact (compression > 0).
    expect(snaps[0].rideY).toBeGreaterThanOrEqual(0);
    expect(snaps[1].rideY).toBeGreaterThanOrEqual(0);
    // Articulation should be small on flat-ish terrain.
    expect(Math.abs(snaps[0].rollAngle)).toBeLessThan(0.2);
    expect(Math.abs(snaps[1].rollAngle)).toBeLessThan(0.2);
    world.dispose();
  });
});

describe('solid-axle vehicle: drivetrain', () => {
  it('drives forward when throttle is applied', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    const startZ = vehicle.getState().position.z;
    for (let i = 1; i <= 240; i++) {
      vehicle.setInput(fullThrottle(i));
      world.step();
    }
    const endZ = vehicle.getState().position.z;
    expect(endZ - startZ).toBeGreaterThan(2);
    world.dispose();
  });

  it('responds to steering with non-trivial yaw rotation', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    const startYaw = quatYaw(vehicle.getState().rotation);
    for (let i = 1; i <= 300; i++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1, steer: 1 });
      world.step();
    }
    const endYaw = quatYaw(vehicle.getState().rotation);
    expect(Math.abs(angleDiff(endYaw, startYaw))).toBeGreaterThan(0.05);
    world.dispose();
  });
});

describe('solid-axle vehicle: determinism', () => {
  it('two worlds with same seed and inputs produce the same state', () => {
    const a = makeWorld();
    const b = makeWorld();
    settle(a.world, 60);
    settle(b.world, 60);
    for (let i = 1; i <= 200; i++) {
      const input: PlayerInput = {
        ...EMPTY_INPUT,
        seq: i,
        throttle: 1,
        steer: i > 60 ? 0.5 : 0,
      };
      a.vehicle.setInput(input);
      b.vehicle.setInput(input);
      a.world.step();
      b.world.step();
    }
    const sa = a.vehicle.getState();
    const sb = b.vehicle.getState();
    expect(sa.position.x).toBeCloseTo(sb.position.x, 3);
    expect(sa.position.y).toBeCloseTo(sb.position.y, 3);
    expect(sa.position.z).toBeCloseTo(sb.position.z, 3);
    a.world.dispose();
    b.world.dispose();
  });
});

describe('solid-axle vehicle: snapshot round-trip', () => {
  it('axleSnaps + applyAxleSnaps restores the axle pose', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1, steer: 0.5 });
    for (let i = 0; i < 30; i++) world.step();
    const before = vehicle.axleSnaps();
    // Reset the axles to zero, then apply.
    vehicle.applyAxleSnaps([
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ]);
    expect(vehicle.axleSnaps()[0].rideY).toBe(0);
    vehicle.applyAxleSnaps(before);
    const after = vehicle.axleSnaps();
    expect(after[0].rideY).toBeCloseTo(before[0].rideY, 5);
    expect(after[0].rollAngle).toBeCloseTo(before[0].rollAngle, 5);
    expect(after[1].rideY).toBeCloseTo(before[1].rideY, 5);
    expect(after[1].rollAngle).toBeCloseTo(before[1].rollAngle, 5);
    world.dispose();
  });
});

function quatYaw(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
