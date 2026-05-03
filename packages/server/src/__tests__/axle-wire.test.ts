// Phase 2 wire-format coverage. The solid-axle vehicle exposes its two
// kinematic DOFs (rideY, rollAngle) per axle; those values must
// round-trip through getState -> JSON -> applyAxleSnaps so client
// prediction can reconcile the local truck's flex pose against the
// authoritative server state.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT, Net } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

function makeWorld() {
  const n = 64;
  const size = 200;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(Physics.Surface.Road);
  const world = new Physics.World({
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
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: 0, y: 1.5, z: 0 } },
    'patrol',
  );
  world.vehicles.set(vehicle.id, vehicle);
  return { world, vehicle };
}

describe('axle wire round-trip', () => {
  it('getState populates axles with the same values axleSnaps reports', () => {
    const { world, vehicle } = makeWorld();
    for (let i = 0; i < 120; i++) world.step();
    const state = vehicle.getState();
    const snaps = vehicle.axleSnaps();
    expect(state.axles).toBeDefined();
    expect(state.axles![0].rideY).toBeCloseTo(snaps[0].rideY, 6);
    expect(state.axles![0].rollAngle).toBeCloseTo(snaps[0].rollAngle, 6);
    expect(state.axles![1].rideY).toBeCloseTo(snaps[1].rideY, 6);
    expect(state.axles![1].rollAngle).toBeCloseTo(snaps[1].rollAngle, 6);
    world.dispose();
  });

  it('axles survive JSON encode + decode (no precision loss at this scale)', () => {
    const { world, vehicle } = makeWorld();
    // Drive briefly with steer so the chassis develops some real axle
    // articulation rather than sitting at rest.
    for (let i = 1; i <= 90; i++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 0.6, steer: 0.5 });
      world.step();
    }
    const before = vehicle.getState();
    const wire = Net.encode({
      t: 'snapshot',
      snap: {
        tick: 0,
        serverTimeMs: 0,
        players: [
          {
            id: 'p',
            name: 'p',
            carKind: 'patrol',
            vehicle: before,
            lastAckSeq: 0,
          },
        ],
      },
    });
    const decoded = Net.decodeServer(wire);
    expect(decoded.t).toBe('snapshot');
    if (decoded.t !== 'snapshot') throw new Error('unreachable');
    const after = decoded.snap.players[0]!.vehicle;
    expect(after.axles).toBeDefined();
    expect(after.axles![0].rideY).toBeCloseTo(before.axles![0].rideY, 5);
    expect(after.axles![0].rollAngle).toBeCloseTo(before.axles![0].rollAngle, 5);
    expect(after.axles![1].rideY).toBeCloseTo(before.axles![1].rideY, 5);
    expect(after.axles![1].rollAngle).toBeCloseTo(before.axles![1].rollAngle, 5);
    world.dispose();
  });

  it('reconciling axle snaps into a fresh vehicle matches the source axle pose', () => {
    // Mimics what Prediction.reconcile does: capture authoritative axle
    // pose, apply onto a separately-stepped sim, assert the axles match
    // (modulo any continued world.step that comes after).
    const a = makeWorld();
    const b = makeWorld();
    for (let i = 1; i <= 60; i++) {
      a.vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1, steer: 0.7 });
      a.world.step();
    }
    // b is fresh / settled; copy a's chassis pose AND axle snaps onto b.
    const sa = a.vehicle.getState();
    b.vehicle.body.setTranslation(sa.position, true);
    b.vehicle.body.setRotation(sa.rotation, true);
    b.vehicle.body.setLinvel(sa.linVel, true);
    b.vehicle.body.setAngvel(sa.angVel, true);
    b.vehicle.applyAxleSnaps([
      { rideY: sa.axles![0].rideY, rollAngle: sa.axles![0].rollAngle },
      { rideY: sa.axles![1].rideY, rollAngle: sa.axles![1].rollAngle },
    ]);
    const sb = b.vehicle.axleSnaps();
    expect(sb[0].rideY).toBeCloseTo(sa.axles![0].rideY, 5);
    expect(sb[0].rollAngle).toBeCloseTo(sa.axles![0].rollAngle, 5);
    expect(sb[1].rideY).toBeCloseTo(sa.axles![1].rideY, 5);
    expect(sb[1].rollAngle).toBeCloseTo(sa.axles![1].rollAngle, 5);
    a.world.dispose();
    b.world.dispose();
  });
});
