import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT, Maps, Physics, createStockBuild } from '@mydrunner/shared';
import { LocalSimulation } from '../localSimulation.js';
import type { RemoteCollisionState } from '../scene.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function makeSimulation(): { sim: LocalSimulation; spawn: Maps.SpawnPose } {
  const map = Maps.applyMapDoc(Maps.proceduralDoc());
  const spawn = Maps.resolveSpawn(map, 0, 'patrol');
  return { sim: new LocalSimulation(map, spawn, createStockBuild()), spawn };
}

function remoteAt(
  id: string,
  position: { x: number; y: number; z: number },
  recvAtMs = performance.now(),
): RemoteCollisionState {
  return {
    id,
    build: createStockBuild(),
    buildRevision: 1,
    workshopMode: false,
    position,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linVel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    recvAtMs,
  };
}

describe('LocalSimulation', () => {
  it('interpolates between completed fixed steps', () => {
    const { sim } = makeSimulation();
    const before = { ...sim.state(1).position };
    sim.step({ ...EMPTY_INPUT, seq: 1 });
    const previous = { ...sim.state(0).position };
    const current = { ...sim.state(1).position };
    const midpoint = { ...sim.state(0.5).position };
    expect(previous).toEqual(before);
    expect(midpoint.y).toBeCloseTo((previous.y + current.y) * 0.5, 6);
    sim.dispose();
  });

  it('creates and removes one proxy per visible remote player', () => {
    const { sim, spawn } = makeSimulation();
    sim.syncRemoteVehicles([remoteAt('remote', { ...spawn.position, x: spawn.position.x + 8 })], performance.now());
    expect(sim.remoteProxyCount).toBe(1);
    expect(sim.activeRemoteProxyCount).toBe(1);
    sim.syncRemoteVehicles([], performance.now());
    expect(sim.remoteProxyCount).toBe(0);
    sim.dispose();
  });

  it('disables a stale remote proxy before stepping physics', () => {
    const { sim, spawn } = makeSimulation();
    const now = performance.now();
    sim.syncRemoteVehicles(
      [remoteAt('stale', { ...spawn.position, x: spawn.position.x + 2 }, now - 1000)],
      now,
    );
    sim.step({ ...EMPTY_INPUT, seq: 1 });
    expect(sim.activeRemoteProxyCount).toBe(0);
    sim.dispose();
  });

  it('resolves an overlapping remote chassis against the owned truck', () => {
    const { sim, spawn } = makeSimulation();
    const remote = remoteAt('blocker', {
      x: spawn.position.x + 2.5,
      y: spawn.position.y,
      z: spawn.position.z,
    });
    const halfYaw = spawn.yaw * 0.5;
    remote.rotation = { x: 0, y: Math.sin(halfYaw), z: 0, w: Math.cos(halfYaw) };
    sim.syncRemoteVehicles([remote], performance.now());
    for (let seq = 1; seq <= 30; seq++) sim.step({ ...EMPTY_INPUT, seq });
    expect(sim.vehicleState().position.x).toBeLessThan(spawn.position.x - 0.05);
    sim.dispose();
  });
});
