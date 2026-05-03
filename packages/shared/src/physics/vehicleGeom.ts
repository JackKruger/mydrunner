// Per-CarKind axle + chassis geometry. Phase 1 keeps both kinds on the
// shared AXLE defaults (so Patrol and Hilux drive identically through the
// new model, just as they do today). Phase 3 differentiates them - that's
// the natural place to give the Hilux a longer wheelbase, narrower track,
// and a softer rear axle for cargo carrying.

import { AXLE, VEHICLE } from '../constants.js';
import type { CarKind } from '../types.js';

export interface AxleGeom {
  /** Chassis-local Y of the axle attachment (typically chassis bottom edge). */
  centerLocalY: number;
  /** Chassis-local Z of the axle attachment. +Z = front. */
  centerLocalZ: number;
  /** Half the distance between left and right wheel hubs (m). */
  trackHalf: number;
  /** Free-hang length of the spring at zero compression (m). */
  suspensionRestLength: number;
  /** Maximum the axle can drop below rest (m, positive). */
  droopMax: number;
  /** Maximum the axle can rise toward the chassis (m, positive). */
  bumpMax: number;
  rideStiffness: number;
  rideDamping: number;
  rollStiffness: number;
  rollDamping: number;
  /** Maximum |rollAngle| of the axle about chassis-forward axis (rad). */
  maxArticulation: number;
  axleMass: number;
  axleRollInertia: number;
  hasDrive: boolean;
  hasSteering: boolean;
  diffLocked: boolean;
}

export interface VehicleGeom {
  chassisHalfExtents: { x: number; y: number; z: number };
  wheelRadius: number;
  wheelWidth: number;
  front: AxleGeom;
  rear: AxleGeom;
}

const patrolGeom: VehicleGeom = {
  chassisHalfExtents: { ...VEHICLE.chassisHalfExtents },
  wheelRadius: VEHICLE.wheelRadius,
  wheelWidth: VEHICLE.wheelWidth,
  front: { ...AXLE.front },
  rear: { ...AXLE.rear },
};

// Hilux: ute proportions = longer wheelbase (rear axle pushed back to
// support the bed) + softer rear ride for cargo articulation. Front
// axle is unchanged so the cabin sits where the existing carMesh.ts
// body geometry expects it. Rear track and articulation match Patrol
// because the chassis body and bed widths are identical.
const hiluxGeom: VehicleGeom = {
  chassisHalfExtents: { ...VEHICLE.chassisHalfExtents },
  wheelRadius: VEHICLE.wheelRadius,
  wheelWidth: VEHICLE.wheelWidth,
  front: { ...AXLE.front },
  rear: {
    ...AXLE.rear,
    centerLocalZ: -1.4,           // 0.1m rearward of Patrol's -1.3
    rideStiffness: 75_000,        // softer than Patrol's 90k for cargo
    maxArticulation: 0.55,        // a little more rear flex
  },
};

export const VEHICLE_GEOM: Record<CarKind, VehicleGeom> = {
  patrol: patrolGeom,
  hilux: hiluxGeom,
};

export function geomFor(kind: CarKind): VehicleGeom {
  return VEHICLE_GEOM[kind];
}

/** Rest-pose wheel positions in chassis-local space, derived from the
 *  per-kind axle geometry. Order: [FL, FR, RL, RR] - matches the legacy
 *  VEHICLE.wheelPositions index convention so existing renderers can
 *  still reference indices the same way. */
export function restWheelPositions(kind: CarKind): [
  { x: number; y: number; z: number },
  { x: number; y: number; z: number },
  { x: number; y: number; z: number },
  { x: number; y: number; z: number },
] {
  const g = VEHICLE_GEOM[kind];
  return [
    { x: -g.front.trackHalf, y: g.front.centerLocalY, z: g.front.centerLocalZ },
    { x: +g.front.trackHalf, y: g.front.centerLocalY, z: g.front.centerLocalZ },
    { x: -g.rear.trackHalf, y: g.rear.centerLocalY, z: g.rear.centerLocalZ },
    { x: +g.rear.trackHalf, y: g.rear.centerLocalY, z: g.rear.centerLocalZ },
  ];
}
