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
  VEHICLE,
  TIRE,
  SURFACE_FRICTION,
  TIRE_BASE_GRIP,
  INCLINE_ASSIST_MAX,
} from './constants.js';

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
  };
  suspensionStiffness: number;
  suspensionDamping: number;
  suspensionCompression: number;
  maxSuspensionForce: number;
  maxSuspensionTravel: number;
  brakeForce: number;
  maxSteer: number;
  steerSpeed: number;
  frontGripMult: number;
  rearGripMult: number;
  slipPeak: number;
  slipFalloff: number;
  slipFloor: number;
}

export const TUNING: Tuning = {
  tireBaseGrip: TIRE_BASE_GRIP,
  inclineAssistMax: INCLINE_ASSIST_MAX,
  surfaceFriction: { ...SURFACE_FRICTION },
  suspensionStiffness: VEHICLE.suspensionStiffness,
  suspensionDamping: VEHICLE.suspensionDamping,
  suspensionCompression: VEHICLE.suspensionCompression,
  maxSuspensionForce: VEHICLE.maxSuspensionForce,
  maxSuspensionTravel: VEHICLE.maxSuspensionTravel,
  brakeForce: VEHICLE.brakeForce,
  maxSteer: VEHICLE.maxSteer,
  steerSpeed: VEHICLE.steerSpeed,
  frontGripMult: VEHICLE.frontGripMult,
  rearGripMult: VEHICLE.rearGripMult,
  slipPeak: TIRE.slipPeak,
  slipFalloff: TIRE.slipFalloff,
  slipFloor: TIRE.slipFloor,
};
