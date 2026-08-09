import { FIXED_DT, WINCH } from '../constants.js';
import type { Quat, Vec3, WinchMotor } from '../types.js';
import type { Obstacle } from './objectCatalog.js';
import { rotateVecByQuat } from './util.js';

export interface WinchEndpoint {
  position: Vec3;
  velocity: Vec3;
}

export interface WinchForceResult {
  direction: Vec3;
  distance: number;
  extension: number;
  demand: number;
  tension: number;
}

export interface WinchRuntimeState {
  cableLength: number;
  tension: number;
  overloadTime: number;
  broken: boolean;
}

export function transformPoint(local: Vec3, position: Vec3, rotation: Quat): Vec3 {
  const r = rotateVecByQuat(local, rotation);
  return { x: position.x + r.x, y: position.y + r.y, z: position.z + r.z };
}

export function pointVelocity(
  local: Vec3,
  rotation: Quat,
  linVel: Vec3,
  angVel: Vec3,
): Vec3 {
  const r = rotateVecByQuat(local, rotation);
  return {
    x: linVel.x + angVel.y * r.z - angVel.z * r.y,
    y: linVel.y + angVel.z * r.x - angVel.x * r.z,
    z: linVel.z + angVel.x * r.y - angVel.y * r.x,
  };
}

export function computeWinchForce(
  source: WinchEndpoint,
  target: WinchEndpoint,
  cableLength: number,
): WinchForceResult {
  const dx = target.position.x - source.position.x;
  const dy = target.position.y - source.position.y;
  const dz = target.position.z - source.position.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(distance) || distance < 1e-6) {
    return { direction: { x: 0, y: 0, z: 0 }, distance: 0, extension: 0, demand: 0, tension: 0 };
  }
  const direction = { x: dx / distance, y: dy / distance, z: dz / distance };
  const extension = Math.max(0, distance - cableLength);
  if (extension <= 0) return { direction, distance, extension: 0, demand: 0, tension: 0 };
  const separationRate =
    (target.velocity.x - source.velocity.x) * direction.x
    + (target.velocity.y - source.velocity.y) * direction.y
    + (target.velocity.z - source.velocity.z) * direction.z;
  const demand = Math.max(0, WINCH.stiffness * extension + WINCH.damping * separationRate);
  return { direction, distance, extension, demand, tension: Math.min(demand, WINCH.breakForce) };
}

export function stepWinchRuntime(
  state: WinchRuntimeState,
  motor: WinchMotor,
  demand: number,
  dt = FIXED_DT,
): WinchRuntimeState {
  const tension = Math.min(Math.max(0, demand), WINCH.breakForce);
  let cableLength = state.cableLength;
  if (motor === 1) {
    const loadFactor = Math.max(0, 1 - tension / WINCH.ratedPull);
    cableLength -= WINCH.reelInSpeed * loadFactor * dt;
  } else if (motor === -1) {
    cableLength += WINCH.reelOutSpeed * dt;
  }
  cableLength = Math.max(WINCH.minCableLength, Math.min(WINCH.maxCableLength, cableLength));
  const overloadTime = demand > WINCH.breakForce
    ? state.overloadTime + dt
    : Math.max(0, state.overloadTime - dt * WINCH.overloadRecoveryRate);
  return { cableLength, tension, overloadTime, broken: overloadTime >= WINCH.breakDelay };
}

const TRUNK_KINDS = new Set(['tree', 'pine', 'deadTree', 'palm']);

/** Resolve a fixed point at attach time; moving the truck later cannot move
 * its own anchor around the object. */
export function winchAnchorForObstacle(obstacle: Obstacle, source: Vec3): Vec3 | null {
  const trunk = TRUNK_KINDS.has(obstacle.kind);
  const stump = obstacle.kind === 'stump' && obstacle.size >= 0.35;
  const rock = (obstacle.kind === 'rock' && obstacle.size >= 1.25) || obstacle.kind === 'boulder';
  if (!trunk && !stump && !rock) return null;
  const dx = source.x - obstacle.x;
  const dz = source.z - obstacle.z;
  const len = Math.hypot(dx, dz) || 1;
  const radial = rock ? obstacle.size * 0.65 : obstacle.size;
  const y = rock
    ? obstacle.y + obstacle.size * 0.55
    : obstacle.y + Math.max(0.5, Math.min(1.2, obstacle.height * 0.15));
  return {
    x: obstacle.x + dx / len * radial,
    y,
    z: obstacle.z + dz / len * radial,
  };
}
