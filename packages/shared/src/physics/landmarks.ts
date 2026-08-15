// One-off placed structures (vs. the procedural rock/tree scatter).
// Currently a single petrol station along the road. No gameplay
// behaviour - they're just static obstacles you can drive around and
// crash into.
//
// The station sits on a flat concrete pad which is laid into the
// heightfield by `generateTerrain` (see petrolStationPadFor in
// terrain.ts). All structure dimensions live in STATION below so
// the client renderer and the Rapier colliders match by construction.

import RAPIER from '@dimforge/rapier3d-compat';
import { sampleHeightBilinear, type TerrainData } from './terrain.js';

export interface PetrolStation {
  /** World-space centre of the concrete pad. */
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
  // Read the pad the terrain was actually built with rather than
  // re-deriving it from size. Re-deriving ignored an authored pad
  // override, so a relocated station would have kept its old colliders
  // while the flattened concrete moved out from under it.
  const pad = terrain.petrolStation;
  // Resolve Y from the composed terrain rather than assuming the generated
  // pad is still at zero. Authored/baked height data is applied after terrain
  // generation and can move the pad, so a hard-coded zero leaves the whole
  // station (including its colliders) floating above the finished ground.
  return {
    petrolStation: {
      x: pad.cx,
      y: sampleHeightBilinear(terrain, pad.cx, pad.cz),
      z: pad.cz,
      yaw: pad.yaw,
    },
  };
}

// Local-space dimensions, in metres. Origin sits at the pad centre at
// ground level; +Z points TOWARD the road. Vehicles are 1.7m wide and
// 3.8m long, so the drive corridor + pump spacing + shelter clearance
// are sized so a Patrol or Hilux can pull into the shelter, fill up,
// and pull out the back without contact.
export const STATION = {
  // Office sits at the back of the lot (-Z, away from the road).
  building: { w: 8, h: 4.5, d: 5 },
  buildingZ: -7,
  // Shelter spans the middle of the lot, with the road-facing edge
  // at +Z. Roof clearance = columnHeight (4.8m) - chassis height
  // (~2.5m) ~= 2.3m, easy.
  shelter: {
    w: 14,
    h: 0.5,
    d: 8,
    columnRadius: 0.18,
    columnHeight: 4.8,
    z: 1, // shelter centre, slightly +Z of pad centre
  },
  pump: {
    w: 0.6,
    h: 1.7,
    d: 0.45,
    /** Two pumps spaced wide enough that a 1.7m-wide truck can drive
     *  between them with ~1.4m clearance each side. */
    spacing: 5.2,
    z: 1, // sits under the shelter
  },
  // Parking area: 3 parallel bays beside the office on the +X side.
  // Total area 9m wide × 5m deep, 3 bays of ~3m each.
  parking: {
    cx: 9,
    cz: -6.5,
    w: 9,
    d: 5,
  },
  // Open-sided workshop over the three marked bays. Every structural
  // element gets its own collider below; there is deliberately no solid
  // shed-sized box blocking the drive-through openings.
  workshop: {
    cx: 9,
    cz: -6.5,
    w: 9,
    d: 7,
    postRadius: 0.14,
    postHeight: 4.35,
    roofH: 0.35,
    backWallH: 2.2,
    backWallD: 0.18,
  },
  // Tall sign on a pole near the road edge of the lot.
  sign: { x: 11, z: 11 },
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
  const cuboid = (
    p: { x: number; y: number; z: number },
    halfW: number,
    halfH: number,
    halfD: number,
  ): void => {
    const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z);
    const body = world.createRigidBody(desc);
    const c = RAPIER.ColliderDesc.cuboid(halfW, halfH, halfD).setFriction(0.7);
    if (ps.yaw !== 0) {
      const half = ps.yaw / 2;
      c.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    }
    world.createCollider(c, body);
    bodies.push(body);
  };
  const cylinder = (
    p: { x: number; y: number; z: number },
    halfH: number,
    radius: number,
  ): void => {
    const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z);
    const body = world.createRigidBody(desc);
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(halfH, radius).setFriction(0.7),
      body,
    );
    bodies.push(body);
  };

  // Office building.
  const b = STATION.building;
  cuboid(place(0, b.h / 2, STATION.buildingZ), b.w / 2, b.h / 2, b.d / 2);

  // Shelter roof.
  const sh = STATION.shelter;
  cuboid(place(0, sh.columnHeight + sh.h / 2, sh.z), sh.w / 2, sh.h / 2, sh.d / 2);

  // Four shelter columns at each corner of the canopy.
  const colHalfH = sh.columnHeight / 2;
  for (const cx of [-sh.w / 2 + 0.6, sh.w / 2 - 0.6]) {
    for (const cz of [sh.z - sh.d / 2 + 0.4, sh.z + sh.d / 2 - 0.4]) {
      cylinder(place(cx, colHalfH, cz), colHalfH, sh.columnRadius);
    }
  }

  // Two pumps centred under the shelter.
  const p = STATION.pump;
  for (const px of [-p.spacing / 2, p.spacing / 2]) {
    cuboid(place(px, p.h / 2, p.z), p.w / 2, p.h / 2, p.d / 2);
  }

  // Sign pole.
  const sign = STATION.sign;
  const poleH = 6.5;
  cylinder(place(sign.x, poleH / 2, sign.z), poleH / 2, 0.12);

  const workshop = STATION.workshop;
  // Roof slab, rear wall and four rear posts. The front posts used to stand
  // directly in the three drive-in approaches, so the open edge is now
  // unobstructed in both the visible structure and collision geometry.
  cuboid(
    place(workshop.cx, workshop.postHeight + workshop.roofH / 2, workshop.cz),
    workshop.w / 2, workshop.roofH / 2, workshop.d / 2,
  );
  cuboid(
    place(workshop.cx, workshop.backWallH / 2, workshop.cz - workshop.d / 2),
    workshop.w / 2, workshop.backWallH / 2, workshop.backWallD / 2,
  );
  for (const x of [workshop.cx - workshop.w / 2, workshop.cx - workshop.w / 6, workshop.cx + workshop.w / 6, workshop.cx + workshop.w / 2]) {
    cylinder(
      place(x, workshop.postHeight / 2, workshop.cz - workshop.d / 2),
      workshop.postHeight / 2,
      workshop.postRadius,
    );
  }

  return bodies;
}
