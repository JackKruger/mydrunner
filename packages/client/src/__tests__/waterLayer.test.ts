// The editor's water layer, and its trip through undo and the document.
//
// The undo assertions are the ones that matter most: water state lives
// in three arrays that have to be threaded through snapshot, restore and
// toDoc, and missing any one of them loses edits silently rather than
// failing.

import { describe, expect, it } from 'vitest';
import { Maps, Physics } from '@mydrunner/shared';
import { EditSession } from '../editor/editSession.js';

function doc(): Maps.MapDoc {
  return Maps.proceduralDoc({ size: 100, resolution: 32 });
}

function open(): EditSession {
  return EditSession.open(doc());
}

/** Water level at a world point, or null if dry. */
function levelAt(s: EditSession, x: number, z: number): number | null {
  const i = Physics.worldToTerrainIndex(s.world.terrain, x, z);
  if (i < 0) return null;
  const v = s.world.terrain.waterLevel[i]!;
  return Physics.isWet(v) ? v : null;
}

function wetCells(s: EditSession): number {
  let n = 0;
  for (const v of s.world.terrain.waterLevel) if (Physics.isWet(v)) n += 1;
  return n;
}

describe('the water brush', () => {
  it('floods to the requested depth above the ground', () => {
    const s = open();
    const ground = Physics.sampleHeightBilinear(s.world.terrain, 0, 0);
    s.paintWater(0, 0, { radius: 8, depth: 1.2 });
    expect(levelAt(s, 0, 0)).toBeCloseTo(ground + 1.2, 4);
  });

  it('lays a flat surface over uneven ground', () => {
    // The reason depth is measured once at the stroke centre: per-cell
    // would follow the bumps underneath, which is wet ground, not a pond.
    const s = open();
    s.paintWater(0, 0, { radius: 10, depth: 1.5 });
    const levels: number[] = [];
    for (let i = 0; i < s.world.terrain.waterLevel.length; i++) {
      const v = s.world.terrain.waterLevel[i]!;
      if (Physics.isWet(v)) levels.push(v);
    }
    expect(levels.length).toBeGreaterThan(4);
    expect(Math.max(...levels) - Math.min(...levels)).toBeCloseTo(0, 6);
  });

  it('grades a river when dragged down a slope', () => {
    const s = open();
    // Raise one end so the two stroke centres sit at different heights.
    s.beginStroke();
    s.sculpt(-20, 0, { radius: 14, strength: 30, hardness: 1, mode: 'raise', dt: 1 });
    s.endStroke();
    s.paintWater(-20, 0, { radius: 6, depth: 0.8 });
    s.paintWater(20, 0, { radius: 6, depth: 0.8 });
    const up = levelAt(s, -20, 0);
    const down = levelAt(s, 20, 0);
    expect(up).not.toBeNull();
    expect(down).not.toBeNull();
    expect(up!).toBeGreaterThan(down!);
  });

  it('does not cut notches where strokes overlap', () => {
    // Overlapping strokes along a river must not lower water already
    // laid, or the surface ends up scalloped.
    const s = open();
    s.paintWater(0, 0, { radius: 10, depth: 2 });
    const deep = levelAt(s, 0, 0)!;
    s.paintWater(0, 0, { radius: 10, depth: 0.2 });
    expect(levelAt(s, 0, 0)).toBeCloseTo(deep, 6);
  });

  it('erases back to dry', () => {
    const s = open();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    expect(wetCells(s)).toBeGreaterThan(0);
    s.eraseWater(0, 0, { radius: 20 });
    expect(wetCells(s)).toBe(0);
  });
});

describe('flow', () => {
  it('writes a normalised velocity at the requested speed', () => {
    const s = open();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    s.paintFlow(0, 0, { radius: 10, dirX: 3, dirZ: 0, speed: 2 });
    const i = Physics.worldToTerrainIndex(s.world.terrain, 0, 0);
    expect(s.world.terrain.waterFlowX[i]).toBeCloseTo(2, 5);
    expect(s.world.terrain.waterFlowZ[i]).toBeCloseTo(0, 5);
  });

  it('leaves dry cells alone', () => {
    // Flow with no water is invisible and unsimulated, and would become
    // a surprise current the moment someone flooded the cell later.
    const s = open();
    s.paintFlow(0, 0, { radius: 10, dirX: 1, dirZ: 0, speed: 2 });
    const i = Physics.worldToTerrainIndex(s.world.terrain, 0, 0);
    expect(s.world.terrain.waterFlowX[i]).toBe(0);
  });

  it('ignores a zero-length drag', () => {
    const s = open();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    expect(s.paintFlow(0, 0, { radius: 10, dirX: 0, dirZ: 0, speed: 2 })).toBeNull();
  });

  it('auto-flow leaves a flat pond still', () => {
    // A pond's surface is flat by construction, so its gradient is zero.
    // Deriving from the BED instead would give it a current wherever the
    // bottom happened to slope, which is exactly wrong.
    const s = open();
    s.paintWater(0, 0, { radius: 12, depth: 1.5 });
    s.autoFlow(2);
    const i = Physics.worldToTerrainIndex(s.world.terrain, 0, 0);
    expect(Math.hypot(s.world.terrain.waterFlowX[i]!, s.world.terrain.waterFlowZ[i]!))
      .toBeCloseTo(0, 5);
  });

  it('auto-flow runs a graded river downhill', () => {
    const s = open();
    s.beginStroke();
    s.sculpt(-25, 0, { radius: 16, strength: 40, hardness: 1, mode: 'raise', dt: 1 });
    s.endStroke();
    // A chain of strokes from the high end to the low end.
    for (let x = -25; x <= 25; x += 5) s.paintWater(x, 0, { radius: 5, depth: 0.8 });
    s.autoFlow(2);
    const i = Physics.worldToTerrainIndex(s.world.terrain, 0, 0);
    // Downhill is +x, since the raise was at -x.
    expect(s.world.terrain.waterFlowX[i]!).toBeGreaterThan(0);
  });

  it('auto-flow reports nothing to do on a dry map', () => {
    expect(open().autoFlow(2)).toBeNull();
  });
});

describe('undo', () => {
  it('reverts a water stroke', () => {
    const s = open();
    s.beginStroke();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    s.endStroke();
    expect(wetCells(s)).toBeGreaterThan(0);
    expect(s.undo()).toBe(true);
    expect(wetCells(s)).toBe(0);
  });

  it('reverts an erase', () => {
    const s = open();
    s.beginStroke();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    s.endStroke();
    const before = wetCells(s);

    s.beginStroke();
    s.eraseWater(0, 0, { radius: 20 });
    s.endStroke();
    expect(wetCells(s)).toBe(0);

    expect(s.undo()).toBe(true);
    expect(wetCells(s)).toBe(before);
  });

  it('reverts a flow stamp', () => {
    const s = open();
    s.beginStroke();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    s.endStroke();

    s.beginStroke();
    s.paintFlow(0, 0, { radius: 10, dirX: 1, dirZ: 0, speed: 3 });
    s.endStroke();
    const i = Physics.worldToTerrainIndex(s.world.terrain, 0, 0);
    expect(s.world.terrain.waterFlowX[i]).toBeCloseTo(3, 5);

    expect(s.undo()).toBe(true);
    expect(s.world.terrain.waterFlowX[i]).toBe(0);
  });

  it('reverts auto-flow', () => {
    const s = open();
    s.beginStroke();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    s.endStroke();
    s.autoFlow(2);
    expect(s.undo()).toBe(true);
    const i = Physics.worldToTerrainIndex(s.world.terrain, 0, 0);
    expect(s.world.terrain.waterFlowX[i]).toBe(0);
    // and the water itself survives, since that was a separate step
    expect(wetCells(s)).toBeGreaterThan(0);
  });

  it('does not disturb water when undoing a sculpt', () => {
    const s = open();
    s.beginStroke();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    s.endStroke();
    const before = wetCells(s);

    s.beginStroke();
    s.sculpt(30, 30, { radius: 10, strength: 5, hardness: 1, mode: 'raise', dt: 1 });
    s.endStroke();
    expect(s.undo()).toBe(true);
    expect(wetCells(s)).toBe(before);
  });
});

describe('round trip through the document', () => {
  it('reloads as what was painted', () => {
    const s = open();
    s.paintWater(0, 0, { radius: 10, depth: 1.25 });
    s.paintFlow(0, 0, { radius: 10, dirX: 0, dirZ: 1, speed: 1.75 });
    const level = levelAt(s, 0, 0)!;

    const saved = s.toDoc(doc());
    const reopened = EditSession.open(Maps.decodeMapDoc(JSON.parse(Maps.encodeMapDoc(saved))));

    // Centimetre quantisation is the format's own quantum.
    expect(levelAt(reopened, 0, 0)).toBeCloseTo(level, 2);
    const i = Physics.worldToTerrainIndex(reopened.world.terrain, 0, 0);
    expect(reopened.world.terrain.waterFlowZ[i]).toBeCloseTo(1.75, 2);
  });

  it('saves a dry map with no stored water tiles', () => {
    const saved = open().toDoc(doc());
    expect(saved.water.level.cells).toHaveLength(0);
    expect(saved.water.flowX.cells).toHaveLength(0);
  });

  it('keeps water through a bake', () => {
    // Baking freezes the ground. Water is authored rather than
    // generated, so it has nothing to freeze and must survive intact.
    const s = open();
    s.paintWater(0, 0, { radius: 10, depth: 1 });
    const level = levelAt(s, 0, 0)!;
    const saved = s.toDoc(doc(), { bake: true });
    expect(saved.bake).toBeDefined();
    const reopened = EditSession.open(saved);
    expect(levelAt(reopened, 0, 0)).toBeCloseTo(level, 2);
  });
});
