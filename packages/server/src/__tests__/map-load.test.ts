// The room loads its world from a map document.
//
// Two things need pinning. First, that the switch did not move the
// shipped world: the default room must still build the exact ground the
// generator call it replaced did, or every committed screenshot and
// every "spawns are viable" property test is now describing a different
// map than the one players drive on.
//
// Second, that an authored map actually reaches the physics. The failure
// mode is quiet — a room that composes the document for its terrain but
// regenerates obstacles procedurally boots fine, looks fine, and puts
// invisible rocks where the author deleted them.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  Maps, Net, PROTOCOL_VERSION, Physics, fnv1aArray, type CarKind,
} from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function join(room: Room, id: string, carKind: CarKind = 'patrol'): Net.ServerMessage[] {
  const received: Net.ServerMessage[] = [];
  const handle: PlayerHandle = {
    id,
    name: id,
    carKind,
    send: (bytes) => received.push(Net.decodeServer(bytes)),
  };
  room.addPlayer(handle);
  return received;
}

function close(room: Room): void {
  room.stop();
  room.world.dispose();
}

describe('the default room is still the shipped world', () => {
  it('builds the terrain the generator does', () => {
    const room = new Room();
    const direct = Physics.generateTerrain();
    expect(fnv1aArray(room.world.terrain.heights)).toBe(fnv1aArray(direct.heights));
    expect(fnv1aArray(room.world.terrain.surfaces)).toBe(fnv1aArray(direct.surfaces));
    close(room);
  });

  it('builds the obstacle set the generator does', () => {
    const room = new Room();
    const direct = Physics.generateObstacles(Physics.generateTerrain());
    expect(room.world.obstacles.map((o) => o.id)).toEqual(direct.map((o) => o.id));
    close(room);
  });

  it('spawns the first player on the road grid', () => {
    const room = new Room();
    join(room, 'p1');
    const t = room.world.vehicles.get('p1')!.body.translation();
    // The -X end of the main road: the grid fallback, unchanged.
    expect(t.x).toBeCloseTo(-room.world.terrain.size / 2 + 24, 5);
    close(room);
  });
});

describe('the welcome names the map', () => {
  it('sends the loaded map id and this build revision', () => {
    const room = new Room();
    const [welcome] = join(room, 'p1');
    expect(welcome).toMatchObject({
      t: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      map: { id: Maps.PROCEDURAL_MAP_ID, rev: Maps.mapRevOf(Maps.PROCEDURAL_MAP_ID) },
    });
    close(room);
  });

  it('reports the revision of the document actually loaded', () => {
    // A room on a document the registry has never heard of must still
    // report a rev the client can compare, or the client's check would
    // silently pass on whatever the registry happened to hold.
    const doc = { ...Maps.proceduralDoc(), id: 'off-registry', name: 'Off Registry' };
    const room = new Room(doc);
    const [welcome] = join(room, 'p1');
    expect(welcome).toMatchObject({ map: { id: 'off-registry', rev: Maps.mapDocRev(doc) } });
    close(room);
  });

  it('refuses to build on a map id the registry does not have', () => {
    expect(() => new Room('no-such-map')).toThrow(/unknown map/);
  });
});

describe('an authored map reaches the physics', () => {
  it('drops an obstacle the author deleted', () => {
    const base = Maps.proceduralDoc();
    const victim = Maps.applyMapDoc(base).obstacles[7]!.id;
    const room = new Room({ ...base, objects: { ...base.objects, removed: [victim] } });
    expect(room.world.obstacles.some((o) => o.id === victim)).toBe(false);
    close(room);
  });

  it('places an obstacle the author added', () => {
    const base = Maps.proceduralDoc();
    const added: Maps.PlacedObject = {
      id: 'authored-boulder',
      kind: 'rock',
      x: 12,
      z: -8,
      size: 2.5,
      height: 2,
      yaw: 0.4,
    };
    const room = new Room({ ...base, objects: { ...base.objects, added: [added] } });
    const placed = room.world.obstacles.find((o) => o.id === 'authored-boulder');
    expect(placed).toBeDefined();
    // Seated on the composed ground, not left at y=0 under the terrain.
    expect(placed!.y).toBeCloseTo(Physics.sampleHeightBilinear(room.world.terrain, 12, -8), 5);
    close(room);
  });

  it('starts players at the authored spawn points, cycling them', () => {
    const base = Maps.proceduralDoc();
    const spawns = [
      { x: -40, z: 10, yaw: 0 },
      { x: -30, z: 10, yaw: Math.PI },
    ];
    const room = new Room({ ...base, spawns });
    join(room, 'p1');
    join(room, 'p2');
    join(room, 'p3');
    const at = (id: string): { x: number; z: number } => {
      const t = room.world.vehicles.get(id)!.body.translation();
      return { x: t.x, z: t.z };
    };
    expect(at('p1').x).toBeCloseTo(-40, 5);
    expect(at('p2').x).toBeCloseTo(-30, 5);
    // Slot 2 wraps back onto the first authored point.
    expect(at('p3').x).toBeCloseTo(-40, 5);
    close(room);
  });

  it('sculpts the ground the vehicles drive on', () => {
    const base = Maps.proceduralDoc();
    const n = base.base.resolution;
    const delta = new Int16Array(n * n);
    const idx = Physics.worldToTerrainIndex(Physics.generateTerrain(), -40, 10);
    delta[idx] = 500; // +5 m
    const room = new Room({
      ...base,
      heightDelta: Maps.encodeInt16Grid(delta, n),
      spawns: [{ x: -40, z: 10, yaw: 0 }],
    });
    const baseline = Physics.generateTerrain().heights[idx]!;
    expect(room.world.terrain.heights[idx]).toBeCloseTo(baseline + 5, 3);
    // And the spawn sits on top of the sculpt rather than buried in it.
    join(room, 'p1');
    expect(room.world.vehicles.get('p1')!.body.translation().y).toBeGreaterThan(baseline + 5);
    close(room);
  });
});
