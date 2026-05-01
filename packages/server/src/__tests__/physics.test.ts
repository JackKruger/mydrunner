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
    const world = new Physics.World({ generate: { size: 100, resolution: 32, seed: 1 } });
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
    const world = new Physics.World({ generate: { size: 100, resolution: 32, seed: 1 } });
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
    const world = new Physics.World({ generate: { size: 100, resolution: 32, seed: 1 } });
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

  it('accelerates faster on road than on deep mud (same input)', () => {
    // Build two worlds: one all-road, one all-deep-mud, by hand-crafting
    // surface arrays. Same heightmap (flat) so terrain doesn't confound.
    function makeWorld(allMud: boolean): Physics.World {
      const n = 32;
      const heights = new Float32Array(n * n); // all zeros, flat ground
      const surfaces = new Uint8Array(n * n);
      surfaces.fill(allMud ? Physics.Surface.DeepMud : Physics.Surface.Road);
      return new Physics.World({
        terrain: { size: 100, resolution: n, heights, surfaces, seed: 0 },
      });
    }
    const wRoad = makeWorld(false);
    const wMud = makeWorld(true);
    const vRoad = wRoad.spawnVehicle('a', { position: { x: 0, y: 1.5, z: 0 } });
    const vMud = wMud.spawnVehicle('a', { position: { x: 0, y: 1.5, z: 0 } });
    simSeconds(wRoad, 0.5);
    simSeconds(wMud, 0.5);

    vRoad.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    vMud.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    simSeconds(wRoad, 3);
    simSeconds(wMud, 3);

    const speedRoad = Math.hypot(
      vRoad.getState().linVel.x,
      vRoad.getState().linVel.z,
    );
    const speedMud = Math.hypot(
      vMud.getState().linVel.x,
      vMud.getState().linVel.z,
    );
    expect(speedRoad).toBeGreaterThan(speedMud + 1.0);
    wRoad.dispose();
    wMud.dispose();
  });

  it('multiple vehicles do not penetrate each other', () => {
    const world = new Physics.World({ generate: { size: 100, resolution: 32, seed: 1 } });
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
