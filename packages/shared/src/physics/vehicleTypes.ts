// Shared vehicle interface that SolidAxleVehicle satisfies.
// World.spawnVehicle returns this; LocalSimulation and tests program
// against it instead of the concrete class.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { DrivetrainState, PlayerInput, VehicleBuild, VehicleDamageState, VehicleState } from '../types.js';
import type { AxleSnap } from './axle.js';

export interface VehicleSpawn {
  position: { x: number; y: number; z: number };
  yaw?: number;
}

export interface ExternalPointLoad {
  force: { x: number; y: number; z: number };
  point: { x: number; y: number; z: number };
}

/** Water state of one vehicle, for the HUD and the spray effects.
 *
 *  Not part of VehicleState and not on the wire: a drowned engine
 *  already reads as rpm 0 / gear 0 through the existing snapshot tuple,
 *  and a remote truck's spray is derived from its transmitted position
 *  against the water height both ends compute from the same map. */
export interface WaterStatus {
  /** 0..1 mean submersion of the hull. */
  submerged: number;
  /** Metres of water over each wheel, [FL, FR, RL, RR]. */
  wheelDepths: [number, number, number, number];
  intakeSubmerged: boolean;
  drowned: boolean;
  /** 0..1 displacement lost to flooding. */
  flood: number;
}

export interface PressureStatus {
  currentPsi: number;
  nominalPsi: number;
  minPsi: number;
  maxPsi: number;
  adjusting: -1 | 0 | 1;
  reason: string | null;
}

/** Owner-only physics instrumentation used by the `?dev` visualiser.
 *
 * This deliberately stays outside VehicleState: it is high-frequency tuning
 * data for the vehicle's owning browser, not gameplay state that remote
 * players need over the wire. */
export interface WheelDebugTelemetry {
  contact: boolean;
  contactPoint: { x: number; y: number; z: number };
  contactNormal: { x: number; y: number; z: number };
  surface: number;
  waterDepth: number;
  normalLoad: number;
  gripCoefficient: number;
  gripLimit: number;
  longitudinalForce: number;
  relaxedLongitudinalForce: number;
  lateralForce: number;
  force: { x: number; y: number; z: number };
  slipRatio: number;
  slipAngle: number;
  /** 0..1 fraction of the tire's elliptical friction budget in use. */
  utilization: number;
  suspensionCompression: number;
  suspensionOrigin: { x: number; y: number; z: number };
  suspensionEnd: { x: number; y: number; z: number };
  wheelCenter: { x: number; y: number; z: number };
  suspensionRestLength: number;
  droopMax: number;
  bumpMax: number;
  angularVelocity: number;
  driveTorque: number;
  brakeTorque: number;
  groundTorque: number;
  contactZone: 'tread' | 'shoulder' | 'sidewall' | 'air';
  treadFraction: number;
  suspensionAxisAlignment: number;
  carcassDeflection: number;
  suspensionForce: number;
  carcassForce: number;
  sinkDepth: number;
  soilDrag: number;
  slipWork: number;
  /** World-space vertical velocity of the kinematic wheel centre (m/s). */
  verticalVelocity: number;
}

export interface VehicleDebugTelemetry {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  centerOfMassLocal: { x: number; y: number; z: number };
  centerOfMassWorld: { x: number; y: number; z: number };
  massKg: number;
  wheelbase: number;
  track: number;
  wheelRadius: number;
  pressurePsi: number;
  rollAngle: number;
  pitchAngle: number;
  staticRollLimit: number;
  staticPitchLimit: number;
  linearVelocity: { x: number; y: number; z: number };
  angularVelocity: { x: number; y: number; z: number };
  accelerationWorld: { x: number; y: number; z: number };
  longitudinalG: number;
  lateralG: number;
  yawRate: number;
  driveline: {
    rpm: number;
    gear: number;
    throttle: number;
    transferCase: DrivetrainState['transferCase'];
    frontLocked: boolean;
    rearLocked: boolean;
    outputTorque: number;
    drivenCarrierRpm: number;
    differentialReactionTorque: number;
  };
  water: {
    submerged: number;
    buoyancyForce: { x: number; y: number; z: number };
    buoyancyPoint: { x: number; y: number; z: number };
    dragForce: { x: number; y: number; z: number };
    dragPoint: { x: number; y: number; z: number };
    dragTorque: { x: number; y: number; z: number };
  };
  axles: [{
    iterationResidual: number;
    tubeContact: boolean;
    housingContact: boolean;
    /** Axle heave velocity relative to the chassis (m/s). */
    rideVelocity: number;
    /** Axle articulation velocity relative to the chassis (rad/s). */
    rollVelocity: number;
    /** Paired wheel-end additions returned by the anti-roll solver (N). */
    antiRollLeftForce: number;
    antiRollRightForce: number;
  }, {
    iterationResidual: number;
    tubeContact: boolean;
    housingContact: boolean;
    rideVelocity: number;
    rollVelocity: number;
    antiRollLeftForce: number;
    antiRollRightForce: number;
  }];
  wheels: [WheelDebugTelemetry, WheelDebugTelemetry, WheelDebugTelemetry, WheelDebugTelemetry];
}

export interface VehicleLike {
  readonly id: string;
  readonly build: VehicleBuild;
  readonly body: RAPIER.RigidBody;
  setInput(input: PlayerInput): void;
  queueExternalPointLoad(load: ExternalPointLoad): void;
  resetTo(spawn: VehicleSpawn): void;
  preStep(): void;
  postStep(): void;
  getState(): VehicleState;
  dispose(): void;
  /** Axle DOF state (rideY/rollAngle) for owner rendering and upload. */
  axleSnaps?(): [AxleSnap, AxleSnap];
  applyAxleSnaps?(snaps: [AxleSnap, AxleSnap]): void;
  waterStatus?(): WaterStatus;
  pressureStatus?(): PressureStatus;
  debugTelemetry?(): VehicleDebugTelemetry;
  repair?(): void;
  damageStatus?(): VehicleDamageState;
  drivetrainStatus?(): DrivetrainState;
  /** Last rejected transfer-case action for a brief owner HUD notice. */
  consumeDrivetrainNotice?(): string | null;
}
