// Shared vehicle interface that SolidAxleVehicle satisfies.
// World.spawnVehicle returns this; consumers (Room, Prediction) program
// against it instead of the concrete class.

import type RAPIER from '@dimforge/rapier3d-compat';
import type { PlayerInput, VehicleState } from '../types.js';
import type { AxleSnap } from './axle.js';

export interface VehicleSpawn {
  position: { x: number; y: number; z: number };
  yaw?: number;
}

export interface WheelSample {
  x: number;
  z: number;
  contact: boolean;
  slip: number;
}

export interface VehicleLike {
  readonly id: string;
  readonly body: RAPIER.RigidBody;
  setInput(input: PlayerInput): void;
  resetTo(spawn: VehicleSpawn): void;
  preStep(): void;
  postStep(): void;
  getState(): VehicleState;
  wheelSamples(): WheelSample[];
  dispose(): void;
  /** Axle DOF state (rideY/rollAngle). The prediction sim snaps these to
   *  the server's values on each snapshot because they're terrain-contact
   *  driven: small, drifty, and invisible when corrected. */
  axleSnaps?(): [AxleSnap, AxleSnap];
  applyAxleSnaps?(snaps: [AxleSnap, AxleSnap]): void;
}
