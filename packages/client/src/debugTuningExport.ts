// The debug panel's "Copy settings" text: TUNING rendered as constants.ts
// source, with every multiplier resolved against the constant it scales so
// what gets pasted is an absolute value. Hand-written rather than generated
// from the slider table because that resolution is per field; the cost is
// that a new TUNING field must be added here too, which
// debugTuningExport.test.ts enforces by perturbing every field.

import {
  ANTI_ROLL,
  AXLE,
  ENGINE,
  TIRE_LONG_FRICTION,
  TUNING,
  WATER,
  WHEEL,
} from '@mydrunner/shared';

export function serialiseTuning(): string {
  const t = TUNING;
  const f = (n: number, d = 3): string => Number(n.toFixed(d)).toString();
  // The axle sliders are multipliers, so resolve them against the shipped
  // constants: what you paste into AXLE has to be an absolute rate. These
  // are the PATROL numbers (AXLE.front / AXLE.rear); other kinds derive
  // their own rates in vehicleGeom.ts and scale by the same factor.
  const ax = (base: number, mult: number, d = 0): string => f(base * mult, d);
  return `// Paste into shared/src/constants.ts as new defaults.
export const SURFACE_FRICTION = {
  road: ${f(t.surfaceFriction.road)},
  dirt: ${f(t.surfaceFriction.dirt)},
  mud: ${f(t.surfaceFriction.mud)},
  deepMud: ${f(t.surfaceFriction.deepMud)},
  grass: ${f(t.surfaceFriction.grass)},
  gravel: ${f(t.surfaceFriction.gravel)},
  concrete: ${f(t.surfaceFriction.concrete)},
} as const;
// AXLE.* (solid-axle per-axle suspension), resolved for Patrol:
//   front: {
//     rideStiffness: ${ax(AXLE.front.rideStiffness, t.axleFront.rideStiffnessMult)},   // x${f(t.axleFront.rideStiffnessMult, 2)}
//     rideDamping: ${ax(AXLE.front.rideDamping, t.axleFront.rideDampingMult)},     // x${f(t.axleFront.rideDampingMult, 2)}
//     rollStiffness: ${ax(AXLE.front.rollStiffness, t.axleFront.rollStiffnessMult)},   // x${f(t.axleFront.rollStiffnessMult, 2)}
//     maxArticulation: ${ax(AXLE.front.maxArticulation, t.axleFront.maxArticulationMult, 2)}, // x${f(t.axleFront.maxArticulationMult, 2)}
//   },
//   rear: {
//     rideStiffness: ${ax(AXLE.rear.rideStiffness, t.axleRear.rideStiffnessMult)},   // x${f(t.axleRear.rideStiffnessMult, 2)}
//     rideDamping: ${ax(AXLE.rear.rideDamping, t.axleRear.rideDampingMult)},     // x${f(t.axleRear.rideDampingMult, 2)}
//     rollStiffness: ${ax(AXLE.rear.rollStiffness, t.axleRear.rollStiffnessMult)},   // x${f(t.axleRear.rollStiffnessMult, 2)}
//     maxArticulation: ${ax(AXLE.rear.maxArticulation, t.axleRear.maxArticulationMult, 2)}, // x${f(t.axleRear.maxArticulationMult, 2)}
//   },
export const TIRE_LONG_FRICTION = ${f(TIRE_LONG_FRICTION * t.tireLongGripMult)}; // x${f(t.tireLongGripMult, 2)}
// TIRE_CARCASS live multipliers:
//   pressure edge wrap            x${f(t.tireEdgeWrapMult, 2)}
//   static deflection / compliance x${f(t.tireCarcassComplianceMult, 2)}
//   radial damping               x${f(t.tireRadialDampingMult, 2)}
//   sidewall correction          x${f(t.tireSidewallCorrectionMult, 2)}
//   sidewall friction            x${f(t.tireSidewallFrictionMult, 2)}
// Render-only tyre deformation:
//   visual bagging x${f(t.tireVisualDeformationMult, 2)}, shoulder bulge x${f(t.tireShoulderBulgeMult, 2)}
// TIRE_LATERAL.*:
//   stiffness: ${f(t.tireLatStiffness, 0)},
//   longRatio: ${f(t.tireLateralGripRatio)},
//   slipAnglePeak: ${f(t.tireSlipAnglePeak)}, // ${(t.tireSlipAnglePeak * 180 / Math.PI).toFixed(2)} deg
//   slipAngleFalloff: ${f(t.tireSlipAngleFalloff)},
//   slipAngleFloor: ${f(t.tireSlipAngleFloor)},
//   combinedSlipFloor: ${f(t.tireCombinedSlipFloor)},
//   combinedSlipFalloff: ${f(t.tireCombinedSlipFalloff)},
// ANTI_ROLL.*:
//   torqueStiffness: ${f(ANTI_ROLL.torqueStiffness * t.antiRollStiffnessMult, 0)}, // x${f(t.antiRollStiffnessMult, 2)}
//   torqueDamping: ${f(ANTI_ROLL.torqueDamping * t.antiRollDampingMult, 0)}, // x${f(t.antiRollDampingMult, 2)}
//   frontShare: ${f(t.antiRollFrontShare)},
//   rearShare: ${f(1 - t.antiRollFrontShare)},
// WHEEL.* rolling resistance:
//   rollingResistance: ${f(WHEEL.rollingResistance * t.rollingResistanceMult)}, // x${f(t.rollingResistanceMult, 2)}
//   rollingMultMud: ${f(t.rollingResistanceMudMult)},
//   rollingMultDeepMud: ${f(t.rollingResistanceDeepMudMult)},
// SOIL live multipliers:
//   max sink x${f(t.soilSinkDepthMult, 2)}, bearing strength x${f(t.soilBearingStrengthMult, 2)}
//   shear grip x${f(t.soilShearGripMult, 2)}, bulldozing drag x${f(t.soilBulldozingDragMult, 2)}
// ENGINE.*:
//   peakTorqueNm: ${f(ENGINE.peakTorqueNm * t.engineTorqueMult, 0)}, // x${f(t.engineTorqueMult, 2)}
//   engineBrakeCoef: ${f(ENGINE.engineBrakeCoef * t.engineBrakeMult)}, // x${f(t.engineBrakeMult, 2)}
//   engineBrakeSpeedCoef: ${f(ENGINE.engineBrakeSpeedCoef * t.engineBrakeMult)},
//   shiftUpRpm: ${f(t.engineShiftUpRpm, 0)},
//   shiftDownRpm: ${f(t.engineShiftDownRpm, 0)},
//   shiftHoldTicks: ${f(t.engineShiftHoldTicks, 0)},
// LOW_RANGE.maxCrawlSpeed: ${f(t.lowRangeMaxCrawlSpeed, 2)}
// DRIVELINE.centerTransferMaxReactionNm: ${f(t.centerTransferMaxReactionNm, 0)}
// AXLE differential defaults: front locked ${t.diffLockFront}, rear locked ${t.diffLockRear}
// VEHICLE.* (drive feel):
//   brakeForce: ${f(t.brakeForce, 0)},
//   handbrakeForce: ${f(t.handbrakeForce, 0)},
//   maxSteer: ${f(t.maxSteer, 2)},
//   steerSpeed: ${f(t.steerSpeed, 2)},
//   maxSteerLateralAccel: ${f(t.maxSteerLateralAccel)}, // ${(t.maxSteerLateralAccel / 9.81).toFixed(2)} g
//   frontGripMult: ${f(t.frontGripMult, 2)},
//   rearGripMult: ${f(t.rearGripMult, 2)},
// WATER.* multipliers - resolve against the WATER block before pasting:
//   buoyancy x${f(t.waterBuoyancy, 2)}  (hullVolume ${f(WATER.hullVolume * t.waterBuoyancy, 2)})
//   drag     x${f(t.waterDrag, 2)}  (long ${f(WATER.dragLong * t.waterDrag, 0)}, lat ${f(WATER.dragLat * t.waterDrag * t.waterLateralDragMult, 0)}, vert ${f(WATER.dragVert * t.waterDrag, 0)})
//   lateral drag x${f(t.waterLateralDragMult, 2)}, wheelGripFloor ${f(t.waterWheelGripFloor)}, swampSeconds ${f(t.waterSwampSeconds, 0)}
//   flow     x${f(t.waterFlowScale, 2)}
// CAMERA.*:
//   chaseYawStiffness: ${f(t.cameraChaseYawStiffness, 2)}, chaseYawDamping: ${f(t.cameraChaseYawDamping, 2)},
//   chaseSwingLateral: ${f(t.cameraChaseSwingLateral, 2)}
`;
}
