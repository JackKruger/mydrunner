// Where a player starts.
//
// Extracted from Room so the authoritative server and the editor's offline
// preview cannot drift apart: a preview that puts you somewhere the server
// would not is a preview of a different map, and the divergence would only
// show up as "it drove fine in the editor".
//
// Slot *allocation* stays in Room — who is currently occupying which slot
// is the room's business, not the map's. This module only answers "where is
// slot N on this map".

import { TERRAIN } from '../constants.js';
import type { CarKind } from '../types.js';
import { spawnYAboveGround } from '../physics/vehicleGeom.js';
import { worldToTerrainIndex } from '../physics/terrain.js';
import type { MapWorld } from './applyMapDoc.js';

/** 8 columns × 2 road lanes. Past this every slot is live and an overlap
 *  is unavoidable with this grid; wrapping beats refusing the connection. */
export const SPAWN_SLOTS = 16;

export interface SpawnPose {
  position: { x: number; y: number; z: number };
  yaw: number;
}

/** The default: a grid at the start of the road (the -X end of the world),
 *  facing along +X so pressing W drives toward the petrol station and then
 *  the mountain. */
export function gridSpawn(worldSize: number, slot: number): { x: number; z: number; yaw: number } {
  const col = slot % 8;
  const row = Math.floor(slot / 8);
  const startX = -worldSize / 2 + 24; // 24m in from the world edge
  // 5m spacing between slots: trucks are 3.8m long, so anything tighter
  // means two players in adjacent slots spawn overlapping each other,
  // which can push one through the heightfield and trip the off-map
  // ejector. 5m gives about 1m of clearance.
  return {
    x: startX + col * 5,
    z: TERRAIN.roadZ + (row === 0 ? -1.2 : 1.2), // two lanes on the main road
    // yaw = pi/2 rotates local +Z (vehicle forward) to world +X.
    yaw: Math.PI / 2,
  };
}

/** Where slot `slot` starts on this map, for this car kind.
 *
 *  An authored map's spawn points win when it has any; the road grid is the
 *  fallback, and is what the procedural map (which authors no spawns) still
 *  uses. Slots cycle the authored list, so a map with one spawn point
 *  stacks players on it — that is the author's call to fix by placing more,
 *  not something to second-guess by scattering trucks somewhere they did
 *  not choose.
 *
 *  Y always sits at the kind's suspension equilibrium (spawnYAboveGround)
 *  so there is no free-fall or settle bounce. */
export function resolveSpawn(map: MapWorld, slot: number, kind: CarKind): SpawnPose {
  const authored = map.spawns;
  const { x, z, yaw } = authored.length > 0
    ? authored[slot % authored.length]!
    : gridSpawn(map.terrain.size, slot);
  const idx = worldToTerrainIndex(map.terrain, x, z);
  const ground = idx >= 0 ? (map.terrain.heights[idx] ?? 0) : 0;
  return { position: { x, y: ground + spawnYAboveGround(kind), z }, yaw };
}
