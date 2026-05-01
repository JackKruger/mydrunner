export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type PlayerId = string;

export interface PlayerInput {
  // Sequence number - lets the server ack inputs for client reconciliation.
  seq: number;
  // Continuous controls in [-1, 1] / [0, 1].
  throttle: number; // -1 reverse .. 1 forward
  steer: number;    // -1 left .. 1 right
  brake: number;    // 0..1
  handbrake: number; // 0..1
  // Bitfield of misc actions (horn, camera, reset, etc.)
  buttons: number;
}

export const EMPTY_INPUT: PlayerInput = {
  seq: 0,
  throttle: 0,
  steer: 0,
  brake: 0,
  handbrake: 0,
  buttons: 0,
};

export interface VehicleState {
  position: Vec3;
  rotation: Quat;
  linVel: Vec3;
  angVel: Vec3;
  // Drivetrain telemetry. rpm + gear drive the tachometer HUD and (later)
  // engine sound; throttle is mirrored back so spectators can see whether
  // a remote player has the pedal down.
  rpm: number;
  gear: number; // signed: -1 reverse, 0 neutral, 1..5 forward
  throttle: number;
  // Per-wheel data for visual representation
  wheels: WheelState[];
}

export interface WheelState {
  steer: number;
  spin: number; // accumulated wheel rotation (radians)
  contact: boolean;
  suspensionLength: number;
}

export interface PlayerSnapshot {
  id: PlayerId;
  name: string;
  vehicle: VehicleState;
  // Last input seq the server has consumed for this player.
  lastAckSeq: number;
}

export interface WorldSnapshot {
  // Server tick this snapshot was taken at.
  tick: number;
  // Server time in ms (monotonic).
  serverTimeMs: number;
  players: PlayerSnapshot[];
}
