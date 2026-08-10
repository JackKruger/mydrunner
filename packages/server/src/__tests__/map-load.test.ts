// The room loads its world from a map document.
//
// Two things need pinning. First, that the default room builds the map in
// the shared registry, so the server and browser drive on the same authored
// terrain even though they deploy independently.
//
// Second, that an authored map actually reaches the physics. The failure
// mode is quiet — a room that composes the document for its terrain but
// regenerates obstacles procedurally boots fine, looks fine, and puts
// invisible rocks where the author deleted them.

import { describe, it, expect } from 'vitest';
import {
  Maps, Net, PROTOCOL_VERSION, Physics, fnv1aArray, type CarKind,
} from '@mydrunner/shared';
import { Room, type PlayerHandle } from '../room.js';

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
}

function welcomeSpawn(messages: Net.ServerMessage[]): Net.SpawnHandshake {
  const welcome = messages.find((m): m is Extract<Net.ServerMessage, { t: 'welcome' }> => m.t === 'welcome');
  if (!welcome) throw new Error('missing welcome');
  return welcome.spawn;
}

describe('the default room uses the authored default map', () => {
  it('builds the terrain in the registry', () => {
    const room = new Room();
    const doc = Maps.getMap(Maps.DEFAULT_MAP_ID);
    expect(doc).not.toBeNull();
    const direct = Maps.applyMapDoc(doc!);
    expect(fnv1aArray(room.map.terrain.heights)).toBe(fnv1aArray(direct.terrain.heights));
    expect(fnv1aArray(room.map.terrain.surfaces)).toBe(fnv1aArray(direct.terrain.surfaces));
    close(room);
  });

  it('builds the authored obstacle set in the registry', () => {
    const room = new Room();
    const doc = Maps.getMap(Maps.DEFAULT_MAP_ID);
    expect(doc).not.toBeNull();
    const direct = Maps.applyMapDoc(doc!);
    expect(room.map.obstacles.map((o) => o.id)).toEqual(direct.obstacles.map((o) => o.id));
    expect(doc!.objects.added.length).toBeGreaterThan(0);
    expect(doc!.objects.removed.length).toBeGreaterThan(0);
    close(room);
  });

  it('spawns the first player on the road grid', () => {
    const room = new Room();
    const t = welcomeSpawn(join(room, 'p1')).position;
    // The -X end of the main road: the grid fallback, unchanged.
    expect(t.x).toBeCloseTo(-room.map.terrain.size / 2 + 24, 5);
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
      map: { id: Maps.DEFAULT_MAP_ID, rev: Maps.mapRevOf(Maps.DEFAULT_MAP_ID) },
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
    expect(room.map.obstacles.some((o) => o.id === victim)).toBe(false);
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
    const placed = room.map.obstacles.find((o) => o.id === 'authored-boulder');
    expect(placed).toBeDefined();
    // Seated on the composed ground, not left at y=0 under the terrain.
    expect(placed!.y).toBeCloseTo(Physics.sampleHeightBilinear(room.map.terrain, 12, -8), 5);
    close(room);
  });

  it('starts players at the authored spawn points, cycling them', () => {
    const base = Maps.proceduralDoc();
    const spawns = [
      { x: -40, z: 10, yaw: 0 },
      { x: -30, z: 10, yaw: Math.PI },
    ];
    const room = new Room({ ...base, spawns });
    const poses = new Map<string, Net.SpawnHandshake>();
    poses.set('p1', welcomeSpawn(join(room, 'p1')));
    poses.set('p2', welcomeSpawn(join(room, 'p2')));
    poses.set('p3', welcomeSpawn(join(room, 'p3')));
    const at = (id: string): { x: number; z: number } => poses.get(id)!.position;
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
    expect(room.map.terrain.heights[idx]).toBeCloseTo(baseline + 5, 3);
    // And the spawn sits on top of the sculpt rather than buried in it.
    const spawn = welcomeSpawn(join(room, 'p1'));
    expect(spawn.position.y).toBeGreaterThan(baseline + 5);
    close(room);
  });
});
