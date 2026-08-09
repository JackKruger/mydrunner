// Vehicle geometry is resolved from the complete normalized build. Legacy
// CarKind strings are accepted only at old editor/test boundaries and become
// stock builds before any physics values are read.

import { GRAVITY_Y, VEHICLE } from '../constants.js';
import {
  createStockBuild,
  normalizeVehicleBuild,
  resolveVehicleSpec,
  type ResolvedVehicleSpec,
} from '../vehicleBuild.js';
import { normalizeVehicleBaseId } from '../types.js';
import type { CarKind, VehicleBuild } from '../types.js';

export interface AxleGeom {
  centerLocalY: number;
  /** +Z is forward. */
  centerLocalZ: number;
  trackHalf: number;
  suspensionRestLength: number;
  droopMax: number;
  bumpMax: number;
  rideStiffness: number;
  rideDamping: number;
  rollStiffness: number;
  rollDamping: number;
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
  massMult: number;
  powerMult: number;
  airIntakeY: number;
  recoveryPoints: {
    fairlead: { x: number; y: number; z: number };
    front: { x: number; y: number; z: number };
    rear: { x: number; y: number; z: number };
  };
  spec: ResolvedVehicleSpec;
}

function asBuild(value: CarKind | VehicleBuild): VehicleBuild {
  return typeof value === 'string'
    ? createStockBuild(normalizeVehicleBaseId(value))
    : normalizeVehicleBuild(value);
}

function damping(stiffness: number, axleMassShare: number): number {
  return 0.68 * 2 * Math.sqrt(stiffness * axleMassShare);
}

function buildGeom(value: CarKind | VehicleBuild): VehicleGeom {
  const build = asBuild(value);
  const spec = resolveVehicleSpec(build);
  const half = spec.chassisHalfExtents;
  const frontMass = spec.massKg * 0.52;
  const rearMass = spec.massKg * 0.48;
  const rollBase = 24_000 + spec.stability * 16_000;
  const common = {
    centerLocalY: -half.y,
    trackHalf: spec.track * 0.5,
    suspensionRestLength: spec.suspensionRestLength,
    droopMax: spec.droop,
    bumpMax: 0.21,
    maxArticulation: spec.articulation,
    diffLocked: false,
  };
  return {
    chassisHalfExtents: { ...half },
    wheelRadius: spec.wheelRadius,
    wheelWidth: spec.wheelWidth,
    front: {
      ...common,
      centerLocalZ: spec.wheelbase * 0.5,
      rideStiffness: spec.frontSpring,
      rideDamping: damping(spec.frontSpring, frontMass * 0.5),
      rollStiffness: rollBase,
      rollDamping: 1_900,
      axleMass: 120,
      axleRollInertia: 26,
      hasDrive: spec.drivetrain !== 'fixed-rwd',
      hasSteering: true,
    },
    rear: {
      ...common,
      centerLocalZ: -spec.wheelbase * 0.5,
      rideStiffness: spec.rearSpring,
      rideDamping: damping(spec.rearSpring, rearMass * 0.5),
      rollStiffness: rollBase * 0.82,
      rollDamping: 1_650,
      axleMass: 135,
      axleRollInertia: 29,
      hasDrive: true,
      hasSteering: false,
    },
    massMult: spec.massKg / VEHICLE.mass,
    powerMult: spec.powerMult,
    airIntakeY: spec.intakeHeight,
    recoveryPoints: {
      fairlead: { x: 0, y: -half.y * 0.02, z: half.z + 0.45 },
      front: { x: 0, y: -half.y * 0.12, z: half.z + 0.18 },
      rear: { x: 0, y: -half.y * 0.12, z: -half.z - 0.12 },
    },
    spec,
  };
}

const STOCK_GEOM = {
  ridgeback: buildGeom('ridgeback'),
  overlander: buildGeom('overlander'),
  'stockman-single': buildGeom('stockman-single'),
  'stockman-dual': buildGeom('stockman-dual'),
  longreach: buildGeom('longreach'),
  outclaw: buildGeom('outclaw'),
  'dustback-rs': buildGeom('dustback-rs'),
} as const;

/** Stock base geometry table retained for diagnostics and tuning tools. */
export const VEHICLE_GEOM = STOCK_GEOM;

export function geomFor(value: CarKind | VehicleBuild): VehicleGeom {
  if (typeof value !== 'string') return buildGeom(value);
  return STOCK_GEOM[normalizeVehicleBaseId(value)];
}

export function spawnYAboveGround(value: CarKind | VehicleBuild): number {
  const g = geomFor(value);
  const massKg = VEHICLE.mass * g.massMult;
  const staticComp = (massKg * Math.abs(GRAVITY_Y))
    / (g.front.rideStiffness + g.rear.rideStiffness);
  return g.front.suspensionRestLength + g.wheelRadius
    + Math.abs(g.front.centerLocalY) - staticComp;
}

type WheelRest = readonly [
  { readonly x: number; readonly y: number; readonly z: number },
  { readonly x: number; readonly y: number; readonly z: number },
  { readonly x: number; readonly y: number; readonly z: number },
  { readonly x: number; readonly y: number; readonly z: number },
];

export function restWheelPositions(value: CarKind | VehicleBuild): WheelRest {
  const g = geomFor(value);
  return [
    { x: -g.front.trackHalf, y: g.front.centerLocalY, z: g.front.centerLocalZ },
    { x: +g.front.trackHalf, y: g.front.centerLocalY, z: g.front.centerLocalZ },
    { x: -g.rear.trackHalf, y: g.rear.centerLocalY, z: g.rear.centerLocalZ },
    { x: +g.rear.trackHalf, y: g.rear.centerLocalY, z: g.rear.centerLocalZ },
  ];
}
