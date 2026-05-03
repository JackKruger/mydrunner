// Live-mutable tuning surface. The fields here are the ones a tester
// (the debug panel) might want to twist while the game is running.
// Vehicle and tyre code reads from TUNING instead of the compile-time
// constants in `constants.ts`; the constants seed the initial values.
//
// Each running process (client, server) has its own TUNING instance.
// The debug panel is client-only, so mutations there don't propagate
// to the server - some reconcile drift while tuning is the expected
// trade-off. The "Copy settings" button serialises TUNING so the
// values can be baked into constants.ts as new defaults.

import {
  AXLE,
  INCLINE_ASSIST_MAX,
  SURFACE_FRICTION,
  TIRE,
  TIRE_BASE_GRIP,
  TIRE_LATERAL,
  VEHICLE,
} from './constants.js';

export interface AxleTuning {
  rideStiffness: number;
  rideDamping: number;
  rollStiffness: number;
  rollDamping: number;
  maxArticulation: number;
}

export interface Tuning {
  tireBaseGrip: number;
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
  slipPeak: number;
  slipFalloff: number;
  slipFloor: number;
  // Solid-axle vehicle knobs. Per-axle tuning so the front and rear can
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
  tireBaseGrip: TIRE_BASE_GRIP,
  inclineAssistMax: INCLINE_ASSIST_MAX,
  surfaceFriction: { ...SURFACE_FRICTION } as Tuning['surfaceFriction'],
  brakeForce: VEHICLE.brakeForce,
  maxSteer: VEHICLE.maxSteer,
  steerSpeed: VEHICLE.steerSpeed,
  frontGripMult: VEHICLE.frontGripMult,
  rearGripMult: VEHICLE.rearGripMult,
  slipPeak: TIRE.slipPeak,
  slipFalloff: TIRE.slipFalloff,
  slipFloor: TIRE.slipFloor,
  axleFront: {
    rideStiffness: AXLE.front.rideStiffness,
    rideDamping: AXLE.front.rideDamping,
    rollStiffness: AXLE.front.rollStiffness,
    rollDamping: AXLE.front.rollDamping,
    maxArticulation: AXLE.front.maxArticulation,
  },
  axleRear: {
    rideStiffness: AXLE.rear.rideStiffness,
    rideDamping: AXLE.rear.rideDamping,
    rollStiffness: AXLE.rear.rollStiffness,
    rollDamping: AXLE.rear.rollDamping,
    maxArticulation: AXLE.rear.maxArticulation,
  },
  diffLockFront: AXLE.front.diffLocked,
  diffLockRear: AXLE.rear.diffLocked,
  tireLatStiffness: TIRE_LATERAL.stiffness,
};
