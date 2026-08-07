// The catalog is the thing that is supposed to make a partially-added
// object kind impossible. These are the checks the type system cannot make:
// that the numbers in an entry are coherent, and that the derived lists
// really are derived.

import { describe, it, expect } from 'vitest';
import {
  OBJECT_INFO, OBJECT_KINDS, isObstacleKind, objectInfo, objectKindsByGroup,
  resolveColliders, type Obstacle, type ObstacleKind,
} from '../physics/objectCatalog.js';
import { decodeMapDoc } from '../map/mapDoc.js';
import { proceduralDoc } from '../map/applyMapDoc.js';

/** A placed instance of a kind, at its own defaults. */
function sample(kind: ObstacleKind, yaw = 0.7): Obstacle {
  const d = objectInfo(kind).defaults;
  return {
    id: `t-${kind}`, kind, x: 3, y: 2, z: -5,
    size: d.size, height: d.height, yaw,
    ...(d.length !== undefined ? { length: d.length } : {}),
  };
}

describe('object catalog', () => {
  it('derives the kind list from the table', () => {
    expect([...OBJECT_KINDS].sort()).toEqual(Object.keys(OBJECT_INFO).sort());
    expect(OBJECT_KINDS.length).toBeGreaterThanOrEqual(66);
  });

  it('includes the expanded editor choices in their intended sections', () => {
    const groups = new Map(objectKindsByGroup().map((g) => [g.group, g.kinds]));
    expect(groups.get('natural')).toEqual(expect.arrayContaining(['cactus', 'reeds']));
    expect(groups.get('trail')).toEqual(expect.arrayContaining([
      'stairSteps', 'rockGarden', 'washboard', 'sandbagWall',
    ]));
    expect(groups.get('props')).toEqual(expect.arrayContaining([
      'fuelPump', 'generator', 'portableToilet', 'streetLight', 'bench',
      'roadworkBarrier', 'horizontalTank', 'watchtower',
      'campTent', 'woodPile', 'waterTrough', 'farmWindmill', 'solarPanel',
      'oldTractor', 'bushHut', 'timberCabin', 'leanTo', 'caravan', 'bushDunny',
    ]));
    expect(groups.get('markers')).toContain('checkpointArch');
  });

  it('recognises exactly the kinds in the table', () => {
    for (const k of OBJECT_KINDS) expect(isObstacleKind(k)).toBe(true);
    expect(isObstacleKind('spaceship')).toBe(false);
    // Prototype keys must not read as kinds — `in`-style lookups on a plain
    // object answer true for "constructor", and this is a trust boundary.
    expect(isObstacleKind('constructor')).toBe(false);
    expect(isObstacleKind('toString')).toBe(false);
  });

  it('throws rather than guessing on an unknown kind', () => {
    expect(() => objectInfo('nope' as ObstacleKind)).toThrow(/unknown obstacle kind/);
  });

  it('gives every kind defaults that sit inside its own limits', () => {
    for (const kind of OBJECT_KINDS) {
      const info = objectInfo(kind);
      expect(info.label.length, kind).toBeGreaterThan(0);
      expect(info.defaults.size, kind).toBeGreaterThanOrEqual(info.limits.size[0]);
      expect(info.defaults.size, kind).toBeLessThanOrEqual(info.limits.size[1]);
      expect(info.defaults.height, kind).toBeGreaterThanOrEqual(info.limits.height[0]);
      expect(info.defaults.height, kind).toBeLessThanOrEqual(info.limits.height[1]);
      expect(info.limits.size[0], kind).toBeLessThan(info.limits.size[1]);
      expect(info.friction, kind).toBeGreaterThan(0);
    }
  });

  // A kind that advertises a length slider but ignores the value, or uses
  // one it never advertises, is a control that silently does nothing —
  // the same failure as a TUNING field with no reader.
  it('declares a length dimension exactly when it has one to author', () => {
    for (const kind of OBJECT_KINDS) {
      const info = objectInfo(kind);
      const declared = info.dims.length !== undefined;
      expect(declared, `${kind}: dims.length and limits.length disagree`)
        .toBe(info.limits.length !== undefined);
      expect(declared, `${kind}: dims.length and defaults.length disagree`)
        .toBe(info.defaults.length !== undefined);

      // Does the collider actually move when length changes?
      const base = sample(kind);
      const longer: Obstacle = { ...base, length: (base.length ?? 3) + 4 };
      const changed =
        JSON.stringify(resolveColliders(base)) !== JSON.stringify(resolveColliders(longer));
      if (changed) {
        expect(declared, `${kind}: collider uses length but does not declare it`).toBe(true);
      }
    }
  });

  it('resolves finite collider geometry for every kind', () => {
    for (const kind of OBJECT_KINDS) {
      for (const c of resolveColliders(sample(kind))) {
        for (const a of c.args) {
          expect(Number.isFinite(a), `${kind}: non-finite collider arg`).toBe(true);
          expect(a, `${kind}: non-positive collider arg`).toBeGreaterThan(0);
        }
        for (const v of [c.pos.x, c.pos.y, c.pos.z, c.rot.x, c.rot.y, c.rot.z, c.rot.w]) {
          expect(Number.isFinite(v), `${kind}: non-finite collider transform`).toBe(true);
        }
        const qlen = Math.hypot(c.rot.x, c.rot.y, c.rot.z, c.rot.w);
        expect(qlen, `${kind}: collider rotation is not a unit quaternion`).toBeCloseTo(1, 6);
      }
    }
  });

  it('rotates the individual rocks in a rock garden with its yaw', () => {
    const garden = sample('rockGarden', Math.PI / 2);
    const colliders = resolveColliders(garden);
    expect(colliders).toHaveLength(7);
    expect(new Set(colliders.map((c) => `${c.pos.x.toFixed(3)},${c.pos.z.toFixed(3)}`)).size)
      .toBe(7);
    // A local +X offset points along world -Z under the catalog's yaw
    // convention. If boulder offsets ignored yaw, this garden would rotate
    // visually while its collision rocks stayed behind.
    const first = colliders[0]!;
    expect(first.pos.x).not.toBeCloseTo(garden.x - 0.42 * (garden.length ?? 6), 3);
    expect(first.pos.z).toBeGreaterThan(garden.z);
  });

  it('stays finite at both ends of every slider', () => {
    for (const kind of OBJECT_KINDS) {
      const info = objectInfo(kind);
      for (const end of [0, 1] as const) {
        const o: Obstacle = {
          id: `x-${kind}`, kind, x: 0, y: 0, z: 0,
          size: info.limits.size[end],
          height: info.limits.height[end],
          yaw: -2.1,
          ...(info.limits.length ? { length: info.limits.length[end] } : {}),
        };
        for (const c of resolveColliders(o)) {
          for (const a of c.args) expect(a, `${kind} @ limit ${end}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('groups every kind into a palette section', () => {
    const grouped = objectKindsByGroup().flatMap((g) => g.kinds);
    expect([...grouped].sort()).toEqual([...OBJECT_KINDS].sort());
  });

  // The decoder used to validate against its own hand-written copy of the
  // kind list, which is exactly the drift this table exists to end.
  it('lets the document decoder accept every kind in the table', () => {
    const doc = proceduralDoc();
    for (const kind of OBJECT_KINDS) {
      const s = sample(kind);
      const decoded = decodeMapDoc(JSON.parse(JSON.stringify({
        ...doc,
        objects: {
          includeProcedural: true,
          added: [{
            id: s.id, kind, x: s.x, z: s.z, size: s.size, height: s.height, yaw: s.yaw,
            ...(s.length !== undefined ? { length: s.length } : {}),
          }],
          removed: [],
        },
      })));
      expect(decoded.objects.added[0]!.kind, kind).toBe(kind);
    }
  });
});
