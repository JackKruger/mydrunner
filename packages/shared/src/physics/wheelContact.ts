// Hybrid tyre-volume contacts for faces a suspension ray cannot see.
//
// Ordinary ground support remains ray-based. Each wheel also queries a
// cylinder matching the visible tyre against nearby world colliders and
// accepts only steep contacts. This gives kerbs, rock steps and logs a real
// leading face without introducing four jointed rigid bodies and replacing
// the existing solid-axle suspension model.

import type RAPIER from '@dimforge/rapier3d-compat';

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
}

const ZERO: ContactVec3 = { x: 0, y: 0, z: 0 };

export function wheelBasis(
  chassisForward: ContactVec3,
  chassisRight: ContactVec3,
  chassisUp: ContactVec3,
  axleRoll: number,
  steerAngle: number,
): WheelBasis {
  const cr = Math.cos(axleRoll);
  const sr = Math.sin(axleRoll);
  const axleUp = normalize({
    x: chassisUp.x * cr - chassisRight.x * sr,
    y: chassisUp.y * cr - chassisRight.y * sr,
    z: chassisUp.z * cr - chassisRight.z * sr,
  });
  const forward = Math.abs(steerAngle) > 1e-8
    ? normalize(rotateAroundAxis(chassisForward, axleUp, steerAngle))
    : normalize(chassisForward);
  // Rebuild the axle from the steered forward vector. This keeps the tyre
  // cylinder and force frame orthogonal even at full articulation + steer.
  const steeredAxle = normalize(cross(axleUp, forward));
  return { forward, axle: steeredAxle, up: axleUp };
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
  let longitudinal = cross(wheelAxle, normal);
  const len = length(longitudinal);
  if (len < 1e-6) return null;
  longitudinal = scale(longitudinal, 1 / len);
  // On ground/slopes the cross-product must agree with wheel-forward. At a
  // vertical wall their dot is zero, and the raw cross-product's sign is the
  // one that makes positive wheel rotation climb a forward-facing ledge.
  if (dot(longitudinal, wheelForward) < -1e-6) {
    longitudinal = scale(longitudinal, -1);
  }
  let lateral = normalize(cross(normal, longitudinal));
  if (dot(lateral, wheelAxle) < 0) lateral = scale(lateral, -1);
  return { longitudinal, lateral };
}

/** Quaternion rotating Rapier Cylinder's local +Y axis onto the wheel axle. */
export function cylinderRotation(wheelAxle: ContactVec3): ContactQuat {
  const axis = normalize(wheelAxle);
  const d = clamp(axis.y, -1, 1);
  if (d < -0.999999) return { x: 1, y: 0, z: 0, w: 0 };
  const s = Math.sqrt(2 * (1 + d));
  if (s < 1e-8) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: axis.z / s,
    y: 0,
    z: -axis.x / s,
    w: s * 0.5,
  };
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
): SteepWheelContact | null {
  const start = previousCenter ?? currentCenter;
  const delta = sub(currentCenter, start);
  const bound = Math.hypot(wheelRadius, wheelHalfWidth) + prediction;
  const aabbCenter = scale(add(start, currentCenter), 0.5);
  const aabbHalf = {
    x: Math.abs(delta.x) * 0.5 + bound,
    y: Math.abs(delta.y) * 0.5 + bound,
    z: Math.abs(delta.z) * 0.5 + bound,
  };

  let best: SteepWheelContact | null = null;
  let bestSeverity = -Infinity;
  world.collidersWithAabbIntersectingAabb(aabbCenter, aabbHalf, (collider) => {
    if (!interactionGroupsMatch(queryGroups, collider.collisionGroups())) return true;

    let timeOfImpact = 1;
    let contact = collider.contactShape(shape, currentCenter, rotation, prediction);
    let sweptOvershoot = 0;

    if (!contact && lengthSq(delta) > 1e-10) {
      const hit = collider.castShape(
        ZERO,
        shape,
        start,
        rotation,
        delta,
        prediction,
        1,
        true,
      );
      if (!hit || hit.time_of_impact < 0 || hit.time_of_impact > 1) return true;
      timeOfImpact = hit.time_of_impact;
      const impactCenter = add(start, scale(delta, timeOfImpact));
      contact = collider.contactShape(shape, impactCenter, rotation, prediction + 0.002);
      if (!contact) return true;
      const impactNormal = normalize(contact.normal1);
      sweptOvershoot = Math.max(
        0,
        -(1 - timeOfImpact) * dot(delta, impactNormal),
      );
    }
    if (!contact) return true;

    const normal = normalize(contact.normal1);
    const climb = findClimbTarget(
      collider,
      currentCenter,
      contact.point1,
      normal,
      wheelForward,
      wheelRadius,
      prediction,
      maxSupportNormalY,
      maxClimbHeight,
      edgeAdvance,
    );
    // Pure upward support belongs to the suspension ray. A mixed
    // up/back corner normal is retained only when the same collider has a
    // validated reachable top; dropping it here creates a gap between the
    // wall contact ending and the downward ray moving over the edge.
    if (normal.y >= maxSupportNormalY && climb === null) return true;
    const penetration = Math.max(0, -contact.distance, sweptOvershoot);
    const proximity = Math.max(0, prediction - Math.max(0, contact.distance));
    const severity = penetration + proximity;
    if (
      best === null
      || severity > bestSeverity + 1e-7
      || (Math.abs(severity - bestSeverity) <= 1e-7 && timeOfImpact < best.timeOfImpact)
    ) {
      bestSeverity = severity;
      best = {
        point: { x: contact.point1.x, y: contact.point1.y, z: contact.point1.z },
        normal,
        climbDirection: climb?.direction ?? null,
        climbTopY: climb?.topY ?? null,
        distance: contact.distance,
        penetration,
        friction: collider.friction(),
        timeOfImpact,
      };
    }
    return true;
  });
  return best;
}

/** Probe just beyond a steep face for its upper surface and return the arc
 *  direction from the current hub to a point slightly over that edge. This
 *  approximates deformable tread wrapping a square corner. It deliberately
 *  requires an upward-facing hit on the same collider, so vertical walls and
 *  the back/side of an obstacle cannot trigger crawler assist. */
interface ClimbTarget {
  direction: ContactVec3;
  topY: number;
}

function findClimbTarget(
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
): ClimbTarget | null {
  const intoHorizontal = normalize({ x: -faceNormal.x, y: 0, z: -faceNormal.z });
  const forwardHorizontal = normalize({ x: wheelForward.x, y: 0, z: wheelForward.z });
  if (lengthSq(intoHorizontal) < 0.5 || dot(intoHorizontal, forwardHorizontal) < 0.25) {
    return null;
  }

  const probeInset = Math.max(0.04, prediction * 2);
  const origin = {
    x: facePoint.x + intoHorizontal.x * probeInset,
    y: wheelCenter.y + maxClimbHeight,
    z: facePoint.z + intoHorizontal.z * probeInset,
  };
  // Collider.castRayAndGetNormal only reads origin/dir; a structural ray
  // avoids importing Rapier as a runtime value into this deterministic helper.
  const ray = {
    origin,
    dir: { x: 0, y: -1, z: 0 },
    pointAt: (toi: number) => ({ x: origin.x, y: origin.y - toi, z: origin.z }),
  } as RAPIER.Ray;
  const hit = collider.castRayAndGetNormal(ray, maxClimbHeight + wheelRadius, false);
  if (!hit || hit.normal.y < maxSupportNormalY) return null;

  const topY = origin.y - hit.timeOfImpact;
  const hubRise = topY + wheelRadius - wheelCenter.y;
  if (hubRise <= prediction || hubRise > maxClimbHeight + prediction) return null;

  const target = {
    x: facePoint.x + intoHorizontal.x * edgeAdvance,
    y: topY + wheelRadius,
    z: facePoint.z + intoHorizontal.z * edgeAdvance,
  };
  return { direction: normalize(sub(target, wheelCenter)), topY };
}

function interactionGroupsMatch(a: number, b: number): boolean {
  const membershipA = (a >>> 16) & 0xffff;
  const filterA = a & 0xffff;
  const membershipB = (b >>> 16) & 0xffff;
  const filterB = b & 0xffff;
  return (membershipA & filterB) !== 0 && (membershipB & filterA) !== 0;
}

function rotateAroundAxis(v: ContactVec3, axis: ContactVec3, angle: number): ContactVec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const av = dot(axis, v);
  const cv = cross(axis, v);
  return {
    x: v.x * c + cv.x * s + axis.x * av * (1 - c),
    y: v.y * c + cv.y * s + axis.y * av * (1 - c),
    z: v.z * c + cv.z * s + axis.z * av * (1 - c),
  };
}

function cross(a: ContactVec3, b: ContactVec3): ContactVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: ContactVec3, b: ContactVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function add(a: ContactVec3, b: ContactVec3): ContactVec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: ContactVec3, b: ContactVec3): ContactVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(v: ContactVec3, s: number): ContactVec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function length(v: ContactVec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function lengthSq(v: ContactVec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

function normalize(v: ContactVec3): ContactVec3 {
  const len = length(v);
  if (len < 1e-10) return { x: 0, y: 0, z: 0 };
  return scale(v, 1 / len);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
