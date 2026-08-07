// The valley river as shipped in the default map.
//
// These pin the crossing's design intent, not its exact geometry: the
// river is authored by scripts/carveRiver.ts and its numbers will be
// retuned. What must not silently change is the shape of the decision it
// puts in front of the player — a road ford that most rigs can take, a
// river either side that punishes leaving it, and a current that shoves
// you while you cross.

import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT, type CarKind } from '../types.js';
import { applyMapDoc, baseChecksumOf } from '../map/applyMapDoc.js';
import { defaultMap } from '../map/maps/defaultMap.js';
import { gridSpawn, resolveSpawn } from '../map/spawn.js';
import { TERRAIN } from '../constants.js';
import { generateTerrain, sampleHeightBilinear } from '../physics/terrain.js';
import { hasWater, sampleWaterDepth, sampleWaterFlow } from '../physics/water.js';
import { World, initRapier } from '../physics/world.js';

beforeAll(async () => {
  await initRapier();
});

const map = applyMapDoc(defaultMap);
const FORD_X = -40;
const ROAD_Z = TERRAIN.roadZ;

describe('the map still composes', () => {
  it('carries water', () => {
    expect(hasWater(map.terrain)).toBe(true);
  });

  it('did not move the procedural base', () => {
    // The river is document data, not a height layer. If someone moves
    // it into the generator this fails, and every authored map's delta
    // silently starts meaning something different.
    expect(defaultMap.baseChecksum).toBe(baseChecksumOf(generateTerrain({
      seed: defaultMap.base.seed,
      size: defaultMap.base.size,
      resolution: defaultMap.base.resolution,
      roads: defaultMap.roads.length ? defaultMap.roads : undefined,
      bogs: defaultMap.bogs,
      pad: defaultMap.pad,
    })));
  });

  it('leaves every spawn slot on dry land', () => {
    for (let slot = 0; slot < 16; slot++) {
      const { x, z } = gridSpawn(map.terrain.size, slot);
      expect(sampleWaterDepth(map.terrain, x, z)).toBe(0);
    }
  });

  it('spawns the player above the ground, not in the river', () => {
    const pose = resolveSpawn(map, 0, 'patrol');
    expect(sampleWaterDepth(map.terrain, pose.position.x, pose.position.z)).toBe(0);
  });
});

describe('the ford', () => {
  it('crosses the main road', () => {
    expect(sampleWaterDepth(map.terrain, FORD_X, ROAD_Z)).toBeGreaterThan(1);
  });

  it('is far enough from spawn to arrive at speed', () => {
    const spawn = gridSpawn(map.terrain.size, 0);
    expect(FORD_X - spawn.x).toBeGreaterThan(60);
  });

  it('has banks that shelve rather than a wall', () => {
    // A step-sided channel is a collision, not a crossing.
    const deep = sampleWaterDepth(map.terrain, FORD_X, ROAD_Z);
    const mid = sampleWaterDepth(map.terrain, FORD_X - 12, ROAD_Z);
    const edge = sampleWaterDepth(map.terrain, FORD_X - 18, ROAD_Z);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(deep);
    expect(edge).toBeLessThan(mid);
  });

  it('is the shallowest point on the river', () => {
    // A road crosses where the water is shallow. That is why real fords
    // exist, and it is what stops the map's main artery being a wall.
    const ford = sampleWaterDepth(map.terrain, FORD_X, ROAD_Z);
    expect(sampleWaterDepth(map.terrain, -45, -75)).toBeGreaterThan(ford);
    expect(sampleWaterDepth(map.terrain, -34, -18)).toBeGreaterThan(ford);
  });

  it('flows downstream, roughly along the channel', () => {
    const flow = sampleWaterFlow(map.terrain, FORD_X, ROAD_Z, { x: 0, z: 0 });
    const speed = Math.hypot(flow.x, flow.z);
    expect(speed).toBeGreaterThan(0.5);
    // The river runs north to south here, so the current is mostly -z:
    // across a road that runs along x, which is what makes it a shove
    // rather than a headwind.
    expect(flow.z).toBeLessThan(0);
    expect(Math.abs(flow.z)).toBeGreaterThan(Math.abs(flow.x));
  });
});

/** Drive from the road west of the ford toward the far bank. */
function cross(kind: CarKind): { crossed: boolean; drowned: boolean; drift: number } {
  const world = new World({ map });
  const y = sampleHeightBilinear(map.terrain, -80, ROAD_Z) + 1.6;
  const v = world.spawnVehicle('p', { position: { x: -80, y, z: ROAD_Z }, yaw: Math.PI / 2 }, kind);
  let crossed = false;
  let drowned = false;
  let drift = 0;
  for (let i = 0; i < 60 * 40; i++) {
    v.setInput({ ...EMPTY_INPUT, seq: i + 1, throttle: 0.6 });
    world.step();
    const s = v.getState();
    if (v.waterStatus?.().drowned) drowned = true;
    drift = Math.max(drift, Math.abs(s.position.z - ROAD_Z));
    if (s.position.x > -18) { crossed = true; break; }
  }
  world.dispose();
  return { crossed, drowned, drift };
}

describe('driving the ford', () => {
  it('lets the snorkelled Patrol through', () => {
    const r = cross('patrol');
    expect(r.crossed).toBe(true);
    expect(r.drowned).toBe(false);
  });

  it('lets the Hilux and Ute through too', () => {
    // The road ford is the map's main artery; walling off most of the
    // garage would make the whole east half a vehicle-select screen.
    for (const kind of ['hilux', 'ute'] as CarKind[]) {
      const r = cross(kind);
      expect(r.crossed, `${kind} should cross`).toBe(true);
      expect(r.drowned, `${kind} should not drown`).toBe(false);
    }
  });

  it('drowns the motorbike', () => {
    // Lowest airbox and nothing sealed around it. Picking a rig for the
    // route is the point of having four of them.
    const r = cross('motorbike');
    expect(r.drowned).toBe(true);
  });

  it('shoves you downstream on the way across', () => {
    // The whole reason to author a flow field. Too little and the river
    // is a puddle; too much and you lose the road entirely.
    const drift = cross('patrol').drift;
    expect(drift).toBeGreaterThan(2);
    expect(drift).toBeLessThan(30);
  });
});
