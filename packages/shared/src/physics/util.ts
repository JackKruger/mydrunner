// Small math helpers used across the physics + render layers.

import type { Vec3, Quat } from '../types.js';

/** Rotate a vector by a quaternion: q * v * q^-1. Equivalent to applying
 *  the quaternion's rotation to the vector. Used wherever a local-frame
 *  point (wheel position, lookAt offset) needs to be transformed into
 *  world space by a rigid body's orientation. */
export function rotateVecByQuat(v: Vec3, q: Quat): Vec3 {
  return rotateVecByQuatInto(v, q, { x: 0, y: 0, z: 0 });
}

/** `rotateVecByQuat` writing into a caller-owned vector.
 *
 *  The owner physics tick rotates ~40 local-frame points per vehicle, so the
 *  allocating form alone was a measurable share of the step's garbage. Aliasing
 *  is safe: `v` is fully read into locals before `out` is written, so
 *  `rotateVecByQuatInto(p, q, p)` rotates in place.
 *
 *  @hotloop */
export function rotateVecByQuatInto(v: Vec3, q: Quat, out: Vec3): Vec3 {
  const vx = v.x; const vy = v.y; const vz = v.z;
  const ix = q.w * vx + q.y * vz - q.z * vy;
  const iy = q.w * vy + q.z * vx - q.x * vz;
  const iz = q.w * vz + q.x * vy - q.y * vx;
  const iw = -q.x * vx - q.y * vy - q.z * vz;
  out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
  return out;
}
