// Vehicle geometry is resolved from the complete normalized build. Legacy
// CarKind strings are accepted only at old editor/test boundaries and become
// stock builds before any physics values are read.

import { GRAVITY_Y, VEHICLE } from '../constants.js';
import {
  createStockBuild,
  normalizeVehicleBuild,
  resolveVehicleSpec,
  vehicleBuildKey,
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
  /** Low-friction beam collision probes resolved from the selected axle. */
  probe: {
    friction: number;
    tubeRadius: number;
    tubeHalfLength: number;
    housingHalfExtents: { x: number; y: number; z: number };
    verticalOffset: number;
    portal: boolean;
  };
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
  const portal = spec.build.axleId.endsWith('.portal-240');
  const probeScale = portal ? 0.75 : 1;
  const portalClearance = portal ? 0.08 : 0;
  const common = {
    centerLocalY: -half.y,
    trackHalf: spec.track * 0.5,
    suspensionRestLength: spec.suspensionRestLength,
    droopMax: spec.droop,
    bumpMax: 0.21,
    maxArticulation: spec.articulation,
    diffLocked: false,
    probe: {
      friction: 0.08,
      tubeRadius: 0.07 * probeScale,
      tubeHalfLength: Math.max(0.1, (spec.track * 0.5 - 0.20 * probeScale) * 0.5),
      housingHalfExtents: {
        x: 0.20 * probeScale,
        y: 0.15 * probeScale,
        z: 0.16 * probeScale,
      },
      verticalOffset: portalClearance,
      portal,
    },
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

/** Resolving a build is pure but not cheap - normalisation walks nine part
 *  lists and resolveVehicleSpec runs ~40 suffix tests and allocates a dozen
 *  objects, ~3 us a call. Render, effects and tyre-track code all ask for the
 *  geometry of the same handful of builds every frame, so the uncached cost
 *  was per-frame garbage for a value that changes only when someone applies a
 *  new build.
 *
 *  Two layers, because the callers arrive two ways: the render path holds one
 *  long-lived build object per vehicle (WeakMap hits on identity, no hashing),
 *  while the snapshot path decodes a fresh object every 30 Hz tick (falls
 *  through to the key map). The key map is bounded because paint colour is
 *  24-bit and player-chosen: an unbounded Map keyed on it is a slow leak a
 *  room full of repainting players could drive. */
const GEOM_BY_IDENTITY = new WeakMap<VehicleBuild, VehicleGeom>();
const GEOM_BY_KEY = new Map<string, VehicleGeom>();
const GEOM_CACHE_MAX = 256;

function cachedGeom(value: VehicleBuild): VehicleGeom {
  // Keyed on the caller's own object, not the normalised copy: normalising
  // allocates a fresh object every call, so caching against that would never
  // hit. Safe because builds are immutable by convention - every mutation in
  // the codebase spreads into a new object.
  const usable = value !== null && typeof value === 'object';
  if (usable) {
    const seen = GEOM_BY_IDENTITY.get(value);
    if (seen) return seen;
  }
  // Read the key straight off the incoming object first. Cached keys only
  // ever come from normalised builds, so a hit proves all fifteen fields
  // already match one - and an object whose fields match a normalised build
  // normalises to that same build. This is the path the snapshot decoder
  // takes: it hands over an already-normalised build in a fresh object every
  // tick, which the WeakMap above cannot help with.
  let geom = usable ? GEOM_BY_KEY.get(vehicleBuildKey(value)) : undefined;
  if (!geom) {
    const key = vehicleBuildKey(normalizeVehicleBuild(value));
    geom = GEOM_BY_KEY.get(key);
    if (!geom) {
      geom = buildGeom(value);
      if (GEOM_BY_KEY.size >= GEOM_CACHE_MAX) GEOM_BY_KEY.clear();
      GEOM_BY_KEY.set(key, geom);
    }
  }
  if (usable) GEOM_BY_IDENTITY.set(value, geom);
  return geom;
}

export function geomFor(value: CarKind | VehicleBuild): VehicleGeom {
  if (typeof value !== 'string') return cachedGeom(value);
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

/** Derived from the geometry and read every snapshot tick by the effects and
 *  tyre-track paths, so it hangs off the (now cached) geom rather than
 *  allocating five objects per call. The tuple is readonly all the way down. */
const WHEEL_REST_BY_GEOM = new WeakMap<VehicleGeom, WheelRest>();

export function restWheelPositions(value: CarKind | VehicleBuild): WheelRest {
  const g = geomFor(value);
  const seen = WHEEL_REST_BY_GEOM.get(g);
  if (seen) return seen;
  const rest = computeRestWheelPositions(g);
  WHEEL_REST_BY_GEOM.set(g, rest);
  return rest;
}

function computeRestWheelPositions(g: VehicleGeom): WheelRest {
  return [
    { x: -g.front.trackHalf, y: g.front.centerLocalY, z: g.front.centerLocalZ },
    { x: +g.front.trackHalf, y: g.front.centerLocalY, z: g.front.centerLocalZ },
    { x: -g.rear.trackHalf, y: g.rear.centerLocalY, z: g.rear.centerLocalZ },
    { x: +g.rear.trackHalf, y: g.rear.centerLocalY, z: g.rear.centerLocalZ },
  ];
}
