// The edit session: what you sculpt is what saves, and what saves
// reloads as what you sculpted.
//
// The round trip is the load-bearing property. A map is a delta over a
// generated base, so an editor that composes one way and serialises
// another produces files that open as a slightly different map than the
// one that was saved — and the drift is a few millimetres a cell, far
// too small to notice until it has been in a committed map for a month.

import { describe, expect, it } from 'vitest';
import { Maps, Physics, fnv1aArray } from '@mydrunner/shared';
import { EditSession } from '../editor/editSession.js';

/** A small map — the shipped 128² generator runs for ~50 ms a call and
 *  these tests open many sessions. */
function doc(): Maps.MapDoc {
  return Maps.proceduralDoc({ size: 100, resolution: 32 });
}

const SCULPT = { radius: 12, strength: 3, hardness: 0.4, mode: 'raise' as const, dt: 1 };

/** Per-cell comparison with a tolerance, reporting the worst offender
 *  rather than "expected 12345 to be 67890" from a hash. */
function expectHeightsWithin(a: Float32Array, b: Float32Array, tol: number): void {
  expect(a.length).toBe(b.length);
  let worst = 0;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > worst) { worst = d; at = i; }
  }
  expect(`cell ${at} differs by ${worst.toFixed(6)} m`).toBe(
    worst <= tol ? `cell ${at} differs by ${worst.toFixed(6)} m` : `at most ${tol} m`,
  );
}

describe('sculpting', () => {
  it('raises the ground under the brush', () => {
    const s = EditSession.open(doc());
    const before = Physics.sampleHeightBilinear(s.world.terrain, 0, 0);
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    expect(Physics.sampleHeightBilinear(s.world.terrain, 0, 0)).toBeGreaterThan(before + 1);
  });

  it('lowers with the same strength it raises', () => {
    const s = EditSession.open(doc());
    const before = Physics.sampleHeightBilinear(s.world.terrain, 0, 0);
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.sculpt(0, 0, { ...SCULPT, mode: 'lower' });
    s.endStroke();
    expect(Physics.sampleHeightBilinear(s.world.terrain, 0, 0)).toBeCloseTo(before, 2);
  });

  it('leaves ground outside the brush alone', () => {
    const s = EditSession.open(doc());
    const far = Physics.sampleHeightBilinear(s.world.terrain, 40, 40);
    s.beginStroke();
    s.sculpt(-40, -40, SCULPT);
    s.endStroke();
    expect(Physics.sampleHeightBilinear(s.world.terrain, 40, 40)).toBe(far);
  });

  it('reports a rect covering what it moved', () => {
    const s = EditSession.open(doc());
    const before = Float32Array.from(s.world.terrain.heights);
    s.beginStroke();
    const rect = s.sculpt(0, 0, SCULPT)!;
    s.endStroke();
    const n = s.world.terrain.resolution;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === s.world.terrain.heights[i]) continue;
      const r = Math.floor(i / n);
      const c = i % n;
      expect(r).toBeGreaterThanOrEqual(rect.r0);
      expect(r).toBeLessThan(rect.r0 + rect.rows);
      expect(c).toBeGreaterThanOrEqual(rect.c0);
      expect(c).toBeLessThan(rect.c0 + rect.cols);
    }
  });

  it('returns null when the brush misses the map', () => {
    const s = EditSession.open(doc());
    expect(s.sculpt(9000, 9000, SCULPT)).toBeNull();
  });

  it('flattens toward the height under the cursor, not away from it', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, { ...SCULPT, radius: 6, strength: 8 });
    s.endStroke();
    const peak = Physics.sampleHeightBilinear(s.world.terrain, 0, 0);
    s.beginStroke();
    for (let i = 0; i < 30; i++) s.sculpt(0, 0, { ...SCULPT, mode: 'flatten', radius: 14 });
    s.endStroke();
    // The rim rises toward the centre's height rather than the centre
    // sinking: flatten samples its target once, before editing.
    expect(Physics.sampleHeightBilinear(s.world.terrain, 8, 0)).toBeGreaterThan(peak - 3);
  });

  it('smooths a spike down toward its surroundings', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, { ...SCULPT, radius: 4, strength: 12 });
    s.endStroke();
    const spike = Physics.sampleHeightBilinear(s.world.terrain, 0, 0);
    s.beginStroke();
    for (let i = 0; i < 40; i++) s.sculpt(0, 0, { ...SCULPT, mode: 'smooth', radius: 10 });
    s.endStroke();
    expect(Physics.sampleHeightBilinear(s.world.terrain, 0, 0)).toBeLessThan(spike);
  });
});

describe('painting', () => {
  it('sets the surface under the brush', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.paint(0, 0, { radius: 10, surface: Physics.Surface.DeepMud });
    s.endStroke();
    expect(Physics.sampleSurface(s.world.terrain, 0, 0)).toBe(Physics.Surface.DeepMud);
  });
});

describe('objects', () => {
  it('places an object and seats it on the ground', () => {
    const s = EditSession.open(doc());
    const placed = s.addObject({ kind: 'rock', x: 10, z: -6, size: 2, height: 2, yaw: 0 });
    const found = s.world.obstacles.find((o) => o.id === placed.id)!;
    expect(found).toBeDefined();
    expect(found.y).toBeCloseTo(Physics.sampleHeightBilinear(s.world.terrain, 10, -6), 5);
  });

  it('deletes a generated object by recording its id', () => {
    const s = EditSession.open(doc());
    const victim = s.world.obstacles[3]!.id;
    s.deleteObject(victim);
    expect(s.world.obstacles.some((o) => o.id === victim)).toBe(false);
    // And it stays deleted across a save/load, which is the whole point
    // of ids being stable rather than positional.
    const reopened = EditSession.open(s.toDoc(doc()));
    expect(reopened.world.obstacles.some((o) => o.id === victim)).toBe(false);
  });

  it('drops an authored object outright rather than listing it removed', () => {
    const s = EditSession.open(doc());
    const placed = s.addObject({ kind: 'tree', x: 4, z: 4, size: 1, height: 5, yaw: 0 });
    s.deleteObject(placed.id);
    const saved = s.toDoc(doc());
    expect(saved.objects.added).toHaveLength(0);
    expect(saved.objects.removed).not.toContain(placed.id);
  });

  it('re-seats objects on ground that moved under them', () => {
    const s = EditSession.open(doc());
    const placed = s.addObject({ kind: 'rock', x: 0, z: 0, size: 2, height: 2, yaw: 0 });
    const before = s.world.obstacles.find((o) => o.id === placed.id)!.y;
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    s.rebuildObjects();
    expect(s.world.obstacles.find((o) => o.id === placed.id)!.y).toBeGreaterThan(before);
  });
});

describe('spawns', () => {
  it('adds and removes spawn points', () => {
    const s = EditSession.open(doc());
    s.addSpawn({ x: 5, z: 5, yaw: 1 });
    s.addSpawn({ x: -20, z: 0, yaw: 0 });
    expect(s.spawnPoints).toHaveLength(2);
    expect(s.deleteSpawnNear(5.5, 5.5, 3)).toBe(true);
    expect(s.spawnPoints).toHaveLength(1);
    expect(s.spawnPoints[0]!.x).toBe(-20);
  });

  it('ignores a delete that lands nowhere near a spawn', () => {
    const s = EditSession.open(doc());
    s.addSpawn({ x: 5, z: 5, yaw: 1 });
    expect(s.deleteSpawnNear(40, 40, 3)).toBe(false);
    expect(s.spawnPoints).toHaveLength(1);
  });
});

describe('undo', () => {
  it('restores the ground a stroke changed', () => {
    const s = EditSession.open(doc());
    const before = fnv1aArray(s.world.terrain.heights);
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    expect(fnv1aArray(s.world.terrain.heights)).not.toBe(before);
    expect(s.undo()).toBe(true);
    expect(fnv1aArray(s.world.terrain.heights)).toBe(before);
  });

  it('groups a whole drag into one step', () => {
    const s = EditSession.open(doc());
    const before = fnv1aArray(s.world.terrain.heights);
    s.beginStroke();
    for (let i = 0; i < 10; i++) s.sculpt(i, 0, SCULPT);
    s.endStroke();
    s.undo();
    expect(fnv1aArray(s.world.terrain.heights)).toBe(before);
  });

  it('redoes what it undid', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    const after = fnv1aArray(s.world.terrain.heights);
    s.undo();
    expect(s.redo()).toBe(true);
    expect(fnv1aArray(s.world.terrain.heights)).toBe(after);
  });

  it('drops the redo stack once a new edit lands', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    s.undo();
    s.beginStroke();
    s.sculpt(20, 20, SCULPT);
    s.endStroke();
    expect(s.canRedo).toBe(false);
  });

  it('reports nothing to undo on a fresh session', () => {
    const s = EditSession.open(doc());
    expect(s.canUndo).toBe(false);
    expect(s.undo()).toBe(false);
  });

  it('restores objects and spawns too', () => {
    const s = EditSession.open(doc());
    s.addSpawn({ x: 1, z: 1, yaw: 0 });
    s.addObject({ kind: 'rock', x: 2, z: 2, size: 1, height: 1, yaw: 0 });
    s.undo();
    expect(s.world.obstacles.some((o) => o.x === 2 && o.z === 2)).toBe(false);
    s.undo();
    expect(s.spawnPoints).toHaveLength(0);
  });
});

describe('the save / load round trip', () => {
  it('reloads the exact ground that was sculpted', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(10, -10, SCULPT);
    s.sculpt(-15, 20, { ...SCULPT, mode: 'lower' });
    s.endStroke();
    s.beginStroke();
    s.paint(0, 0, { radius: 8, surface: Physics.Surface.Gravel });
    s.endStroke();

    const saved = s.toDoc(doc());
    const reloaded = Maps.applyMapDoc(saved);
    // Exact, not approximate: the session edits centimetres and derives
    // metres, so nothing is requantised on the way out.
    expect(fnv1aArray(reloaded.terrain.heights)).toBe(fnv1aArray(s.world.terrain.heights));
    expect(fnv1aArray(reloaded.terrain.surfaces)).toBe(fnv1aArray(s.world.terrain.surfaces));
  });

  it('survives a JSON round trip through the strict decoder', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    s.addSpawn({ x: 3, z: 4, yaw: 0.5 });
    s.addObject({ kind: 'pine', x: -8, z: 8, size: 1.2, height: 6, yaw: 0.2 });

    const saved = s.toDoc(doc());
    const parsed = Maps.decodeMapDoc(JSON.parse(Maps.encodeMapDoc(saved)));
    const reloaded = Maps.applyMapDoc(parsed);
    expect(fnv1aArray(reloaded.terrain.heights)).toBe(fnv1aArray(s.world.terrain.heights));
    expect(parsed.spawns).toHaveLength(1);
    expect(reloaded.obstacles.some((o) => o.kind === 'pine' && o.x === -8)).toBe(true);
  });

  it('stamps a checksum the loader accepts', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    // applyMapDoc throws BaseDriftError when the checksum disagrees with
    // the generated base, so a save that stamped the wrong one would
    // produce a file the server refuses to boot on.
    expect(() => Maps.applyMapDoc(s.toDoc(doc()))).not.toThrow();
  });

  it('bakes the composed grids and stops depending on the generator', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    const baked = s.toDoc(doc(), { bake: true });
    expect(baked.bake).toBeDefined();
    const reloaded = Maps.applyMapDoc(baked);
    // Close, not exact. The delta path is exact because it stores a
    // centimetre OFFSET and leaves the base's float precision alone;
    // bake stores absolute centimetres, so the base's sub-centimetre
    // part is what gets rounded away. Half a centimetre is the format's
    // own quantum and well under anything the suspension can feel, but
    // it does mean baking is a (tiny) edit, not a no-op.
    expectHeightsWithin(reloaded.terrain.heights, s.world.terrain.heights, 0.005);
    expect(fnv1aArray(reloaded.terrain.surfaces)).toBe(fnv1aArray(s.world.terrain.surfaces));
  });

  it('reopens a baked map as an editable delta', () => {
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    const baked = s.toDoc(doc(), { bake: true });

    const reopened = EditSession.open(baked);
    expectHeightsWithin(reopened.world.terrain.heights, s.world.terrain.heights, 0.005);
    // And it is genuinely editable again, not frozen.
    reopened.beginStroke();
    expect(reopened.sculpt(0, 0, SCULPT)).not.toBeNull();
    reopened.endStroke();
  });

  it('does not compound the bake rounding on a second round trip', () => {
    // Un-baking and re-baking must not walk the terrain a further half
    // centimetre each time, or a map edited over several sessions would
    // creep away from what its author last saw.
    const s = EditSession.open(doc());
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    const once = s.toDoc(doc(), { bake: true });
    const twice = EditSession.open(once).toDoc(once, { bake: true });
    expectHeightsWithin(
      Maps.applyMapDoc(twice).terrain.heights,
      Maps.applyMapDoc(once).terrain.heights,
      1e-6,
    );
  });

  it('rebases a document whose base has moved', () => {
    // Simulate generator drift by stamping a checksum that cannot match.
    const drifted: Maps.MapDoc = { ...doc(), baseChecksum: 12345 };
    const s = EditSession.open(drifted);
    s.beginStroke();
    s.sculpt(0, 0, SCULPT);
    s.endStroke();
    // Opening tolerated the drift; saving re-cuts the delta against the
    // base actually in this build, so the file loads cleanly again.
    expect(() => Maps.applyMapDoc(s.toDoc(drifted))).not.toThrow();
  });
});
