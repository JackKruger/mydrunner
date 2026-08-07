// The load-bearing assertion here is the first one: composing the
// procedural document must produce the same world generateTerrain does,
// byte for byte. That equivalence is what lets the document path replace
// the old one without changing the map anyone is driving on.

import { describe, it, expect } from 'vitest';
import {
  applyMapDoc, proceduralDoc, baseChecksumOf, BaseDriftError,
} from '../map/applyMapDoc.js';
import {
  decodeMapDoc, encodeMapDoc, mapDocRev, MAP_FORMAT_VERSION,
  HEIGHT_DELTA_SCALE, NO_SURFACE_OVERRIDE, WATER_NONE_CM, type MapDoc,
} from '../map/mapDoc.js';
import { encodeInt16Grid, encodeUint8Grid } from '../map/tileGrid.js';
import {
  generateTerrain, Surface, WATER_NONE, worldToTerrainIndex,
} from '../physics/terrain.js';
import { hasWater } from '../physics/water.js';
import { generateObstacles } from '../physics/obstacles.js';
import { landmarksFor } from '../physics/landmarks.js';
import { fnv1aArray } from '../hash.js';

const RES = 128;

function reparse(doc: MapDoc): MapDoc {
  return decodeMapDoc(JSON.parse(encodeMapDoc(doc)));
}

describe('the procedural document reproduces the shipped world', () => {
  const world = applyMapDoc(proceduralDoc());
  const direct = generateTerrain();

  it('produces identical heights', () => {
    expect(fnv1aArray(world.terrain.heights)).toBe(fnv1aArray(direct.heights));
  });

  it('produces identical surfaces', () => {
    expect(fnv1aArray(world.terrain.surfaces)).toBe(fnv1aArray(direct.surfaces));
  });

  it('produces the identical obstacle set', () => {
    const a = world.obstacles.map((o) => o.id).join('|');
    const b = generateObstacles(direct).map((o) => o.id).join('|');
    expect(a).toBe(b);
    expect(world.obstacles.length).toBe(generateObstacles(direct).length);
  });

  it('produces the identical landmarks', () => {
    expect(world.landmarks).toEqual(landmarksFor(direct));
  });

  it('survives a save/load round trip unchanged', () => {
    const composed = applyMapDoc(reparse(proceduralDoc()));
    expect(fnv1aArray(composed.terrain.heights)).toBe(fnv1aArray(direct.heights));
    expect(fnv1aArray(composed.terrain.surfaces)).toBe(fnv1aArray(direct.surfaces));
  });

  it('composes deterministically', () => {
    const again = applyMapDoc(proceduralDoc());
    expect(fnv1aArray(again.terrain.heights)).toBe(fnv1aArray(world.terrain.heights));
  });
});

describe('authored edits', () => {
  function docWithHill(): MapDoc {
    const doc = proceduralDoc();
    const delta = new Int16Array(RES * RES);
    // +5 m over a small block, well away from roads and the pad.
    for (let r = 20; r < 26; r++) for (let c = 20; c < 26; c++) {
      delta[r * RES + c] = 5 * HEIGHT_DELTA_SCALE;
    }
    doc.heightDelta = encodeInt16Grid(delta, RES);
    return doc;
  }

  it('raises the terrain by exactly the delta', () => {
    const base = generateTerrain();
    const world = applyMapDoc(docWithHill());
    const i = 22 * RES + 22;
    expect(world.terrain.heights[i]! - base.heights[i]!).toBeCloseTo(5, 5);
  });

  it('leaves untouched cells exactly alone', () => {
    const base = generateTerrain();
    const world = applyMapDoc(docWithHill());
    const i = 100 * RES + 100;
    expect(world.terrain.heights[i]).toBe(base.heights[i]);
  });

  it('applies a surface override, including surface id 0', () => {
    const doc = proceduralDoc();
    const over = new Uint8Array(RES * RES).fill(NO_SURFACE_OVERRIDE);
    over[40 * RES + 40] = Surface.DeepMud;
    over[41 * RES + 41] = Surface.Road; // id 0 must not read as "no override"
    doc.surfaceOverride = encodeUint8Grid(over, RES, NO_SURFACE_OVERRIDE);
    const world = applyMapDoc(doc);
    expect(world.terrain.surfaces[40 * RES + 40]).toBe(Surface.DeepMud);
    expect(world.terrain.surfaces[41 * RES + 41]).toBe(Surface.Road);
  });

  // Surface painting is the only route to mud today — the generator's
  // mudSurfaceRule cannot override Dirt. See terrainOverrides.test.ts.
  it('is how a map gets mud onto the road', () => {
    const doc = proceduralDoc();
    const over = new Uint8Array(RES * RES).fill(NO_SURFACE_OVERRIDE);
    const idx = worldToTerrainIndex(generateTerrain(), 0, -50);
    over[idx] = Surface.DeepMud;
    doc.surfaceOverride = encodeUint8Grid(over, RES, NO_SURFACE_OVERRIDE);
    expect(applyMapDoc(doc).terrain.surfaces[idx]).toBe(Surface.DeepMud);
  });
});

describe('authored objects', () => {
  it('re-seats a placed object onto sculpted ground instead of a stored y', () => {
    const doc = proceduralDoc();
    const delta = new Int16Array(RES * RES);
    for (let r = 18; r < 30; r++) for (let c = 18; c < 30; c++) {
      delta[r * RES + c] = 6 * HEIGHT_DELTA_SCALE;
    }
    doc.heightDelta = encodeInt16Grid(delta, RES);

    const flat = proceduralDoc();
    const placed = {
      id: 'authored-rock', kind: 'rock' as const,
      x: -120, z: -120, size: 1, height: 0, yaw: 0,
    };
    // Same object, on the sculpted doc and the flat one.
    const at = (d: MapDoc) => {
      d.objects.added = [{ ...placed, x: cellX(22), z: cellZ(22) }];
      const w = applyMapDoc(d);
      return w.obstacles.find((o) => o.id === 'authored-rock')!.y;
    };
    expect(at(doc) - at(flat)).toBeCloseTo(6, 1);
  });

  it('honours yOffset', () => {
    const a = proceduralDoc();
    a.objects.added = [{ id: 'p', kind: 'rock', x: 0, z: 100, size: 1, height: 0, yaw: 0 }];
    const b = proceduralDoc();
    b.objects.added = [{ id: 'p', kind: 'rock', x: 0, z: 100, size: 1, height: 0, yaw: 0, yOffset: 3 }];
    const ya = applyMapDoc(a).obstacles.find((o) => o.id === 'p')!.y;
    const yb = applyMapDoc(b).obstacles.find((o) => o.id === 'p')!.y;
    expect(yb - ya).toBeCloseTo(3, 6);
  });

  it('removes a procedural obstacle by id', () => {
    const doc = proceduralDoc();
    const victim = applyMapDoc(doc).obstacles[5]!.id;
    doc.objects.removed = [victim];
    expect(applyMapDoc(doc).obstacles.some((o) => o.id === victim)).toBe(false);
  });

  it('can drop the procedural set entirely', () => {
    const doc = proceduralDoc();
    doc.objects.includeProcedural = false;
    expect(applyMapDoc(doc).obstacles).toEqual([]);
  });
});

describe('base drift', () => {
  function driftedDoc(): MapDoc {
    const doc = proceduralDoc();
    const delta = new Int16Array(RES * RES);
    delta[50 * RES + 50] = 200;
    doc.heightDelta = encodeInt16Grid(delta, RES);
    doc.baseChecksum = 12345; // as if the generator had moved under it
    return doc;
  }

  it('throws when a delta was cut against a base that has since changed', () => {
    expect(() => applyMapDoc(driftedDoc())).toThrow(BaseDriftError);
  });

  it('can be opened anyway, which is what the editor does to offer a rebase', () => {
    expect(() => applyMapDoc(driftedDoc(), { onBaseDrift: 'ignore' })).not.toThrow();
  });

  it('does not fire for a document with no edits to reinterpret', () => {
    const doc = proceduralDoc();
    doc.baseChecksum = 999;
    expect(() => applyMapDoc(doc)).not.toThrow();
  });

  it('does not fire for a baked document, whose terrain ignores the generator', () => {
    const doc = driftedDoc();
    const heights = new Int16Array(RES * RES).fill(3 * HEIGHT_DELTA_SCALE);
    doc.bake = {
      heights: encodeInt16Grid(heights, RES),
      surfaces: encodeUint8Grid(new Uint8Array(RES * RES).fill(Surface.Gravel), RES, 0),
    };
    const world = applyMapDoc(doc);
    expect(world.terrain.heights[0]).toBeCloseTo(3, 5);
    expect(world.terrain.surfaces[0]).toBe(Surface.Gravel);
  });

  it('restores baked heights at centimetre precision, not whole metres', () => {
    // The case above bakes exactly 3 m, which survives a truncating
    // divide unchanged — so it passed while every fractional height in a
    // baked map was being floored. TypedArray.map returns the same typed
    // array kind, which is what did the flooring. Pick heights whose
    // centimetre part matters.
    const doc = driftedDoc();
    const heights = new Int16Array(RES * RES);
    for (let i = 0; i < heights.length; i++) heights[i] = 250 + (i % 7); // 2.50 - 2.56 m
    doc.bake = {
      heights: encodeInt16Grid(heights, RES),
      surfaces: encodeUint8Grid(new Uint8Array(RES * RES).fill(Surface.Dirt), RES, 0),
    };
    const world = applyMapDoc(doc);
    expect(world.terrain.heights[0]).toBeCloseTo(2.5, 6);
    expect(world.terrain.heights[3]).toBeCloseTo(2.53, 6);
    expect(world.terrain.heights[6]).toBeCloseTo(2.56, 6);
  });

  it('records a checksum that matches the base it was built from', () => {
    const doc = proceduralDoc();
    expect(doc.baseChecksum).toBe(baseChecksumOf(generateTerrain()));
  });
});

describe('document revision', () => {
  it('is stable across a re-encode', () => {
    const doc = proceduralDoc();
    expect(mapDocRev(reparse(doc))).toBe(mapDocRev(doc));
  });

  it('ignores key order', () => {
    const doc = proceduralDoc();
    // Same content, keys inserted in the opposite order — what a hand-edit
    // or a different serialiser would produce.
    const reversed = Object.fromEntries(
      Object.entries(doc as unknown as Record<string, unknown>).reverse(),
    ) as unknown as MapDoc;
    expect(Object.keys(reversed)[0]).not.toBe(Object.keys(doc)[0]);
    expect(mapDocRev(reversed)).toBe(mapDocRev(doc));
  });

  it('changes when any content changes', () => {
    const doc = proceduralDoc();
    const before = mapDocRev(doc);
    expect(mapDocRev({ ...doc, name: 'Something Else' })).not.toBe(before);
    expect(mapDocRev({ ...doc, spawns: [{ x: 1, z: 2, yaw: 0 }] })).not.toBe(before);
  });
});

describe('decodeMapDoc rejects malformed documents', () => {
  const bad = (mutate: (d: Record<string, unknown>) => void, why: RegExp) => {
    const raw = JSON.parse(encodeMapDoc(proceduralDoc()));
    mutate(raw);
    expect(() => decodeMapDoc(raw)).toThrow(why);
  };

  it('rejects a future format version', () => {
    bad((d) => { d.formatVersion = MAP_FORMAT_VERSION + 1; }, /formatVersion/);
  });
  it('rejects a non-object', () => {
    expect(() => decodeMapDoc('nope')).toThrow(/must be an object/);
  });
  it('rejects NaN and Infinity', () => {
    bad((d) => { (d.base as Record<string, unknown>).seed = null; }, /finite number/);
  });
  it('rejects a grid whose resolution disagrees with the map', () => {
    bad((d) => { (d.heightDelta as Record<string, unknown>).n = 64; }, /resolution cannot be changed/);
  });
  it('rejects an unknown obstacle kind', () => {
    bad((d) => {
      (d.objects as Record<string, unknown>).added = [
        { id: 'x', kind: 'spaceship', x: 0, z: 0, size: 1, height: 1, yaw: 0 },
      ];
    }, /not a known obstacle kind/);
  });
  it('rejects an unknown marker kind', () => {
    bad((d) => {
      d.markers = [{ id: 'm', kind: 'wormhole', x: 0, y: 0, z: 0, radius: 1, label: '' }];
    }, /not a known marker kind/);
  });
  it('rejects a road with a single point', () => {
    bad((d) => {
      d.roads = [{ points: [{ x: 0, z: 0 }], width: 4, surface: 0, shoulderWidth: 1 }];
    }, /at least 2 points/);
  });
  it('rejects a missing required field', () => {
    bad((d) => { delete d.spawns; }, /spawns must be an array/);
  });
  it('rejects a document with no water block', () => {
    bad((d) => { delete d.water; }, /water must be an object/);
  });
  it('rejects a water grid at the wrong resolution', () => {
    bad((d) => {
      ((d.water as Record<string, unknown>).level as Record<string, unknown>).n = 64;
    }, /resolution cannot be changed/);
  });
});

describe('authored water', () => {
  it('composes to a dry terrain when the document has no water', () => {
    const world = applyMapDoc(proceduralDoc());
    expect(hasWater(world.terrain)).toBe(false);
    expect(world.terrain.waterLevel[0]).toBe(WATER_NONE);
  });

  it('stores no tiles for an empty water block', () => {
    const doc = proceduralDoc();
    expect(doc.water.level.cells).toHaveLength(0);
    expect(doc.water.flowX.cells).toHaveLength(0);
    expect(doc.water.flowZ.cells).toHaveLength(0);
  });

  it('round-trips levels and flow through the document', () => {
    const doc = proceduralDoc();
    const level = new Int16Array(RES * RES).fill(WATER_NONE_CM);
    const flowX = new Int16Array(RES * RES);
    const flowZ = new Int16Array(RES * RES);
    // A 3-cell puddle at a known spot, 0.75 m up, drifting +x at 1.8 m/s.
    const at = 40 * RES + 40;
    for (let k = 0; k < 3; k++) {
      level[at + k] = 75;
      flowX[at + k] = 180;
      flowZ[at + k] = -25;
    }
    doc.water = {
      level: encodeInt16Grid(level, RES, WATER_NONE_CM),
      flowX: encodeInt16Grid(flowX, RES),
      flowZ: encodeInt16Grid(flowZ, RES),
    };

    const world = applyMapDoc(reparse(doc));
    expect(world.terrain.waterLevel[at]).toBeCloseTo(0.75, 6);
    expect(world.terrain.waterFlowX[at]).toBeCloseTo(1.8, 6);
    expect(world.terrain.waterFlowZ[at]).toBeCloseTo(-0.25, 6);
    // And everywhere else is still dry.
    expect(world.terrain.waterLevel[0]).toBe(WATER_NONE);
    expect(hasWater(world.terrain)).toBe(true);
  });

  it('survives a bake: water is authored, not generated, so freezing the ground leaves it alone', () => {
    const doc = proceduralDoc();
    const level = new Int16Array(RES * RES).fill(WATER_NONE_CM);
    level[100] = -40;
    doc.water = { ...doc.water, level: encodeInt16Grid(level, RES, WATER_NONE_CM) };
    doc.bake = {
      heights: encodeInt16Grid(new Int16Array(RES * RES), RES),
      surfaces: encodeUint8Grid(new Uint8Array(RES * RES).fill(Surface.Dirt), RES, 0),
    };
    const world = applyMapDoc(doc);
    expect(world.terrain.waterLevel[100]).toBeCloseTo(-0.4, 6);
  });

  it('is not part of the base checksum', () => {
    // Water cannot drift against the generator because the generator
    // never makes any, so adding water must not invalidate a delta.
    const dry = proceduralDoc();
    const wet = proceduralDoc();
    const level = new Int16Array(RES * RES).fill(WATER_NONE_CM);
    level[7] = 120;
    wet.water = { ...wet.water, level: encodeInt16Grid(level, RES, WATER_NONE_CM) };
    expect(wet.baseChecksum).toBe(dry.baseChecksum);
  });

});

function cellX(c: number): number {
  return (c / (RES - 1) - 0.5) * 320;
}
function cellZ(r: number): number {
  return (r / (RES - 1) - 0.5) * 320;
}
