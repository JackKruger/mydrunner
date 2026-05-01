// One-off placed structures (vs. the procedural rock/tree scatter).
// Currently a single petrol station along the road. No gameplay
// behaviour - they're just static obstacles you can drive around and
// crash into.

import RAPIER from '@dimforge/rapier3d-compat';
import { type TerrainData, worldToTerrainIndex } from './terrain.js';

export interface PetrolStation {
  /** World-space position of the station's centre (the "office" building). */
  x: number;
  y: number;
  z: number;
  /** Yaw rotation around the world Y axis. */
  yaw: number;
}

export interface Landmarks {
  petrolStation: PetrolStation;
}

export function landmarksFor(terrain: TerrainData): Landmarks {
  // Place a station along the road, on the +Z side, far enough from
  // spawn (-14..14 along X) that you have to drive to reach it. The
  // station's office is set 12m off the road centreline.
  const x = terrain.size * 0.20; // ~64m on a 320m world
  const z = 12;
  const idx = worldToTerrainIndex(terrain, x, z);
  const y = idx >= 0 ? (terrain.heights[idx] ?? 0) : 0;
  return { petrolStation: { x, y, z, yaw: 0 } };
}

// Local-space dimensions for the petrol station, in metres. Origin sits
// at the building's footprint centre at ground level. Positive +Z faces
// the road. Shared with the client renderer so meshes match colliders.
export const STATION = {
  building: { w: 6, h: 4, d: 4 }, // office on the back of the lot
  buildingZOffset: -2,            // building back-stuck (offset in -Z from origin)
  shelter: {
    w: 8,                         // roof width
    h: 0.4,                       // roof slab thickness
    d: 5,                         // roof depth
    columnRadius: 0.18,
    columnHeight: 4.4,            // column top
    zOffset: 4,                   // shelter centre is +Z of building
  },
  pump: {
    w: 0.6, h: 1.6, d: 0.4,       // body box
    spacing: 2.4,                 // distance between the two pumps along X
    zOffset: 4,                   // pumps sit under the shelter
  },
} as const;

export function spawnLandmarkColliders(
  world: RAPIER.World,
  l: Landmarks,
): RAPIER.RigidBody[] {
  const bodies: RAPIER.RigidBody[] = [];
  const ps = l.petrolStation;
  const cy = Math.cos(ps.yaw);
  const sy = Math.sin(ps.yaw);
  const place = (lx: number, ly: number, lz: number): { x: number; y: number; z: number } => ({
    x: ps.x + cy * lx + sy * lz,
    y: ps.y + ly,
    z: ps.z - sy * lx + cy * lz,
  });
  const fixed = (p: { x: number; y: number; z: number }): RAPIER.RigidBody => {
    const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z);
    const body = world.createRigidBody(desc);
    bodies.push(body);
    return body;
  };
  const cuboid = (
    body: RAPIER.RigidBody,
    halfW: number,
    halfH: number,
    halfD: number,
  ): void => {
    const c = RAPIER.ColliderDesc.cuboid(halfW, halfH, halfD).setFriction(0.7);
    if (ps.yaw !== 0) {
      const half = ps.yaw / 2;
      c.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    }
    world.createCollider(c, body);
  };

  // Office building.
  const b = STATION.building;
  fixed(place(0, b.h / 2, STATION.buildingZOffset));
  cuboid(bodies[bodies.length - 1]!, b.w / 2, b.h / 2, b.d / 2);

  // Shelter roof.
  const sh = STATION.shelter;
  fixed(place(0, sh.columnHeight + sh.h / 2, sh.zOffset));
  cuboid(bodies[bodies.length - 1]!, sh.w / 2, sh.h / 2, sh.d / 2);

  // Four shelter columns.
  const colHalfH = sh.columnHeight / 2;
  for (const cx of [-sh.w / 2 + 0.5, sh.w / 2 - 0.5]) {
    for (const cz of [sh.zOffset - sh.d / 2 + 0.4, sh.zOffset + sh.d / 2 - 0.4]) {
      fixed(place(cx, colHalfH, cz));
      const desc = RAPIER.ColliderDesc
        .cylinder(colHalfH, sh.columnRadius)
        .setFriction(0.7);
      world.createCollider(desc, bodies[bodies.length - 1]!);
    }
  }

  // Two pumps under the shelter.
  const p = STATION.pump;
  for (const px of [-p.spacing / 2, p.spacing / 2]) {
    fixed(place(px, p.h / 2, p.zOffset));
    cuboid(bodies[bodies.length - 1]!, p.w / 2, p.h / 2, p.d / 2);
  }

  return bodies;
}
