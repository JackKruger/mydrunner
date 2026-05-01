// Shared vehicle interface that both the legacy raycast Vehicle and the
// new SolidAxleVehicle satisfy. World.spawnVehicle returns this; consumers
// (Room, Prediction) program against it instead of either concrete class
// so the VEHICLE_MODEL flag can swap them at runtime.

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
  setSteerAngle(angle: number): void;
  resetTo(spawn: VehicleSpawn): void;
  preStep(): void;
  postStep(): void;
  getState(): VehicleState;
  wheelSamples(): WheelSample[];
  dispose(): void;
  /** Optional: solid-axle vehicles expose axle state for prediction
   *  reconcile. The legacy raycast Vehicle does not implement this. */
  axleSnaps?(): [AxleSnap, AxleSnap];
  applyAxleSnaps?(snaps: [AxleSnap, AxleSnap]): void;
}
