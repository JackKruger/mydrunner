// Regression: Room.addPlayer must spawn the physics vehicle with the
// player's chosen carKind. It used to drop the kind, so every rig drove
// with Patrol physics - the motorbike's lighter mass / higher power and
// the Hilux's longer wheelbase never applied.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, type CarKind } from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function join(room: Room, id: string, carKind: CarKind): PlayerHandle {
  const handle: PlayerHandle = { id, name: id, carKind, send: () => {} };
  room.addPlayer(handle);
  return handle;
}

describe('per-kind vehicle physics', () => {
  it('spawns each player with their chosen kind geometry', () => {
    const room = new Room();
    join(room, 'p-hilux', 'hilux');
    join(room, 'p-patrol', 'patrol');
    const hilux = room.world.vehicles.get('p-hilux') as Physics.VehicleLike & {
      geom: { rear: { centerLocalZ: number } };
    };
    const patrol = room.world.vehicles.get('p-patrol') as Physics.VehicleLike & {
      geom: { rear: { centerLocalZ: number } };
    };
    expect(hilux.geom.rear.centerLocalZ).toBeCloseTo(-1.4);
    expect(patrol.geom.rear.centerLocalZ).toBeCloseTo(-1.3);
    room.stop();
    room.world.dispose();
  });

  it('applies the motorbike mass multiplier to the rigid body', () => {
    const room = new Room();
    join(room, 'p-bike', 'motorbike');
    join(room, 'p-patrol', 'patrol');
    const bikeMass = room.world.vehicles.get('p-bike')!.body.mass();
    const patrolMass = room.world.vehicles.get('p-patrol')!.body.mass();
    // motorbike massMult is 0.5 - see vehicleGeom.ts.
    expect(bikeMass).toBeCloseTo(patrolMass * 0.5, 0);
    room.stop();
    room.world.dispose();
  });
});
