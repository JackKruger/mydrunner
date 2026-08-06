// Golden fingerprint of the obstacle *colliders*.
//
// world-golden.test.ts pins what generateObstacles() produces — the list of
// kinds, ids and poses. It says nothing about what those obstacles become in
// Rapier, and that is the half the vehicle actually drives into. A refactor
// of spawnObstacleColliders can leave every golden hash green while moving
// every rock's collision surface 60 cm.
//
// Both halves have to hold for the "client and server build the same world
// from the same document" guarantee. Obstacle colliders are built
// independently on the server and in the client's prediction sim, so a
// change here that is not matched by a PROTOCOL_VERSION bump desyncs the two
// with no error — the local truck climbs a rock the server says is not there.
//
// A FAILURE HERE IS NOT AUTOMATICALLY A BUG, with the same caveat
// world-golden.test.ts carries: decide whether the collider change was
// intentional. If it was, bump PROTOCOL_VERSION in constants.ts, then update
// the numbers below.

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier } from '../physics/world.js';
import { generateTerrain } from '../physics/terrain.js';
import {
  generateObstacles, spawnObstacleColliders, type Obstacle,
} from '../physics/obstacles.js';
import { fnv1a32 } from '../hash.js';

const GOLDEN = {
  bodyCount: 986,
  colliderCount: 986,
  fingerprint: 1772205958,
} as const;

/** Every collider's shape, dimensions, friction and world transform,
 *  rounded to 4 decimals — the point is to catch a collider that moved or
 *  changed shape, not a last-ulp difference in how trig rounds on a
 *  different V8 (same rationale as world-golden's poseFingerprint). */
function describeColliders(world: RAPIER.World): string[] {
  const out: string[] = [];
  world.forEachCollider((c) => {
    const t = c.translation();
    const r = c.rotation();
    const s = c.shape as unknown as {
      type: number;
      radius?: number;
      halfHeight?: number;
      halfExtents?: { x: number; y: number; z: number };
    };
    const dims = [
      s.radius, s.halfHeight,
      s.halfExtents?.x, s.halfExtents?.y, s.halfExtents?.z,
    ].map((v) => (v === undefined ? '-' : v.toFixed(4)));
    out.push([
      `type=${s.type}`,
      `dims=${dims.join(',')}`,
      `fric=${c.friction().toFixed(4)}`,
      `t=${t.x.toFixed(4)},${t.y.toFixed(4)},${t.z.toFixed(4)}`,
      `r=${r.x.toFixed(4)},${r.y.toFixed(4)},${r.z.toFixed(4)},${r.w.toFixed(4)}`,
    ].join(' '));
  });
  return out;
}

/** A bare Rapier world holding nothing but the obstacle colliders — no
 *  heightfield, no vehicle. Keeps the fingerprint to the thing under test. */
function spawnInto(obstacles: Obstacle[]): {
  world: RAPIER.World; bodies: RAPIER.RigidBody[];
} {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const bodies = spawnObstacleColliders(world, obstacles);
  return { world, bodies };
}

describe('obstacle collider golden fingerprint', () => {
  let obstacles: Obstacle[];
  let world: RAPIER.World;
  let bodies: RAPIER.RigidBody[];

  beforeAll(async () => {
    await initRapier();
    obstacles = generateObstacles(generateTerrain());
    ({ world, bodies } = spawnInto(obstacles));
  });

  it('gives every obstacle a body', () => {
    expect(bodies.length).toBe(GOLDEN.bodyCount);
    expect(bodies.length).toBe(obstacles.length);
  });

  it('builds an unchanged set of colliders', () => {
    const lines = describeColliders(world);
    expect(lines.length).toBe(GOLDEN.colliderCount);
    expect(fnv1a32(lines.join('|'))).toBe(GOLDEN.fingerprint);
  });

  it('builds the same colliders twice from the same terrain', () => {
    const again = spawnInto(generateObstacles(generateTerrain()));
    expect(describeColliders(again.world)).toEqual(describeColliders(world));
  });

  // The per-kind rules spelled out, so a failure above says *which* kind
  // moved rather than only that the hash changed. These are the shapes the
  // shipped world has always had; they are frozen unless PROTOCOL_VERSION
  // moves with them.
  it('seats a rock as a ball of its size, sunk 40% into the ground', () => {
    const rock = obstacles.find((o) => o.id === 'rock-med-0')!;
    const { world: w } = spawnInto([rock]);
    const c = w.getCollider(0)!;
    const s = c.shape as unknown as { radius: number };
    expect(s.radius).toBeCloseTo(rock.size, 6);
    expect(c.translation().y).toBeCloseTo(rock.y + rock.size * 0.6, 6);
    expect(c.friction()).toBeCloseTo(0.9, 6);
  });

  it('seats a tree as a capsule standing on the ground', () => {
    const tree = obstacles.find((o) => o.kind === 'tree')!;
    const { world: w } = spawnInto([tree]);
    const c = w.getCollider(0)!;
    const s = c.shape as unknown as { radius: number; halfHeight: number };
    const halfHeight = Math.max(0.1, (tree.height - 2 * tree.size) / 2);
    expect(s.radius).toBeCloseTo(tree.size, 6);
    expect(s.halfHeight).toBeCloseTo(halfHeight, 6);
    expect(c.translation().y).toBeCloseTo(tree.y + halfHeight + tree.size, 6);
    expect(c.friction()).toBeCloseTo(0.6, 6);
  });

  // Flagpoles have never had a collider branch of their own: they fall
  // through to the tree capsule, which for a 0.07 m "trunk radius" is a
  // thin pole and reads correctly. Pinned because the obvious "fix" —
  // giving it a real cylinder — changes the shipped world's physics.
  it('seats a flagpole on the same capsule rule as a tree', () => {
    const pole = obstacles.find((o) => o.id === 'flag-summit')!;
    const { world: w } = spawnInto([pole]);
    const c = w.getCollider(0)!;
    const s = c.shape as unknown as { radius: number; halfHeight: number };
    expect(s.radius).toBeCloseTo(pole.size, 6);
    expect(s.halfHeight).toBeCloseTo(Math.max(0.1, (pole.height - 2 * pole.size) / 2), 6);
    expect(c.friction()).toBeCloseTo(0.6, 6);
  });

  it('seats a ramp as a tilted cuboid matching rampTransform', () => {
    const ramp = obstacles.find((o) => o.kind === 'ramp')!;
    const { world: w } = spawnInto([ramp]);
    const c = w.getCollider(0)!;
    const s = c.shape as unknown as { halfExtents: { x: number; y: number; z: number } };
    expect(s.halfExtents.x).toBeCloseTo((ramp.length ?? 3) / 2, 6);
    expect(s.halfExtents.z).toBeCloseTo(ramp.size, 6);
    expect(c.friction()).toBeCloseTo(1.0, 6);
    // Tilted: a ramp whose collider came out flat would still pass every
    // dimension check above.
    expect(Math.abs(c.rotation().x)).toBeGreaterThan(1e-3);
  });
});
