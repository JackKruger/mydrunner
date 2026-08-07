// The spawn grid, pinned.
//
// This rule used to be private to Room. It moved to shared so the editor's
// offline preview and the multiplayer relay answer "where do I start"
// identically — and the moment two callers share it, the arithmetic needs a
// test of its own rather than only the behavioural one in
// server/room-spawn.test.ts ("ends up on the road, upright"), which would
// pass just as happily if every slot collapsed onto the same point.

import { describe, it, expect, beforeAll } from 'vitest';
import { TERRAIN } from '../constants.js';
import { initRapier } from '../physics/world.js';
import { spawnYAboveGround } from '../physics/vehicleGeom.js';
import { applyMapDoc, proceduralDoc } from '../map/applyMapDoc.js';
import { gridSpawn, resolveSpawn, SPAWN_SLOTS } from '../map/spawn.js';

const SIZE = 320;

describe('grid spawn', () => {
  it('lays 8 columns across two road lanes', () => {
    for (let slot = 0; slot < SPAWN_SLOTS; slot++) {
      const col = slot % 8;
      const row = Math.floor(slot / 8);
      const s = gridSpawn(SIZE, slot);
      expect(s.x).toBeCloseTo(-SIZE / 2 + 24 + col * 5, 9);
      expect(s.z).toBeCloseTo(TERRAIN.roadZ + (row === 0 ? -1.2 : 1.2), 9);
      // yaw = pi/2 rotates local +Z (vehicle forward) onto world +X.
      expect(s.yaw).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it('keeps adjacent slots 5 m apart', () => {
    // Trucks are 3.8 m long; anything tighter spawns two players
    // overlapping, which can push one through the heightfield.
    for (let slot = 0; slot < 7; slot++) {
      const a = gridSpawn(SIZE, slot);
      const b = gridSpawn(SIZE, slot + 1);
      expect(b.x - a.x).toBeCloseTo(5, 9);
    }
  });

  it('scales the start line with the world', () => {
    expect(gridSpawn(200, 0).x).toBeCloseTo(-100 + 24, 9);
    expect(gridSpawn(640, 0).x).toBeCloseTo(-320 + 24, 9);
  });
});

describe('resolveSpawn', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('falls back to the road grid when a map authors no spawns', () => {
    const map = applyMapDoc(proceduralDoc());
    expect(map.spawns).toHaveLength(0);
    for (const slot of [0, 5, 9, 15]) {
      const grid = gridSpawn(map.terrain.size, slot);
      const s = resolveSpawn(map, slot, 'patrol');
      expect(s.position.x).toBeCloseTo(grid.x, 9);
      expect(s.position.z).toBeCloseTo(grid.z, 9);
      expect(s.yaw).toBeCloseTo(grid.yaw, 9);
    }
  });

  it('sits the truck at its suspension equilibrium, not on the ground', () => {
    const map = applyMapDoc(proceduralDoc());
    for (const kind of ['patrol', 'hilux', 'ute', 'motorbike'] as const) {
      const s = resolveSpawn(map, 0, kind);
      // The main road is graded flat at y=0, so the offset is the whole
      // height — no free-fall, no settle bounce.
      expect(s.position.y).toBeCloseTo(spawnYAboveGround(kind), 6);
    }
  });

  it('prefers authored spawns and cycles them by slot', () => {
    const authored = [
      { x: 10, z: 20, yaw: 0.5 },
      { x: -30, z: 40, yaw: -1.25 },
    ];
    const map = applyMapDoc({ ...proceduralDoc(), spawns: authored });
    for (let slot = 0; slot < 5; slot++) {
      const want = authored[slot % authored.length]!;
      const s = resolveSpawn(map, slot, 'patrol');
      expect(s.position.x).toBeCloseTo(want.x, 9);
      expect(s.position.z).toBeCloseTo(want.z, 9);
      expect(s.yaw).toBeCloseTo(want.yaw, 9);
    }
  });

  it('never returns a non-finite pose, even off the map', () => {
    const map = applyMapDoc({
      ...proceduralDoc(), spawns: [{ x: 1e6, z: -1e6, yaw: 0 }],
    });
    const s = resolveSpawn(map, 0, 'patrol');
    for (const v of [s.position.x, s.position.y, s.position.z, s.yaw]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
