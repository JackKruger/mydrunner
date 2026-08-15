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
  ANTI_ROLL,
  AXLE,
  CAMERA,
  DRIVELINE,
  ENGINE,
  LOW_RANGE,
  SURFACE_FRICTION,
  TIRE_LATERAL,
  VEHICLE,
  WATER,
  WHEEL,
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
  /** Rear-axle handbrake force. Separate from brakeForce because the
   *  handbrake must exceed rear tyre grip to lock the wheel. */
  handbrakeForce: number;
  maxSteer: number;
  steerSpeed: number;
  maxSteerLateralAccel: number;
  frontGripMult: number;
  rearGripMult: number;
  /** Multiplier on the base longitudinal friction coefficient. */
  tireLongGripMult: number;
  /** Multiplier on pressure-dependent ledge edge advance and tread hooking. */
  tireEdgeWrapMult: number;
  /** Multiplier on the tyre's nominal static deflection (higher is softer). */
  tireCarcassComplianceMult: number;
  /** Multiplier on carcass radial damping in the series suspension response. */
  tireRadialDampingMult: number;
  /** Multiplier on sidewall penetration correction rate and speed. */
  tireSidewallCorrectionMult: number;
  /** Multiplier on the fitted tyre's sidewall tangential friction. */
  tireSidewallFrictionMult: number;
  /** Render-only multiplier on contact-patch flattening. */
  tireVisualDeformationMult: number;
  /** Render-only multiplier on the volume-preserving shoulder bulge. */
  tireShoulderBulgeMult: number;
  /** Lateral friction capacity relative to longitudinal capacity. */
  tireLateralGripRatio: number;
  tireSlipAnglePeak: number;
  tireSlipAngleFalloff: number;
  tireSlipAngleFloor: number;
  /** Lateral grip retained by a fully locked or fully spinning wheel. */
  tireCombinedSlipFloor: number;
  /** Sharpness of the lateral falloff past the surface's peak slip ratio. */
  tireCombinedSlipFalloff: number;
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
  // Dedicated anti-roll bar controls. Keeping these separate from the axle
  // roll constraint lets cornering balance change without also changing the
  // axle's mechanical articulation response.
  antiRollStiffnessMult: number;
  antiRollDampingMult: number;
  antiRollFrontShare: number;
  // Road is the base multiplier; mud values replace the compile-time surface
  // multipliers while still preserving each vehicle build's resistance.
  rollingResistanceMult: number;
  rollingResistanceMudMult: number;
  rollingResistanceDeepMudMult: number;
  engineTorqueMult: number;
  engineBrakeMult: number;
  engineShiftUpRpm: number;
  engineShiftDownRpm: number;
  engineShiftHoldTicks: number;
  lowRangeMaxCrawlSpeed: number;
  centerTransferMaxReactionNm: number;
  soilSinkDepthMult: number;
  soilBearingStrengthMult: number;
  soilShearGripMult: number;
  soilBulldozingDragMult: number;
  // Water, as multipliers on the WATER block. All three interact
  // strongly - more buoyancy means less tyre load means the current
  // moves you further - so they are the three knobs a crossing gets
  // tuned on, live, while driving it.
  waterBuoyancy: number;
  waterDrag: number;
  waterFlowScale: number;
  waterLateralDragMult: number;
  waterWheelGripFloor: number;
  waterSwampSeconds: number;
  cameraChaseYawStiffness: number;
  cameraChaseYawDamping: number;
  cameraChaseSwingLateral: number;
}

export const TUNING: Tuning = {
  surfaceFriction: { ...SURFACE_FRICTION } as Tuning['surfaceFriction'],
  brakeForce: VEHICLE.brakeForce,
  handbrakeForce: VEHICLE.handbrakeForce,
  maxSteer: VEHICLE.maxSteer,
  steerSpeed: VEHICLE.steerSpeed,
  maxSteerLateralAccel: VEHICLE.maxSteerLateralAccel,
  frontGripMult: VEHICLE.frontGripMult,
  rearGripMult: VEHICLE.rearGripMult,
  tireLongGripMult: 1,
  tireEdgeWrapMult: 1,
  tireCarcassComplianceMult: 1,
  tireRadialDampingMult: 1,
  tireSidewallCorrectionMult: 1,
  tireSidewallFrictionMult: 1,
  tireVisualDeformationMult: 1,
  tireShoulderBulgeMult: 1,
  tireLateralGripRatio: TIRE_LATERAL.longRatio,
  tireSlipAnglePeak: TIRE_LATERAL.slipAnglePeak,
  tireSlipAngleFalloff: TIRE_LATERAL.slipAngleFalloff,
  tireSlipAngleFloor: TIRE_LATERAL.slipAngleFloor,
  tireCombinedSlipFloor: TIRE_LATERAL.combinedSlipFloor,
  tireCombinedSlipFalloff: TIRE_LATERAL.combinedSlipFalloff,
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
  antiRollStiffnessMult: 1,
  antiRollDampingMult: 1,
  antiRollFrontShare: ANTI_ROLL.frontShare,
  rollingResistanceMult: 1,
  rollingResistanceMudMult: WHEEL.rollingMultMud,
  rollingResistanceDeepMudMult: WHEEL.rollingMultDeepMud,
  engineTorqueMult: 1,
  engineBrakeMult: 1,
  engineShiftUpRpm: ENGINE.shiftUpRpm,
  engineShiftDownRpm: ENGINE.shiftDownRpm,
  engineShiftHoldTicks: ENGINE.shiftHoldTicks,
  lowRangeMaxCrawlSpeed: LOW_RANGE.maxCrawlSpeed,
  centerTransferMaxReactionNm: DRIVELINE.centerTransferMaxReactionNm,
  soilSinkDepthMult: 1,
  soilBearingStrengthMult: 1,
  soilShearGripMult: 1,
  soilBulldozingDragMult: 1,
  waterBuoyancy: 1,
  waterDrag: 1,
  waterFlowScale: 1,
  waterLateralDragMult: 1,
  waterWheelGripFloor: WATER.wheelGripFloor,
  waterSwampSeconds: WATER.swampSeconds,
  cameraChaseYawStiffness: CAMERA.chaseYawStiffness,
  cameraChaseYawDamping: CAMERA.chaseYawDamping,
  cameraChaseSwingLateral: CAMERA.chaseSwingLateral,
};
