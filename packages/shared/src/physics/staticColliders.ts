// Rapier collider construction for the static world: placed obstacles and
// landmark structures. Split from obstacles.ts / landmarks.ts so that their
// placement data - which the relay composes for spawns and winch anchors -
// carries no Rapier import. Only owner physics (world.ts) builds colliders.

import RAPIER from '@dimforge/rapier3d-compat';
import { resolveColliders, type Obstacle } from './objectCatalog.js';
import { STATION, type Landmarks } from './landmarks.js';

/** Spawn the obstacles into a Rapier world as static colliders. Returns
 *  the bodies so they can be cleaned up later.
 *
 *  One fixed body per obstacle, however many collider parts its kind
 *  resolves to — a sign is a post and a panel, and both have to move
 *  together. The one-body-per-obstacle shape is what World's teardown loop
 *  expects, so multi-part kinds did not change it.
 *
 *  The body is left at the origin and each collider carries the full world
 *  transform, rather than the body sitting at the obstacle anchor with
 *  local offsets hung off it. That looks backwards and is deliberate:
 *  Rapier stores both as f32, so anchor-plus-offset rounds twice and moved
 *  a dozen rocks by 0.1 mm against the pre-table behaviour. Sub-millimetre
 *  is physically nothing, but "nothing moved" is the whole claim this
 *  refactor rests on, and it is free to keep it exactly true. Nothing reads
 *  an obstacle body's translation; contact resolution sees the colliders. */
export function spawnObstacleColliders(
  world: RAPIER.World,
  obstacles: Obstacle[],
): RAPIER.RigidBody[] {
  const bodies: RAPIER.RigidBody[] = [];
  for (const o of obstacles) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const c of resolveColliders(o)) {
      let desc: RAPIER.ColliderDesc;
      switch (c.shape) {
        case 'ball':
          desc = RAPIER.ColliderDesc.ball(c.args[0]!);
          break;
        case 'capsule':
          desc = RAPIER.ColliderDesc.capsule(c.args[0]!, c.args[1]!);
          break;
        case 'cuboid':
          desc = RAPIER.ColliderDesc.cuboid(c.args[0]!, c.args[1]!, c.args[2]!);
          break;
        case 'cylinder':
          desc = RAPIER.ColliderDesc.cylinder(c.args[0]!, c.args[1]!);
          break;
      }
      desc.setFriction(c.friction)
        .setTranslation(c.pos.x, c.pos.y, c.pos.z)
        .setRotation(c.rot);
      world.createCollider(desc, body);
    }
    bodies.push(body);
  }
  return bodies;
}

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
