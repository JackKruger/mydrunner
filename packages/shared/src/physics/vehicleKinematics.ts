// Rigid-body kinematics helpers for the solid-axle model: wheel-centre and
// axle-beam poses from the captured chassis pose, point velocities, and
// world-to-chassis normal rotation. Pure; no Rapier handles.

import { rotateVecByQuat, rotateVecByQuatInto } from './util.js';
import type { AxleGeom } from './vehicleGeom.js';

type Vec3 = { x: number; y: number; z: number };

/** @hotloop */
export function wheelCenterWorldPoseInto(
  bodyPosition: Vec3,
  bodyRotation: { x: number; y: number; z: number; w: number },
  geom: AxleGeom,
  rideY: number,
  rollAngle: number,
  localX: number,
  local: Vec3,
  out: Vec3,
): Vec3 {
  const cr = Math.cos(rollAngle);
  const sr = Math.sin(rollAngle);
  local.x = localX * cr;
  local.y = geom.centerLocalY - geom.suspensionRestLength + rideY + localX * sr;
  local.z = geom.centerLocalZ;
  rotateVecByQuatInto(local, bodyRotation, out);
  out.x += bodyPosition.x;
  out.y += bodyPosition.y;
  out.z += bodyPosition.z;
  return out;
}

/** @hotloop */
export function axleBeamRotationInto(
  chassis: { x: number; y: number; z: number; w: number },
  rollAngle: number,
  out: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
  const half = rollAngle * 0.5;
  const z = Math.sin(half);
  const w = Math.cos(half);
  const cx = chassis.x; const cy = chassis.y; const cz = chassis.z; const cw = chassis.w;
  out.x = cx * w + cy * z;
  out.y = cy * w - cx * z;
  out.z = cz * w + cw * z;
  out.w = cw * w - cz * z;
  return out;
}

export function pointVelocityDot(
  linearVelocity: Vec3,
  angularVelocity: Vec3,
  bodyPosition: Vec3,
  point: Vec3,
  direction: Vec3,
): number {
  const armX = point.x - bodyPosition.x;
  const armY = point.y - bodyPosition.y;
  const armZ = point.z - bodyPosition.z;
  const vx = linearVelocity.x + angularVelocity.y * armZ - angularVelocity.z * armY;
  const vy = linearVelocity.y + angularVelocity.z * armX - angularVelocity.x * armZ;
  const vz = linearVelocity.z + angularVelocity.x * armY - angularVelocity.y * armX;
  return vx * direction.x + vy * direction.y + vz * direction.z;
}

export function worldNormalToLocal(
  normal: Vec3,
  rotation: { x: number; y: number; z: number; w: number },
): Vec3 {
  // Inverse rotation for a unit quaternion is its conjugate.
  return rotateVecByQuat(normal, {
    x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w,
  });
}
