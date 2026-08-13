// Hybrid tyre-volume contacts for faces a suspension ray cannot see.
//
// Ordinary ground support remains ray-based. Each wheel also queries a
// cylinder matching the visible tyre against nearby world colliders and
// accepts only steep contacts. This gives kerbs, rock steps and logs a real
// leading face without introducing four jointed rigid bodies and replacing
// the existing solid-axle suspension model.

import type RAPIER from '@dimforge/rapier3d-compat';
import { sampleHeightBilinear, type TerrainData } from './terrain.js';

export interface ContactVec3 {
  x: number;
  y: number;
  z: number;
}

export interface ContactQuat extends ContactVec3 {
  w: number;
}

export interface WheelBasis {
  forward: ContactVec3;
  axle: ContactVec3;
  up: ContactVec3;
}

export interface WheelContactFrame {
  longitudinal: ContactVec3;
  lateral: ContactVec3;
}

export interface SteepWheelContact {
  point: ContactVec3;
  normal: ContactVec3;
  /** Direction the driven tread should follow around a reachable top edge.
   *  Null for an unbounded wall or a face being approached from the side. */
  climbDirection: ContactVec3 | null;
  /** Height of that reachable upper surface, when climbDirection is set. */
  climbTopY: number | null;
  distance: number;
  penetration: number;
  friction: number;
  timeOfImpact: number;
  /** Backing storage `climbDirection` is pointed at when a climb target is
   *  found, so the nullable field can be re-pointed rather than reallocated.
   *  Read `climbDirection`, never this: it holds stale values when null. */
  readonly climbStore: ContactVec3;
}

const ZERO: ContactVec3 = { x: 0, y: 0, z: 0 };

export function wheelBasis(
  chassisForward: ContactVec3,
  chassisRight: ContactVec3,
  chassisUp: ContactVec3,
  axleRoll: number,
  steerAngle: number,
): WheelBasis {
  return wheelBasisInto(chassisForward, chassisRight, chassisUp, axleRoll, steerAngle, {
    forward: { x: 0, y: 0, z: 0 },
    axle: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 0 },
  });
}

/** `wheelBasis` writing into a caller-owned basis. @hotloop */
export function wheelBasisInto(
  chassisForward: ContactVec3,
  chassisRight: ContactVec3,
  chassisUp: ContactVec3,
  axleRoll: number,
  steerAngle: number,
  out: WheelBasis,
): WheelBasis {
  const cr = Math.cos(axleRoll);
  const sr = Math.sin(axleRoll);
  const axleUp = out.up;
  axleUp.x = chassisUp.x * cr - chassisRight.x * sr;
  axleUp.y = chassisUp.y * cr - chassisRight.y * sr;
  axleUp.z = chassisUp.z * cr - chassisRight.z * sr;
  normalizeInto(axleUp, axleUp);
  const forward = out.forward;
  if (Math.abs(steerAngle) > 1e-8) {
    rotateAroundAxisInto(chassisForward, axleUp, steerAngle, forward);
    normalizeInto(forward, forward);
  } else {
    normalizeInto(chassisForward, forward);
  }
  // Rebuild the axle from the steered forward vector. This keeps the tyre
  // cylinder and force frame orthogonal even at full articulation + steer.
  crossInto(axleUp, forward, out.axle);
  normalizeInto(out.axle, out.axle);
  return out;
}

/** Build the rolling/lateral directions in the collider's tangent plane.
 *  Returns null for a pure sidewall hit where the normal is parallel to the
 *  wheel axle: the sidewall resists penetration but wheel torque cannot roll
 *  the tyre up that surface. */
export function contactFrame(
  normal: ContactVec3,
  wheelAxle: ContactVec3,
  wheelForward: ContactVec3,
): WheelContactFrame | null {
  return contactFrameInto(normal, wheelAxle, wheelForward, {
    longitudinal: { x: 0, y: 0, z: 0 },
    lateral: { x: 0, y: 0, z: 0 },
  });
}

/** `contactFrame` writing into a caller-owned frame. Returns `out` on success
 *  and null for the pure-sidewall case, so callers keep the existing
 *  null-check shape rather than a separate boolean. @hotloop */
export function contactFrameInto(
  normal: ContactVec3,
  wheelAxle: ContactVec3,
  wheelForward: ContactVec3,
  out: WheelContactFrame,
): WheelContactFrame | null {
  const longitudinal = out.longitudinal;
  crossInto(wheelAxle, normal, longitudinal);
  const len = length(longitudinal);
  if (len < 1e-6) return null;
  scaleInto(longitudinal, 1 / len, longitudinal);
  // On ground/slopes the cross-product must agree with wheel-forward. At a
  // vertical wall their dot is zero, and the raw cross-product's sign is the
  // one that makes positive wheel rotation climb a forward-facing ledge.
  if (dot(longitudinal, wheelForward) < -1e-6) {
    scaleInto(longitudinal, -1, longitudinal);
  }
  const lateral = out.lateral;
  crossInto(normal, longitudinal, lateral);
  normalizeInto(lateral, lateral);
  if (dot(lateral, wheelAxle) < 0) scaleInto(lateral, -1, lateral);
  return out;
}

/** Quaternion rotating Rapier Cylinder's local +Y axis onto the wheel axle. */
export function cylinderRotation(wheelAxle: ContactVec3): ContactQuat {
  return cylinderRotationInto(wheelAxle, { x: 0, y: 0, z: 0, w: 1 });
}

/** `cylinderRotation` writing into a caller-owned quaternion. @hotloop */
export function cylinderRotationInto(wheelAxle: ContactVec3, out: ContactQuat): ContactQuat {
  const axisX = wheelAxle.x; const axisY = wheelAxle.y; const axisZ = wheelAxle.z;
  const len = Math.hypot(axisX, axisY, axisZ);
  const inv = len < 1e-10 ? 0 : 1 / len;
  const nx = axisX * inv; const ny = axisY * inv; const nz = axisZ * inv;
  const d = clamp(ny, -1, 1);
  if (d < -0.999999) {
    out.x = 1; out.y = 0; out.z = 0; out.w = 0;
    return out;
  }
  const s = Math.sqrt(2 * (1 + d));
  if (s < 1e-8) {
    out.x = 0; out.y = 0; out.z = 0; out.w = 1;
    return out;
  }
  out.x = nz / s;
  out.y = 0;
  out.z = -nx / s;
  out.w = s * 0.5;
  return out;
}

/** Find the most constraining steep contact for one tyre. Broadphase uses a
 *  conservative swept sphere around the cylinder; narrowphase uses Rapier's
 *  exact cylinder-vs-collider contact/cast queries. */
export function findSteepWheelContact(
  world: RAPIER.World,
  shape: RAPIER.Shape,
  previousCenter: ContactVec3 | null,
  currentCenter: ContactVec3,
  rotation: ContactQuat,
  wheelRadius: number,
  wheelHalfWidth: number,
  prediction: number,
  maxSupportNormalY: number,
  maxClimbHeight: number,
  edgeAdvance: number,
  wheelForward: ContactVec3,
  queryGroups: number,
  wheelAxle?: ContactVec3,
): SteepWheelContact | null {
  return findSteepWheelContactInto(
    world, shape, previousCenter, currentCenter, rotation, wheelRadius, wheelHalfWidth,
    prediction, maxSupportNormalY, maxClimbHeight, edgeAdvance, wheelForward, queryGroups,
    createSteepWheelContact(), wheelAxle,
  );
}

/** A reusable `findSteepWheelContactInto` result. Owns storage for the climb
 *  direction so the nullable field can be re-pointed rather than reallocated. */
export function createSteepWheelContact(): SteepWheelContact {
  return {
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 0 },
    climbDirection: null,
    climbTopY: null,
    distance: 0,
    penetration: 0,
    friction: 0,
    timeOfImpact: 0,
    climbStore: { x: 0, y: 0, z: 0 },
  };
}

/** Build a validated ledge contact from a steep heightfield support hit.
 *  The allocating form is for tests and cold callers; owner physics uses the
 *  `Into` form below. */
export function findHeightfieldLedgeContact(
  terrain: TerrainData,
  wheelCenter: ContactVec3,
  facePoint: ContactVec3,
  faceNormal: ContactVec3,
  wheelForward: ContactVec3,
  wheelAxle: ContactVec3,
  wheelRadius: number,
  wheelHalfWidth: number,
  prediction: number,
  maxSupportNormalY: number,
  maxClimbHeight: number,
  edgeAdvance: number,
  friction: number,
): SteepWheelContact | null {
  return findHeightfieldLedgeContactInto(
    terrain, wheelCenter, facePoint, faceNormal, wheelForward, wheelAxle,
    wheelRadius, wheelHalfWidth, prediction, maxSupportNormalY,
    maxClimbHeight, edgeAdvance, friction, createSteepWheelContact(),
  );
}

/** Convert the steep normal and witness already produced by the suspension's
 *  heightfield cylinder cast into a ledge contact. Rapier 0.14 can return that
 *  cast while returning null from a follow-up `contactShape`, so terrain uses
 *  this analytic reconstruction instead of repeating the failed query.
 *
 *  A top is valid only if an upward-supporting patch exists beyond the face
 *  within both the tyre radius and one heightfield-cell diagonal. This clears
 *  the triangle that formed a coarse ledge without reaching across a long
 *  steep slope or turning an unbounded rise into a climb target. @hotloop */
export function findHeightfieldLedgeContactInto(
  terrain: TerrainData,
  wheelCenter: ContactVec3,
  facePoint: ContactVec3,
  faceNormal: ContactVec3,
  wheelForward: ContactVec3,
  wheelAxle: ContactVec3,
  wheelRadius: number,
  wheelHalfWidth: number,
  prediction: number,
  maxSupportNormalY: number,
  maxClimbHeight: number,
  edgeAdvance: number,
  friction: number,
  out: SteepWheelContact,
): SteepWheelContact | null {
  const normalLength = Math.hypot(faceNormal.x, faceNormal.y, faceNormal.z);
  if (normalLength < 1e-8) return null;
  const invNormalLength = 1 / normalLength;
  const normalX = faceNormal.x * invNormalLength;
  const normalY = faceNormal.y * invNormalLength;
  const normalZ = faceNormal.z * invNormalLength;
  if (normalY >= maxSupportNormalY) return null;

  intoHorizontal.x = -normalX;
  intoHorizontal.y = 0;
  intoHorizontal.z = -normalZ;
  normalizeInto(intoHorizontal, intoHorizontal);
  forwardHorizontal.x = wheelForward.x;
  forwardHorizontal.y = 0;
  forwardHorizontal.z = wheelForward.z;
  normalizeInto(forwardHorizontal, forwardHorizontal);
  if (lengthSq(intoHorizontal) < 0.5 || dot(intoHorizontal, forwardHorizontal) < 0.25) {
    return null;
  }

  const cellSize = terrain.size / Math.max(1, terrain.resolution - 1);
  const probeInset = Math.max(
    0.04,
    prediction * 2,
    Math.min(wheelRadius, cellSize * Math.SQRT2),
  );
  const probeX = facePoint.x + intoHorizontal.x * probeInset;
  const probeZ = facePoint.z + intoHorizontal.z * probeInset;
  const normalSample = cellSize * 0.25;
  const halfSize = terrain.size * 0.5;
  if (
    probeX - normalSample < -halfSize || probeX + normalSample > halfSize
    || probeZ - normalSample < -halfSize || probeZ + normalSample > halfSize
  ) return null;

  const topY = sampleHeightBilinear(terrain, probeX, probeZ);
  const hubRise = topY + wheelRadius - wheelCenter.y;
  if (hubRise <= prediction || hubRise > maxClimbHeight + prediction) return null;

  const topDx = (
    sampleHeightBilinear(terrain, probeX + normalSample, probeZ)
    - sampleHeightBilinear(terrain, probeX - normalSample, probeZ)
  ) / (2 * normalSample);
  const topDz = (
    sampleHeightBilinear(terrain, probeX, probeZ + normalSample)
    - sampleHeightBilinear(terrain, probeX, probeZ - normalSample)
  ) / (2 * normalSample);
  const topNormalY = 1 / Math.hypot(topDx, 1, topDz);
  if (topNormalY < maxSupportNormalY) return null;

  // Locate the first upper-surface point rather than applying an upper-edge
  // tread direction at the lower face witness. The heightfield is continuous
  // across the cell, so a fixed bisection stays deterministic and allocation
  // free while placing the force at the physical slope-to-top boundary.
  let edgeLo = 0;
  let edgeHi = probeInset;
  for (let iteration = 0; iteration < 8; iteration++) {
    const middle = (edgeLo + edgeHi) * 0.5;
    const middleHeight = sampleHeightBilinear(
      terrain,
      facePoint.x + intoHorizontal.x * middle,
      facePoint.z + intoHorizontal.z * middle,
    );
    if (middleHeight >= topY - 1e-4) edgeHi = middle;
    else edgeLo = middle;
  }
  const edgeX = facePoint.x + intoHorizontal.x * edgeHi;
  const edgeZ = facePoint.z + intoHorizontal.z * edgeHi;

  const axleLength = Math.hypot(wheelAxle.x, wheelAxle.y, wheelAxle.z);
  const axial = axleLength > 1e-8
    ? clamp(
      (normalX * wheelAxle.x + normalY * wheelAxle.y + normalZ * wheelAxle.z)
        / axleLength,
      -1,
      1,
    )
    : 0;
  const extent = wheelHalfWidth * Math.abs(axial)
    + wheelRadius * Math.sqrt(Math.max(0, 1 - axial * axial));
  const distance =
    (wheelCenter.x - facePoint.x) * normalX
    + (wheelCenter.y - facePoint.y) * normalY
    + (wheelCenter.z - facePoint.z) * normalZ
    - extent;

  out.point.x = edgeX;
  out.point.y = topY;
  out.point.z = edgeZ;
  out.normal.x = normalX;
  out.normal.y = normalY;
  out.normal.z = normalZ;
  out.climbStore.x = edgeX + intoHorizontal.x * edgeAdvance - wheelCenter.x;
  out.climbStore.y = topY + wheelRadius - wheelCenter.y;
  out.climbStore.z = edgeZ + intoHorizontal.z * edgeAdvance - wheelCenter.z;
  normalizeInto(out.climbStore, out.climbStore);
  out.climbDirection = out.climbStore;
  out.climbTopY = topY;
  out.distance = distance;
  out.penetration = Math.max(0, -distance);
  out.friction = friction;
  out.timeOfImpact = 0;
  return out;
}

// Broadphase state for the query in flight. Hoisted to module scope with the
// callback below so the per-wheel query allocates neither a closure nor its
// captured environment; owner physics is single-threaded and this query never
// re-enters, so one slot is enough.
const query = {
  world: null as unknown as RAPIER.World,
  shape: null as unknown as RAPIER.Shape,
  rotation: null as unknown as ContactQuat,
  currentCenter: null as unknown as ContactVec3,
  wheelForward: null as unknown as ContactVec3,
  wheelAxle: undefined as ContactVec3 | undefined,
  out: null as unknown as SteepWheelContact,
  climbOut: null as unknown as ContactVec3,
  climbScratch: { x: 0, y: 0, z: 0 },
  start: { x: 0, y: 0, z: 0 },
  delta: { x: 0, y: 0, z: 0 },
  impactCenter: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
  axleUnit: { x: 0, y: 0, z: 0 },
  wheelRadius: 0,
  prediction: 0,
  maxSupportNormalY: 0,
  maxClimbHeight: 0,
  edgeAdvance: 0,
  queryGroups: 0,
  bestSeverity: -Infinity,
  found: false,
};

const aabbCenter: ContactVec3 = { x: 0, y: 0, z: 0 };
const aabbHalf: ContactVec3 = { x: 0, y: 0, z: 0 };

/** `findSteepWheelContact` writing into a caller-owned result, so each wheel can
 *  keep its own contact across the tick without allocating one per query.
 *  Returns `out` on a hit and null otherwise. @hotloop */
export function findSteepWheelContactInto(
  world: RAPIER.World,
  shape: RAPIER.Shape,
  previousCenter: ContactVec3 | null,
  currentCenter: ContactVec3,
  rotation: ContactQuat,
  wheelRadius: number,
  wheelHalfWidth: number,
  prediction: number,
  maxSupportNormalY: number,
  maxClimbHeight: number,
  edgeAdvance: number,
  wheelForward: ContactVec3,
  queryGroups: number,
  out: SteepWheelContact,
  wheelAxle?: ContactVec3,
): SteepWheelContact | null {
  const start = query.start;
  const source = previousCenter ?? currentCenter;
  start.x = source.x; start.y = source.y; start.z = source.z;
  const delta = query.delta;
  delta.x = currentCenter.x - start.x;
  delta.y = currentCenter.y - start.y;
  delta.z = currentCenter.z - start.z;
  const bound = Math.hypot(wheelRadius, wheelHalfWidth) + prediction;
  aabbCenter.x = (start.x + currentCenter.x) * 0.5;
  aabbCenter.y = (start.y + currentCenter.y) * 0.5;
  aabbCenter.z = (start.z + currentCenter.z) * 0.5;
  aabbHalf.x = Math.abs(delta.x) * 0.5 + bound;
  aabbHalf.y = Math.abs(delta.y) * 0.5 + bound;
  aabbHalf.z = Math.abs(delta.z) * 0.5 + bound;

  query.world = world;
  query.shape = shape;
  query.rotation = rotation;
  query.currentCenter = currentCenter;
  query.wheelForward = wheelForward;
  query.wheelAxle = wheelAxle;
  query.out = out;
  query.climbOut = out.climbStore;
  query.wheelRadius = wheelRadius;
  query.prediction = prediction;
  query.maxSupportNormalY = maxSupportNormalY;
  query.maxClimbHeight = maxClimbHeight;
  query.edgeAdvance = edgeAdvance;
  query.queryGroups = queryGroups;
  query.bestSeverity = -Infinity;
  query.found = false;

  world.collidersWithAabbIntersectingAabb(aabbCenter, aabbHalf, considerCollider);
  return query.found ? out : null;
}

function considerCollider(collider: RAPIER.Collider): boolean {
  if (!interactionGroupsMatch(query.queryGroups, collider.collisionGroups())) return true;

  const delta = query.delta;
  const prediction = query.prediction;
  let timeOfImpact = 1;
  let contact = collider.contactShape(query.shape, query.currentCenter, query.rotation, prediction);
  let sweptOvershoot = 0;

  if (!contact && lengthSq(delta) > 1e-10) {
    const hit = collider.castShape(
      ZERO,
      query.shape,
      query.start,
      query.rotation,
      delta,
      prediction,
      1,
      true,
    );
    if (!hit || hit.time_of_impact < 0 || hit.time_of_impact > 1) return true;
    timeOfImpact = hit.time_of_impact;
    const impactCenter = query.impactCenter;
    impactCenter.x = query.start.x + delta.x * timeOfImpact;
    impactCenter.y = query.start.y + delta.y * timeOfImpact;
    impactCenter.z = query.start.z + delta.z * timeOfImpact;
    contact = collider.contactShape(query.shape, impactCenter, query.rotation, prediction + 0.002);
    if (!contact) return true;
    const impactNormal = normalizeInto(contact.normal1, query.normal);
    sweptOvershoot = Math.max(
      0,
      -(1 - timeOfImpact) * dot(delta, impactNormal),
    );
  }
  if (!contact) return true;

  const normal = normalizeInto(contact.normal1, query.normal);
  const climbTopY = findClimbTargetInto(
    collider,
    query.currentCenter,
    contact.point1,
    normal,
    query.wheelForward,
    query.wheelRadius,
    prediction,
    query.maxSupportNormalY,
    query.maxClimbHeight,
    query.edgeAdvance,
    query.climbScratch,
  );
  // Pure upward support belongs to the suspension ray. A mixed
  // up/back corner normal is retained only when the same collider has a
  // validated reachable top; dropping it here creates a gap between the
  // wall contact ending and the downward ray moving over the edge.
  const pureSidewall = query.wheelAxle
    ? Math.abs(dot(normal, normalizeInto(query.wheelAxle, query.axleUnit))) >= 0.80
    : false;
  if (normal.y >= query.maxSupportNormalY && climbTopY === null && !pureSidewall) return true;
  const penetration = Math.max(0, -contact.distance, sweptOvershoot);
  const proximity = Math.max(0, prediction - Math.max(0, contact.distance));
  const severity = penetration + proximity;
  const best = query.out;
  if (
    !query.found
    || severity > query.bestSeverity + 1e-7
    || (Math.abs(severity - query.bestSeverity) <= 1e-7 && timeOfImpact < best.timeOfImpact)
  ) {
    query.bestSeverity = severity;
    query.found = true;
    best.point.x = contact.point1.x;
    best.point.y = contact.point1.y;
    best.point.z = contact.point1.z;
    // `normal` is the shared scratch the next candidate overwrites, so the
    // accepted one has to be copied out rather than aliased.
    best.normal.x = normal.x;
    best.normal.y = normal.y;
    best.normal.z = normal.z;
    // The climb scratch is rewritten by every candidate, so the accepted one
    // is copied into this result's own storage before it is pointed at.
    if (climbTopY === null) {
      best.climbDirection = null;
    } else {
      query.climbOut.x = query.climbScratch.x;
      query.climbOut.y = query.climbScratch.y;
      query.climbOut.z = query.climbScratch.z;
      best.climbDirection = query.climbOut;
    }
    best.climbTopY = climbTopY;
    best.distance = contact.distance;
    best.penetration = penetration;
    best.friction = collider.friction();
    best.timeOfImpact = timeOfImpact;
  }
  return true;
}

/** Probe just beyond a steep face for its upper surface and return the arc
 *  direction from the current hub to a point slightly over that edge. This
 *  approximates deformable tread wrapping a square corner. It deliberately
 *  requires an upward-facing hit on the same collider, so vertical walls and
 *  the back/side of an obstacle cannot produce a false top transition. */
// Collider.castRayAndGetNormal only reads origin/dir; a structural ray avoids
// importing Rapier as a runtime value into this deterministic helper. Hoisted
// with its origin so the probe below reuses one ray and one pointAt closure.
const probeOrigin = { x: 0, y: 0, z: 0 };
const probePoint = { x: 0, y: 0, z: 0 };
const probeRay = {
  origin: probeOrigin,
  dir: { x: 0, y: -1, z: 0 },
  pointAt: (toi: number): ContactVec3 => {
    probePoint.x = probeOrigin.x;
    probePoint.y = probeOrigin.y - toi;
    probePoint.z = probeOrigin.z;
    return probePoint;
  },
} as unknown as RAPIER.Ray;

const intoHorizontal: ContactVec3 = { x: 0, y: 0, z: 0 };
const forwardHorizontal: ContactVec3 = { x: 0, y: 0, z: 0 };

/** Writes the arc direction into `outDirection` and returns the top surface's
 *  Y, or null when there is no reachable top. @hotloop */
function findClimbTargetInto(
  collider: RAPIER.Collider,
  wheelCenter: ContactVec3,
  facePoint: ContactVec3,
  faceNormal: ContactVec3,
  wheelForward: ContactVec3,
  wheelRadius: number,
  prediction: number,
  maxSupportNormalY: number,
  maxClimbHeight: number,
  edgeAdvance: number,
  outDirection: ContactVec3,
): number | null {
  intoHorizontal.x = -faceNormal.x;
  intoHorizontal.y = 0;
  intoHorizontal.z = -faceNormal.z;
  normalizeInto(intoHorizontal, intoHorizontal);
  forwardHorizontal.x = wheelForward.x;
  forwardHorizontal.y = 0;
  forwardHorizontal.z = wheelForward.z;
  normalizeInto(forwardHorizontal, forwardHorizontal);
  if (lengthSq(intoHorizontal) < 0.5 || dot(intoHorizontal, forwardHorizontal) < 0.25) {
    return null;
  }

  const probeInset = Math.max(0.04, prediction * 2);
  probeOrigin.x = facePoint.x + intoHorizontal.x * probeInset;
  probeOrigin.y = wheelCenter.y + maxClimbHeight;
  probeOrigin.z = facePoint.z + intoHorizontal.z * probeInset;
  const hit = collider.castRayAndGetNormal(probeRay, maxClimbHeight + wheelRadius, false);
  if (!hit || hit.normal.y < maxSupportNormalY) return null;

  const topY = probeOrigin.y - hit.timeOfImpact;
  const hubRise = topY + wheelRadius - wheelCenter.y;
  if (hubRise <= prediction || hubRise > maxClimbHeight + prediction) return null;

  outDirection.x = facePoint.x + intoHorizontal.x * edgeAdvance - wheelCenter.x;
  outDirection.y = topY + wheelRadius - wheelCenter.y;
  outDirection.z = facePoint.z + intoHorizontal.z * edgeAdvance - wheelCenter.z;
  normalizeInto(outDirection, outDirection);
  return topY;
}

function interactionGroupsMatch(a: number, b: number): boolean {
  const membershipA = (a >>> 16) & 0xffff;
  const filterA = a & 0xffff;
  const membershipB = (b >>> 16) & 0xffff;
  const filterB = b & 0xffff;
  return (membershipA & filterB) !== 0 && (membershipB & filterA) !== 0;
}

function rotateAroundAxisInto(
  v: ContactVec3,
  axis: ContactVec3,
  angle: number,
  out: ContactVec3,
): ContactVec3 {
  const vx = v.x; const vy = v.y; const vz = v.z;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const av = axis.x * vx + axis.y * vy + axis.z * vz;
  const cvx = axis.y * vz - axis.z * vy;
  const cvy = axis.z * vx - axis.x * vz;
  const cvz = axis.x * vy - axis.y * vx;
  out.x = vx * c + cvx * s + axis.x * av * (1 - c);
  out.y = vy * c + cvy * s + axis.y * av * (1 - c);
  out.z = vz * c + cvz * s + axis.z * av * (1 - c);
  return out;
}

function crossInto(a: ContactVec3, b: ContactVec3, out: ContactVec3): ContactVec3 {
  const ax = a.x; const ay = a.y; const az = a.z;
  const bx = b.x; const by = b.y; const bz = b.z;
  out.x = ay * bz - az * by;
  out.y = az * bx - ax * bz;
  out.z = ax * by - ay * bx;
  return out;
}

function scaleInto(v: ContactVec3, s: number, out: ContactVec3): ContactVec3 {
  out.x = v.x * s;
  out.y = v.y * s;
  out.z = v.z * s;
  return out;
}

function normalizeInto(v: ContactVec3, out: ContactVec3): ContactVec3 {
  const len = length(v);
  if (len < 1e-10) {
    out.x = 0; out.y = 0; out.z = 0;
    return out;
  }
  return scaleInto(v, 1 / len, out);
}

function dot(a: ContactVec3, b: ContactVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(v: ContactVec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function lengthSq(v: ContactVec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
