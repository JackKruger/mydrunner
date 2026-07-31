// Obstacle identity is the contract authored maps rely on: a map records
// "the author deleted this rock" as an id, so the id must name the same
// rock on the next generation. Position can't do that job — the heightfield
// moves obstacles in Y, and a future generator tweak moves them in X/Z.

import { describe, it, expect } from 'vitest';
import { generateTerrain } from '../physics/terrain.js';
import { generateObstacles, type Obstacle } from '../physics/obstacles.js';

const terrain = generateTerrain();

describe('obstacle ids', () => {
  it('are unique across the whole generated set', () => {
    const list = generateObstacles(terrain);
    const ids = new Set(list.map((o) => o.id));
    expect(ids.size).toBe(list.length);
  });

  it('are stable across two independent generations', () => {
    const a = generateObstacles(generateTerrain());
    const b = generateObstacles(generateTerrain());
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id));
  });

  it('name the same obstacle, not just the same slot', () => {
    const a = generateObstacles(generateTerrain());
    const b = generateObstacles(generateTerrain());
    const byId = new Map(b.map((o) => [o.id, o]));
    for (const o of a) {
      const other = byId.get(o.id)!;
      expect(other.kind).toBe(o.kind);
      expect(other.x).toBeCloseTo(o.x, 6);
      expect(other.z).toBeCloseTo(o.z, 6);
    }
  });

  it('cover every generating pass', () => {
    const ids = generateObstacles(terrain).map((o) => o.id);
    for (const p of [
      'rock-med-', 'rock-small-', 'tree-', 'pine-', 'ramp-',
      'hcb-c-', 'hcb-g-', 'mrock-', 'mtree-', 'perim-', 'flag-',
    ]) {
      expect(ids.some((id) => id.startsWith(p)), `expected a "${p}*" id`).toBe(true);
    }
  });

  // Ids must name a placement slot, not a position in the output array.
  // The hill-climb pass rejects boulders that land on road or too near the
  // trail; with a push-order counter, one rejection flipping would renumber
  // every later boulder and silently re-point every deletion an author had
  // saved. These ids encode loop coordinates, so they survive the terrain
  // changing underneath them.
  it('survive the terrain moving under the obstacle', () => {
    // A different seed keeps the mountain (derived from size alone), so the
    // hill-climb loop coordinates are unchanged, but the heightfield moves.
    const other = generateObstacles(generateTerrain({ seed: 4242 }));
    const base = generateObstacles(terrain);
    const byId = new Map(other.map((o) => [o.id, o]));

    let reseated = 0;
    for (const o of base) {
      const moved = byId.get(o.id);
      if (!moved) continue; // a rejection that flipped — allowed, see below
      expect(moved.kind).toBe(o.kind);
      if (Math.abs(moved.y - o.y) > 1e-9) reseated++;
    }
    // The whole point: same ids, re-seated onto new ground.
    expect(reseated).toBeGreaterThan(100);
  });

  it('are structural, never a running output counter', () => {
    for (const o of generateObstacles(terrain)) {
      expect(o.id).toMatch(
        /^(rock-med-\d+|rock-small-\d+|tree-\d+|pine-\d+|ramp-\d+|mrock-\d+|mtree-\d+|perim-\d+-\d+|flag-(summit|trailhead-[we])|hcb-(c-\d+-\d+-[we]|g-\d+-\d+)(-s\d+)?)$/,
      );
    }
  });
});

describe('generateObstacles options', () => {
  it('defaults to the full procedural set', () => {
    expect(generateObstacles(terrain, {}).length).toBe(generateObstacles(terrain).length);
  });

  it('drops removed ids and nothing else', () => {
    const full = generateObstacles(terrain);
    const victims = [full[0]!.id, full[10]!.id, full[full.length - 1]!.id];
    const trimmed = generateObstacles(terrain, { removed: victims });
    expect(trimmed.length).toBe(full.length - victims.length);
    for (const id of victims) {
      expect(trimmed.some((o) => o.id === id)).toBe(false);
    }
  });

  it('ignores a removed id that does not exist', () => {
    const full = generateObstacles(terrain);
    expect(generateObstacles(terrain, { removed: ['no-such-rock'] }).length).toBe(full.length);
  });

  it('appends authored obstacles after the generated set', () => {
    const authored: Obstacle = {
      id: 'authored-1', kind: 'rock', x: 5, y: 1, z: 5, size: 1, height: 0, yaw: 0,
    };
    const list = generateObstacles(terrain, { added: [authored] });
    expect(list[list.length - 1]).toEqual(authored);
  });

  it('places authored obstacles even where the surface filter would reject them', () => {
    // On the road core, which proceduralObstacles skips outright.
    const onRoad: Obstacle = {
      id: 'authored-road', kind: 'rock', x: 0, y: 0, z: -50, size: 1, height: 0, yaw: 0,
    };
    const list = generateObstacles(terrain, { added: [onRoad] });
    expect(list.some((o) => o.id === 'authored-road')).toBe(true);
  });

  it('can drop the procedural set entirely', () => {
    const authored: Obstacle = {
      id: 'only-one', kind: 'rock', x: 0, y: 0, z: 0, size: 1, height: 0, yaw: 0,
    };
    expect(generateObstacles(terrain, { includeProcedural: false, added: [authored] }))
      .toEqual([authored]);
    expect(generateObstacles(terrain, { includeProcedural: false })).toEqual([]);
  });
});
