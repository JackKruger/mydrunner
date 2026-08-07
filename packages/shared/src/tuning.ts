// Live-mutable tuning surface. The fields here are the ones a tester
// (the debug panel) might want to twist while the game is running.
// Vehicle and tyre code reads from TUNING instead of the compile-time
// constants in `constants.ts`; the constants seed the initial values.
//
// Owner physics and the debug panel live in the same browser, so slider
// changes apply immediately to the canonical truck. The "Copy settings"
// button serialises TUNING so the values can be baked into constants.ts as
// new defaults for every client build.

import {
  AXLE,
  INCLINE_ASSIST_MAX,
  SURFACE_FRICTION,
  TIRE_LATERAL,
  VEHICLE,
} from './constants.js';

/** Runtime scalars on an axle's compile-time spring rates.
 *
 *  Multipliers rather than absolute values on purpose: the rates
 *  themselves are per-CarKind (vehicleGeom.ts gives the Hilux a 75k rear
 *  against the Patrol's 90k), and a global absolute override would flatten
 *  those differences the moment a slider moved. Scaling preserves the
 *  per-kind character while still letting a tester twist the feel.
 *
 *  All default to 1.0, so an untouched TUNING reproduces the constants
 *  exactly. */
export interface AxleTuning {
  rideStiffnessMult: number;
  rideDampingMult: number;
  rollStiffnessMult: number;
  maxArticulationMult: number;
}

export interface Tuning {
  inclineAssistMax: number;
  surfaceFriction: {
    road: number;
    dirt: number;
    mud: number;
    deepMud: number;
    grass: number;
    gravel: number;
    concrete: number;
  };
  brakeForce: number;
  maxSteer: number;
  steerSpeed: number;
  frontGripMult: number;
  rearGripMult: number;
  // Solid-axle vehicle knobs. Per-axle scaling so the front and rear can
  // diverge (front stiffer for nose-up climbs, rear softer for cargo
  // articulation). diffLock* toggles the per-axle differential lock
  // (both wheels rotate together) - the rock-crawler trick that lets
  // you keep moving when one wheel lifts off the ground.
  axleFront: AxleTuning;
  axleRear: AxleTuning;
  diffLockFront: boolean;
  diffLockRear: boolean;
  // Lateral grip stiffness for the new model (N per m/s of lateral
  // velocity, before friction-circle clamp).
  tireLatStiffness: number;
}

export const TUNING: Tuning = {
  inclineAssistMax: INCLINE_ASSIST_MAX,
  surfaceFriction: { ...SURFACE_FRICTION } as Tuning['surfaceFriction'],
  brakeForce: VEHICLE.brakeForce,
  maxSteer: VEHICLE.maxSteer,
  steerSpeed: VEHICLE.steerSpeed,
  frontGripMult: VEHICLE.frontGripMult,
  rearGripMult: VEHICLE.rearGripMult,
  axleFront: {
    rideStiffnessMult: 1,
    rideDampingMult: 1,
    rollStiffnessMult: 1,
    maxArticulationMult: 1,
  },
  axleRear: {
    rideStiffnessMult: 1,
    rideDampingMult: 1,
    rollStiffnessMult: 1,
    maxArticulationMult: 1,
  },
  diffLockFront: AXLE.front.diffLocked,
  diffLockRear: AXLE.rear.diffLocked,
  tireLatStiffness: TIRE_LATERAL.stiffness,
};
