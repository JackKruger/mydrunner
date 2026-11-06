// Suspension support queries for one wheel: the cylinder sweep down the
// suspension axis with its centre-ray baseline, and the analytic terrain
// fallback for a tyre lying on its side. Split from solidAxleVehicle.ts; they
// read the world and write the caller's WheelKinematic / SteepWheelContact,
// and apply no forces.

import type RAPIER from '@dimforge/rapier3d-compat';
import { LEDGE_CONTACT, SUSPENSION } from '../constants.js';
import { COLLISION_GROUP_WHEEL_RAY } from './collisionGroups.js';
import { sampleHeightBilinear } from './terrain.js';
import { classifyTireContactInto, type TireContactSemantics } from './tireCarcass.js';
import { rotateVecByQuatInto } from './util.js';
import type { WheelKinematic } from './wheelDynamics.js';
import type { SteepWheelContact } from './wheelContact.js';
import type { World } from './world.js';

type Vec3 = { x: number; y: number; z: number };

/** Sweep the tyre's real cylinder down its suspension axis.
 *
 * A centre ray followed by `toi - radius` is only exact on a plane whose
 * normal is parallel to the suspension. At a crest or an abrupt gradient
 * change, the front/rear tread reaches the higher triangle first while the
 * centre ray still sees the lower one; that lets part (or all) of the visible
 * tyre pass through the heightfield. Shape casting accounts for the complete
 * rolling circumference and tyre width, while preserving the existing
 * software spring/solid-axle model.
 */
export function castWheelSupport(
  world: World,
  ownBody: RAPIER.RigidBody,
  shape: RAPIER.Shape,
  rotation: { x: number; y: number; z: number; w: number },
  origin: Vec3,
  dir: Vec3,
  maxToi: number,
  restLength: number,
  wheelRadius: number,
  wheelHalfWidth: number,
  wheelAxle: Vec3,
  out: WheelKinematic,
): void {
  out.contactZone = 'air';
  out.treadFraction = 0;
  out.suspensionAxisAlignment = 0;
  // Keep the centre ray as the stable baseline on ordinary ground. Rapier's
  // cylinder normals contain small triangle-seam noise even on a perfectly
  // flat heightfield; applying those normals directly produces visible creep.
  castWheelRayFallback(
    world,
    ownBody,
    origin,
    dir,
    maxToi + wheelRadius,
    restLength,
    wheelRadius,
    out,
  );
  if (out.contact) {
    const semantics = classifyTireContactInto(
      out.contactNormal.x * wheelAxle.x
      + out.contactNormal.y * wheelAxle.y
      + out.contactNormal.z * wheelAxle.z,
      _castSemantics,
    );
    const approach = Math.max(0, -(
      out.contactNormal.x * dir.x
      + out.contactNormal.y * dir.y
      + out.contactNormal.z * dir.z
    ));
    if (semantics.treadFraction <= 0 || approach < 0.25) {
      out.contact = false;
      out.contactDepth = 0;
    } else {
      out.contactZone = semantics.zone;
      out.treadFraction = semantics.treadFraction;
      out.suspensionAxisAlignment = approach;
    }
  }

  const hit = world.world.castShape(
    origin,
    rotation,
    dir,
    shape,
    0,
    maxToi,
    true,
    undefined,
    COLLISION_GROUP_WHEEL_RAY,
    undefined,
    ownBody,
  );
  if (hit) {
    const center = _castCenter;
    center.x = origin.x + dir.x * hit.time_of_impact;
    center.y = origin.y + dir.y * hit.time_of_impact;
    center.z = origin.z + dir.z * hit.time_of_impact;
    const normal = hit.normal1;
    if (
      hit.collider.handle === world.terrainCollider.handle
      && normal.y >= SUSPENSION.terrainSupportMinNormalY
      && (
        !out.contact
        || restLength - hit.time_of_impact
          > out.contactDepth + SUSPENSION.volumeSupportMinAdvance
      )
      && (
        normal.x * dir.x
        + normal.y * dir.y
        + normal.z * dir.z
      ) < -0.05
    ) {
      // Rapier 0.14 exposes shape-cast witnesses in shape-local frames. Build
      // the world-space cylinder support point explicitly instead: radial
      // tread support plus the appropriate sidewall-cap offset.
      const axle = _castAxle;
      _castUp.x = 0; _castUp.y = 1; _castUp.z = 0;
      rotateVecByQuatInto(_castUp, rotation, axle);
      const axialDot = normal.x * axle.x + normal.y * axle.y + normal.z * axle.z;
      const radial = _castRadial;
      radial.x = normal.x - axle.x * axialDot;
      radial.y = normal.y - axle.y * axialDot;
      radial.z = normal.z - axle.z * axialDot;
      const radialLength = Math.hypot(radial.x, radial.y, radial.z);
      const radialScale = radialLength > 1e-8 ? wheelRadius / radialLength : 0;
      const capScale = Math.sign(axialDot) * wheelHalfWidth;
      out.contact = true;
      out.contactDepth = restLength - hit.time_of_impact;
      out.contactPoint.x = center.x - radial.x * radialScale - axle.x * capScale;
      out.contactPoint.y = center.y - radial.y * radialScale - axle.y * capScale;
      out.contactPoint.z = center.z - radial.z * radialScale - axle.z * capScale;
      out.contactNormal.x = normal.x;
      out.contactNormal.y = normal.y;
      out.contactNormal.z = normal.z;
      out.supportIsTerrain = true;
      out.supportColliderFriction = hit.collider.friction();
      out.volumeSupport = true;
      const semantics = classifyTireContactInto(axialDot, _castSemantics);
      const approach = Math.max(0, -(normal.x * dir.x + normal.y * dir.y + normal.z * dir.z));
      if (semantics.treadFraction <= 0 || approach < 0.25) {
        out.contact = false;
        out.contactDepth = 0;
        out.volumeSupport = false;
      } else {
        out.contactZone = semantics.zone;
        out.treadFraction = semantics.treadFraction;
        out.suspensionAxisAlignment = approach;
      }
      return;
    }
  }
}

function castWheelRayFallback(
  world: World,
  ownBody: RAPIER.RigidBody,
  origin: Vec3,
  dir: Vec3,
  maxToi: number,
  restLength: number,
  wheelRadius: number,
  out: WheelKinematic,
): void {
  out.volumeSupport = false;
  // The world's single Ray, re-pointed rather than reallocated per wheel.
  const ray = world.wheelRay;
  ray.origin = origin;
  ray.dir = dir;
  let hit = world.world.castRayAndGetNormal(
    ray,
    maxToi,
    true,
    undefined,
    COLLISION_GROUP_WHEEL_RAY,
    undefined,
    ownBody,
  );
  // A pitched chassis-down ray can strike a vertical face before the ground
  // underneath the tyre. That face belongs to the volumetric contact path;
  // ignore its collider once and continue the support query behind it.
  if (hit && hit.normal.y < LEDGE_CONTACT.maxSupportNormalY) {
    const blockedCollider = hit.collider;
    const fallback = world.world.castRayAndGetNormal(
      ray,
      maxToi,
      true,
      undefined,
      COLLISION_GROUP_WHEEL_RAY,
      blockedCollider,
      ownBody,
    );
    hit = fallback && fallback.normal.y >= LEDGE_CONTACT.maxSupportNormalY
      ? fallback
      : null;
  }
  if (hit) {
    const toi = hit.timeOfImpact;
    out.contact = true;
    // Depth can be negative when the ground is below restLength (droop).
    out.contactDepth = restLength - (toi - wheelRadius);
    out.contactPoint.x = origin.x + dir.x * toi;
    out.contactPoint.y = origin.y + dir.y * toi;
    out.contactPoint.z = origin.z + dir.z * toi;
    out.contactNormal.x = hit.normal.x;
    out.contactNormal.y = hit.normal.y;
    out.contactNormal.z = hit.normal.z;
    out.supportIsTerrain = hit.collider.handle === world.terrainCollider.handle;
    out.supportColliderFriction = hit.collider.friction();
  } else {
    out.contact = false;
    out.contactDepth = 0;
    out.contactPoint.x = origin.x + dir.x * maxToi;
    out.contactPoint.y = origin.y + dir.y * maxToi;
    out.contactPoint.z = origin.z + dir.z * maxToi;
    out.contactNormal.x = 0;
    out.contactNormal.y = 1;
    out.contactNormal.z = 0;
    out.supportIsTerrain = true;
    out.supportColliderFriction = 1;
  }
}

// Scratch for the two cast helpers above and the sidewall fallback below.
// Module-level rather than per-vehicle: their lifetime is a single call, and
// owner physics steps one vehicle at a time.
const _castCenter: Vec3 = { x: 0, y: 0, z: 0 };
const _castAxle: Vec3 = { x: 0, y: 0, z: 0 };
const _castUp: Vec3 = { x: 0, y: 0, z: 0 };
const _castRadial: Vec3 = { x: 0, y: 0, z: 0 };
const _castSemantics: TireContactSemantics = {
  zone: 'tread', treadFraction: 0, axleAlignment: 0,
};
const _sidewallSemantics: TireContactSemantics = {
  zone: 'tread', treadFraction: 0, axleAlignment: 0,
};

/** Analytic terrain fallback for a tyre lying on its side. Heightfield shape
 * contact queries are one-sided and may return no manifold once the cylinder
 * centre crosses below the surface; the support extent remains well-defined. */
/** @hotloop */
export function findTerrainSidewallContactInto(
  world: World,
  center: Vec3,
  axle: Vec3,
  radius: number,
  halfWidth: number,
  prediction: number,
  out: SteepWheelContact,
): SteepWheelContact | null {
  const h = 0.08;
  const height = sampleHeightBilinear(world.terrain, center.x, center.z);
  const dx = (sampleHeightBilinear(world.terrain, center.x + h, center.z)
    - sampleHeightBilinear(world.terrain, center.x - h, center.z)) / (2 * h);
  const dz = (sampleHeightBilinear(world.terrain, center.x, center.z + h)
    - sampleHeightBilinear(world.terrain, center.x, center.z - h)) / (2 * h);
  const inv = 1 / (Math.hypot(dx, 1, dz) || 1);
  const normalX = -dx * inv; const normalY = inv; const normalZ = -dz * inv;
  const axial = normalX * axle.x + normalY * axle.y + normalZ * axle.z;
  const semantics = classifyTireContactInto(axial, _sidewallSemantics);
  if (semantics.zone !== 'sidewall') return null;
  const extent = halfWidth * Math.abs(axial)
    + radius * Math.sqrt(Math.max(0, 1 - axial * axial));
  const distance = (center.y - height) * normalY - extent;
  if (distance > prediction) return null;
  out.point.x = center.x - normalX * extent;
  out.point.y = center.y - normalY * extent;
  out.point.z = center.z - normalZ * extent;
  out.normal.x = normalX;
  out.normal.y = normalY;
  out.normal.z = normalZ;
  out.climbDirection = null;
  out.climbTopY = null;
  out.distance = distance;
  out.penetration = Math.max(0, -distance);
  out.friction = world.terrainCollider.friction();
  out.timeOfImpact = 0;
  return out;
}
