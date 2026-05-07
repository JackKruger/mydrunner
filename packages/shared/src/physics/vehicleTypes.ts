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
  setSteerAngle(angle: number): void;
  resetTo(spawn: VehicleSpawn): void;
  preStep(): void;
  postStep(): void;
  getState(): VehicleState;
  wheelSamples(): WheelSample[];
  dispose(): void;
  /** Solid-axle vehicles expose axle state for prediction
   *  reconcile. */
  axleSnaps?(): [AxleSnap, AxleSnap];
  applyAxleSnaps?(snaps: [AxleSnap, AxleSnap]): void;
  /** Snap the per-wheel angular velocities so reconcile replay starts
   *  from the server's wheel spin state (not the prediction's diverged
   *  value). Critical for tire force determinism during replay. */
  applyWheelAngVels?(angVels: number[]): void;
  /** Snap engine RPM and gear so replay torque output matches the server. */
  applyEngineSnap?(rpm: number, signedGear: number): void;
  /** Suppress the auto-shift state machine while reconcile replay is in
   *  flight. The auto-shift logic reads RPM + speed and would otherwise
   *  overwrite the snapped gear within a tick. Caller flips this to true
   *  before the replay loop, false after. */
  setReplaying?(replaying: boolean): void;
}
