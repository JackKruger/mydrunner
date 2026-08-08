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

export interface VehicleLike {
  readonly id: string;
  readonly build: VehicleBuild;
  readonly body: RAPIER.RigidBody;
  setInput(input: PlayerInput): void;
  resetTo(spawn: VehicleSpawn): void;
  preStep(): void;
  postStep(): void;
  getState(): VehicleState;
  dispose(): void;
  /** Axle DOF state (rideY/rollAngle) for owner rendering and upload. */
  axleSnaps?(): [AxleSnap, AxleSnap];
  applyAxleSnaps?(snaps: [AxleSnap, AxleSnap]): void;
  waterStatus?(): WaterStatus;
  repair?(): void;
  damageStatus?(): VehicleDamageState;
  drivetrainStatus?(): DrivetrainState;
  /** Last rejected transfer-case action for a brief owner HUD notice. */
  consumeDrivetrainNotice?(): string | null;
}
