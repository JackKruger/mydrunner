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

/** Vehicle visual variant. Physics is identical across kinds (chassis
 *  extents, mass, drivetrain are shared) - this only switches the mesh
 *  rendered for the player. Add a kind by extending the union here, the
 *  hello/snapshot wire, the server normaliser, and the client mesh
 *  registry in carMesh/. */
export type CarKind = 'patrol' | 'hilux' | 'ute' | 'motorbike';

export const DEFAULT_CAR_KIND: CarKind = 'patrol';

export function normalizeCarKind(v: unknown): CarKind {
  if (v === 'hilux' || v === 'ute' || v === 'motorbike') return v;
  return 'patrol';
}

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
  /** Solid-axle state, ordered [front, rear]. Optional so the legacy
   *  raycast vehicle (which has no axle DOFs) can still produce snapshots
   *  this type accepts, and so old clients can ignore the field on
   *  receive without crashing. The new visual layout (axle groups, beam
   *  pose) reads these instead of the per-wheel suspensionLength. */
  axles?: [AxleSnapWire, AxleSnapWire];
}

/** Wire shape of an axle's two DOFs. Matches Physics.AxleSnap from the
 *  shared package; duplicated here so types.ts stays free of physics
 *  imports. */
export interface AxleSnapWire {
  rideY: number;
  rollAngle: number;
}

export interface WheelState {
  steer: number;
  spin: number; // accumulated wheel rotation (radians)
  contact: boolean;
  suspensionLength: number;
  /** Angular velocity of the wheel in rad/s. Sent in snapshots so the
   *  prediction can snap wheel spin rates during reconcile; without this
   *  the tire-force integrator starts from the wrong angVel and diverges
   *  over the replay window, producing the large reconcile pops. */
  angVel: number;
}

export interface PlayerSnapshot {
  id: PlayerId;
  name: string;
  carKind: CarKind;
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
