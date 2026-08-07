// Shared vehicle interface that SolidAxleVehicle satisfies.
// World.spawnVehicle returns this; LocalSimulation and tests program
// against it instead of the concrete class.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { PlayerInput, VehicleState } from '../types.js';
import type { AxleSnap } from './axle.js';

export interface VehicleSpawn {
  position: { x: number; y: number; z: number };
  yaw?: number;
}

export interface VehicleLike {
  readonly id: string;
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
}
