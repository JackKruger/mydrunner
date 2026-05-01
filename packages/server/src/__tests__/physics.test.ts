// End-to-end physics test: spawn a vehicle, run the sim, verify behavior.
// Runs Rapier WASM in node - same code path as production server.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, FIXED_DT, EMPTY_INPUT } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

function simSeconds(world: Physics.World, seconds: number): void {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) world.step();
}

describe('vehicle physics', () => {
  it('falls onto the ground from a small height and settles', () => {
    const world = new Physics.World({ size: 100, resolution: 32 });
    const v = world.spawnVehicle('p1', { position: { x: 0, y: 3, z: 0 } });
    simSeconds(world, 2);
    const s = v.getState();
    expect(s.position.y).toBeLessThan(2);
    expect(s.position.y).toBeGreaterThan(-1); // didn't fall through
    // Pretty much at rest after settling (linear vel small).
    const speed = Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z);
    expect(speed).toBeLessThan(2);
    world.dispose();
  });

  it('drives forward when throttle is applied', () => {
    const world = new Physics.World({ size: 100, resolution: 32 });
    const v = world.spawnVehicle('p1', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(world, 1); // settle on ground

    const before = v.getState().position.z;
    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    simSeconds(world, 3);
    const after = v.getState().position.z;
    // Local +Z is forward in our spawn frame.
    const dz = Math.abs(after - before);
    expect(dz).toBeGreaterThan(2);
    world.dispose();
  });

  it('responds to steering', () => {
    const world = new Physics.World({ size: 100, resolution: 32 });
    const v = world.spawnVehicle('p1', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(world, 1);

    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1, steer: 1 });
    simSeconds(world, 4);
    const s = v.getState();
    // Should have moved laterally as well as forward.
    expect(Math.abs(s.position.x) + Math.abs(s.position.z)).toBeGreaterThan(2);
    // Yaw should be non-zero.
    const yaw = Math.atan2(
      2 * (s.rotation.w * s.rotation.y + s.rotation.x * s.rotation.z),
      1 - 2 * (s.rotation.y * s.rotation.y + s.rotation.x * s.rotation.x),
    );
    expect(Math.abs(yaw)).toBeGreaterThan(0.01);
    world.dispose();
  });

  it('multiple vehicles do not penetrate each other', () => {
    const world = new Physics.World({ size: 100, resolution: 32 });
    const a = world.spawnVehicle('a', { position: { x: -2, y: 1.5, z: 0 } });
    const b = world.spawnVehicle('b', { position: { x: 2, y: 1.5, z: 0 } });
    simSeconds(world, 2);
    const sa = a.getState();
    const sb = b.getState();
    const dist = Math.hypot(sa.position.x - sb.position.x, sa.position.z - sb.position.z);
    expect(dist).toBeGreaterThan(1.5); // chassis half-extents x is 1.0 each
    world.dispose();
  });
});
