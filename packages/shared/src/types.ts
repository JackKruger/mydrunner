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

/** Stable fictional vehicle identity used by builds, persistence and the wire. */
export type VehicleBaseId =
  | 'ridgeback'
  | 'overlander'
  | 'stockman-single'
  | 'stockman-dual'
  | 'longreach'
  | 'outclaw'
  | 'dustback-rs';

/**
 * Compatibility input accepted at old save/editor boundaries. Production
 * selections are the seven VehicleBaseIds above; the four legacy values are
 * immediately migrated by normalizeCarKind/normalizeVehicleBaseId.
 */
export type CarKind = VehicleBaseId | 'patrol' | 'hilux' | 'ute' | 'motorbike';

export const DEFAULT_CAR_KIND: VehicleBaseId = 'ridgeback';

export function normalizeVehicleBaseId(v: unknown): VehicleBaseId {
  switch (v) {
    case 'overlander':
    case 'stockman-single':
    case 'stockman-dual':
    case 'longreach':
    case 'outclaw':
    case 'dustback-rs':
    case 'ridgeback':
      return v;
    // Patrol and both removed novelty vehicles migrate to the Ridgeback.
    case 'patrol':
    case 'ute':
    case 'motorbike':
      return 'ridgeback';
    // The former Hilux becomes the closest work-ute replacement.
    case 'hilux':
      return 'stockman-dual';
    default:
      return 'ridgeback';
  }
}

/** @deprecated Use normalizeVehicleBaseId. Kept for old editor handoffs. */
export function normalizeCarKind(v: unknown): VehicleBaseId {
  return normalizeVehicleBaseId(v);
}

export type PaintFinish = 'gloss' | 'satin' | 'matte';

/** Versioned, complete and entitlement-ready workshop selection. */
export interface VehicleBuild {
  version: 1;
  baseId: VehicleBaseId;
  paintColor: string;
  paintFinish: PaintFinish;
  suspensionId: string;
  axleId: string;
  tireId: string;
  wheelId: string;
  frontBarId: string;
  winchId: string;
  snorkelId: string;
  roofId: string;
  rearBodyId: string;
  frontLocker: boolean;
  rearLocker: boolean;
}

export type TransferCaseMode = '2h' | '4h' | '4l';

export interface DrivetrainState {
  transferCase: TransferCaseMode;
  frontLocked: boolean;
  rearLocked: boolean;
}

export interface VehicleDamageState {
  /** 0 = destroyed, 1 = undamaged. */
  body: number;
  engine: number;
  steering: number;
  /** Cause shown when the engine can no longer run. */
  stoppedCause: 'none' | 'collision' | 'flooding';
}

export const UNDAMAGED_VEHICLE: VehicleDamageState = {
  body: 1,
  engine: 1,
  steering: 1,
  stoppedCause: 'none',
};

export interface PlayerInput {
  // Sequence number - lets the server ack inputs for client reconciliation.
  seq: number;
  // Continuous controls in [-1, 1] / [0, 1].
  throttle: number; // -1 reverse .. 1 forward
  steer: number;    // -1 left .. 1 right
  brake: number;    // 0..1
  handbrake: number; // 0..1
  /** null leaves the automatic gearbox in control. Otherwise this is the
   *  driver's H-pattern selection: reverse, neutral, or first through fifth. */
  manualGear: ManualGear | null;
  /** One-shot direct selection from the on-screen transfer-case stick. */
  transferCase: TransferCaseMode | null;
  /** Hold to air down (-1) or inflate (+1). */
  pressureAdjust: -1 | 0 | 1;
  // Bitfield of misc actions. See BUTTON_* below.
  buttons: number;
}

export type ManualGear = -1 | 0 | 1 | 2 | 3 | 4 | 5;

/** Bits in PlayerInput.buttons.
 *
 *  This was documented as a bitfield from the start but used as a
 *  boolean - input.ts wrote `Math.max(kbReset, touchReset)` and the
 *  simulation tested `& 1` - so the second action needed the field to
 *  actually become one. Named constants rather than literals because a
 *  bare `& 2` at a call site is unreadable and unsearchable. */
export const BUTTON_RESET = 1;
/** Crank the starter. Only catches with the air intake clear of water. */
export const BUTTON_STARTER = 2;
/** Edge-triggered transfer case toggle. */
export const BUTTON_RANGE = 4;
/** Edge-triggered installed rear locker toggle. */
export const BUTTON_REAR_LOCKER = 8;
/** Edge-triggered installed front locker toggle. */
export const BUTTON_FRONT_LOCKER = 16;

export const EMPTY_INPUT: PlayerInput = {
  seq: 0,
  throttle: 0,
  steer: 0,
  brake: 0,
  handbrake: 0,
  manualGear: null,
  transferCase: null,
  pressureAdjust: 0,
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
  drivetrain: DrivetrainState;
  damage: VehicleDamageState;
  // Per-wheel data for visual representation
  wheels: WheelState[];
  /** Solid-axle state, ordered [front, rear]. The visual layout (axle
   *  groups, beam pose) reads these rather than the per-wheel
   *  suspensionLength.
   *
   *  This was optional while the legacy raycast vehicle - which had no axle
   *  DOFs - could still produce a snapshot. That vehicle is gone,
   *  SolidAxleVehicle always fills the field, and the wire always carries
   *  the four slots (packVehicle wrote zeroes when they were missing, so
   *  "absent" decoded as a truck sitting at rideY 0 anyway). Required, so
   *  consumers stop carrying dead `?? rest` fallbacks for a case that
   *  cannot occur. */
  axles: [AxleSnapWire, AxleSnapWire];
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
  /** Angular velocity of the wheel in rad/s. Relayed for remote wheel
   *  animation, audio/particles and collision presentation. */
  angVel: number;
  /** Immediate radial carcass compression in metres. */
  tireDeflection: number;
  /** Contact normal in chassis-local coordinates. */
  tireContactNormal: Vec3;
}

export type WinchMotor = -1 | 0 | 1; // out, hold, in
export type VehicleRecoveryPoint = 'front' | 'rear';

export type WinchTarget =
  | { kind: 'obstacle'; obstacleId: string; anchor: Vec3 }
  | { kind: 'vehicle'; playerId: PlayerId; point: VehicleRecoveryPoint };

export type WinchStatus = 'attached' | 'stalled' | 'overload';

/** Server-authoritative cable relationship broadcast with snapshots. */
export interface WinchLinkSnapshot {
  id: string;
  ownerId: PlayerId;
  target: WinchTarget;
  cableLength: number;
  motor: WinchMotor;
  tension: number;
  status: WinchStatus;
}

/** Owner-authoritative cable mechanics uploaded beside vehicle state. */
export interface WinchRuntimeUpdate {
  linkId: string;
  cableLength: number;
  motor: WinchMotor;
  tension: number;
}

export interface PlayerSnapshot {
  id: PlayerId;
  name: string;
  build: VehicleBuild;
  buildRevision: number;
  workshopMode: boolean;
  vehicle: VehicleState;
  // Newest owner-state sequence the relay has accepted for this player.
  stateSeq: number;
}

/** Canonical vehicle state uploaded by the client that owns the vehicle. */
export interface VehicleStateUpdate {
  seq: number;
  vehicle: VehicleState;
  winch?: WinchRuntimeUpdate;
}

export interface WorldSnapshot {
  // Server tick this snapshot was taken at.
  tick: number;
  // Server time in ms (monotonic).
  serverTimeMs: number;
  players: PlayerSnapshot[];
  winches?: WinchLinkSnapshot[];
}
