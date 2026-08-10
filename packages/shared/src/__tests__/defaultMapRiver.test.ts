// Acceptance checks for the authored default map. Route-specific geometry
// belongs to the map document, so replacing that document must not leave
// tests pinned to coordinates from the previous level.

import { describe, expect, it } from 'vitest';
import { applyMapDoc, baseChecksumOf } from '../map/applyMapDoc.js';
import { defaultMap } from '../map/maps/defaultMap.js';
import { gridSpawn, resolveSpawn } from '../map/spawn.js';
import { generateTerrain } from '../physics/terrain.js';
import { hasWater, sampleWaterDepth } from '../physics/water.js';

const map = applyMapDoc(defaultMap);

describe('the authored default map', () => {
  it('matches the procedural base it was authored against', () => {
    expect(defaultMap.baseChecksum).toBe(baseChecksumOf(generateTerrain({
      seed: defaultMap.base.seed,
      size: defaultMap.base.size,
      resolution: defaultMap.base.resolution,
      roads: defaultMap.roads.length ? defaultMap.roads : undefined,
      bogs: defaultMap.bogs,
      pad: defaultMap.pad,
    })));
  });

  it('composes finite terrain grids at the declared resolution', () => {
    const cells = defaultMap.base.resolution ** 2;
    expect(map.terrain.heights).toHaveLength(cells);
    expect(map.terrain.surfaces).toHaveLength(cells);
    expect(Array.from(map.terrain.heights).every(Number.isFinite)).toBe(true);
  });

  it('retains its authored water layer', () => {
    expect(hasWater(map.terrain)).toBe(true);
  });

  it('keeps every fallback spawn slot on dry land', () => {
    for (let slot = 0; slot < 16; slot++) {
      const { x, z } = gridSpawn(map.terrain.size, slot);
      expect(sampleWaterDepth(map.terrain, x, z)).toBe(0);
    }
  });

  it('resolves the first player above dry ground', () => {
    const pose = resolveSpawn(map, 0, 'patrol');
    expect(sampleWaterDepth(map.terrain, pose.position.x, pose.position.z)).toBe(0);
    expect(Number.isFinite(pose.position.y)).toBe(true);
  });

  it('has unique authored object and marker ids', () => {
    const objectIds = defaultMap.objects.added.map((object) => object.id);
    const markerIds = defaultMap.markers.map((marker) => marker.id);
    expect(new Set(objectIds).size).toBe(objectIds.length);
    expect(new Set(markerIds).size).toBe(markerIds.length);
  });
});
