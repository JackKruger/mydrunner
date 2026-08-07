// Per-CarKind axle + chassis geometry: where a kind's physics identity
// lives (axle placement, spring rates, mass and power multipliers).
// Adding a kind = add a geom here + a body builder/palette in the
// client's carMesh.ts + a picker entry in joinScreen.ts.

import { AXLE, GRAVITY_Y, VEHICLE } from '../constants.js';
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
  /** Multiplier on VEHICLE.mass for this kind. 1.0 = unchanged. Lower
   *  values give a lighter chassis (faster accel for the same torque,
   *  more pushable in collisions). */
  massMult: number;
  /** Multiplier on the engine's torque-at-wheels output for this kind.
   *  1.0 = unchanged. Higher values give snappier acceleration. */
  powerMult: number;
  /** Chassis-local Y of the air intake. Once this point goes under the
   *  water surface the engine floods (see WATER.drownTicks).
   *
   *  This is the number that makes the Patrol's modelled snorkel mean
   *  something and the bike's lack of one hurt: same river, different
   *  outcome. Measured from the chassis body origin, which sits at the
   *  middle of the 0.9 m-tall chassis box - so 0 is roughly bonnet-line
   *  and the cabin roof is at VEHICLE.cabinRoofY. */
  airIntakeY: number;
}

const patrolGeom: VehicleGeom = {
  chassisHalfExtents: { ...VEHICLE.chassisHalfExtents },
  wheelRadius: VEHICLE.wheelRadius,
  wheelWidth: VEHICLE.wheelWidth,
  front: { ...AXLE.front },
  rear: { ...AXLE.rear },
  massMult: 1.0,
  powerMult: 1.0,
  // Snorkel: the intake runs up the A-pillar to just under the roof
  // line, which is the whole point of fitting one.
  airIntakeY: 1.05,
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
  massMult: 1.0,
  powerMult: 1.0,
  // Factory intake behind the grille, about bonnet height.
  airIntakeY: 0.30,
};

// Ute (Falcon-style flat-tray): same wheelbase as Patrol but slightly
// stiffer rear axle (no rear suspension softening for cargo, since the
// flat tray sits low and is treated as part of the chassis).
const uteGeom: VehicleGeom = {
  chassisHalfExtents: { ...VEHICLE.chassisHalfExtents },
  wheelRadius: VEHICLE.wheelRadius,
  wheelWidth: VEHICLE.wheelWidth,
  front: { ...AXLE.front },
  rear: { ...AXLE.rear },
  massMult: 1.0,
  powerMult: 1.0,
  // Low-slung sedan-derived front end: sits lower than the Hilux.
  airIntakeY: 0.20,
};

// Motorbike: chassis extents + trackHalf are shared with Patrol so the
// 4-wheel solid-axle solver keeps working unchanged. We DO scale mass
// and engine torque per-kind so the bike feels lighter and quicker:
//   massMult 0.5  → ~750 kg vs Patrol's 1500 kg (VEHICLE.mass)
//   powerMult 1.4 → 40 % more torque at the wheels
// The visual layer in carMesh.ts overlaps the per-axle wheel pair at
// x=0 so the silhouette reads as 1 front + 1 rear wheel.
const motorbikeGeom: VehicleGeom = {
  chassisHalfExtents: { ...VEHICLE.chassisHalfExtents },
  wheelRadius: VEHICLE.wheelRadius,
  wheelWidth: VEHICLE.wheelWidth,
  front: { ...AXLE.front },
  rear: { ...AXLE.rear },
  massMult: 0.5,
  powerMult: 1.4,
  // Airbox under the tank, and nothing sealed around it. First to drown.
  airIntakeY: -0.05,
};

export const VEHICLE_GEOM: Record<CarKind, VehicleGeom> = {
  patrol: patrolGeom,
  hilux: hiluxGeom,
  ute: uteGeom,
  motorbike: motorbikeGeom,
};

export function geomFor(kind: CarKind): VehicleGeom {
  return VEHICLE_GEOM[kind];
}

/** Chassis-centre height above the ground at suspension equilibrium for
 *  a kind: rest length + wheel radius + |axle mount Y|, minus the static
 *  spring compression under the kind's actual mass (massMult applied —
 *  a motorbike compresses its springs half as much as a Patrol).
 *  Spawning at this height means no free-fall and no settle bounce. */
export function spawnYAboveGround(kind: CarKind): number {
  const g = geomFor(kind);
  const massKg = VEHICLE.mass * g.massMult;
  const staticComp = (massKg * Math.abs(GRAVITY_Y)) / (g.front.rideStiffness + g.rear.rideStiffness);
  return g.front.suspensionRestLength + g.wheelRadius + Math.abs(g.front.centerLocalY) - staticComp;
}

type WheelRest = readonly [
  { readonly x: number; readonly y: number; readonly z: number },
  { readonly x: number; readonly y: number; readonly z: number },
  { readonly x: number; readonly y: number; readonly z: number },
  { readonly x: number; readonly y: number; readonly z: number },
];

const buildRest = (g: VehicleGeom): WheelRest =>
  [
    { x: -g.front.trackHalf, y: g.front.centerLocalY, z: g.front.centerLocalZ },
    { x: +g.front.trackHalf, y: g.front.centerLocalY, z: g.front.centerLocalZ },
    { x: -g.rear.trackHalf, y: g.rear.centerLocalY, z: g.rear.centerLocalZ },
    { x: +g.rear.trackHalf, y: g.rear.centerLocalY, z: g.rear.centerLocalZ },
  ] as const;

const REST_WHEEL_POSITIONS: Record<CarKind, WheelRest> = {
  patrol: buildRest(patrolGeom),
  hilux: buildRest(hiluxGeom),
  ute: buildRest(uteGeom),
  motorbike: buildRest(motorbikeGeom),
};

/** Rest-pose wheel positions in chassis-local space, derived from the
 *  per-kind axle geometry. Order: [FL, FR, RL, RR] - the index
 *  convention every renderer and the wheel-state wire tuple share.
 *  Returns a shared frozen-shape array; callers must NOT mutate it. */
export function restWheelPositions(kind: CarKind): WheelRest {
  return REST_WHEEL_POSITIONS[kind];
}
