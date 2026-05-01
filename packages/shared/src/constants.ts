// Tick rates and timing - all simulation runs at fixed step.
// FIXED_DT must be identical on client (prediction) and server (authoritative).
export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 30;
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_RATE;

// World
export const GRAVITY_Y = -9.81;

// Vehicle (tunable - feel comes from here). Tuned for a 4x4 SUV / off-road
// car: AWD, smaller than a truck, peppy enough to be fun on dirt.
export const VEHICLE = {
  mass: 1500,
  chassisHalfExtents: { x: 0.85, y: 0.45, z: 1.9 }, // ~1.7m wide, 3.8m long
  wheelRadius: 0.36,
  wheelWidth: 0.25,
  suspensionRestLength: 0.45,
  suspensionStiffness: 32,
  suspensionDamping: 4.5,
  suspensionCompression: 0.85,
  maxSuspensionForce: 6000,
  maxSuspensionTravel: 0.4,
  // Wheel positions relative to chassis center. Track widened slightly
  // for stability; wheels sit further below the chassis to lower the
  // effective CoM.
  wheelPositions: [
    { x: -0.92, y: -0.4, z: 1.3 },  // FL
    { x: 0.92, y: -0.4, z: 1.3 },   // FR
    { x: -0.92, y: -0.4, z: -1.3 }, // RL
    { x: 0.92, y: -0.4, z: -1.3 },  // RR
  ],
  // AWD torque split front:rear. 0.5/0.5 for symmetric 4x4 feel.
  engineForce: 3200,
  driveSplit: { front: 0.5, rear: 0.5 },
  brakeForce: 2500,
  // Slightly less aggressive steering: harder to flip at speed, still
  // tight enough to navigate. Steer ramp-time also slowed.
  maxSteer: 0.42,
  steerSpeed: 2.2,
  // Wheel friction multipliers - front slightly less grippy than rear so
  // the car understeers (slides front-end-out) instead of pivoting hard
  // enough to flip on most turns. Rollover is still possible if you take
  // a slope at speed or hit a rut sideways - which is the point.
  frontGripMult: 0.9,
  rearGripMult: 1.0,
} as const;

// Engine + gearbox. Torque curve modeled as a piecewise cubic that peaks
// in the 3000-4500 RPM band. Off the band the engine produces less force
// regardless of throttle - lugging in 5th at low RPM crawls; revving in
// 1st screams toward redline. Auto-gearbox shifts on RPM thresholds.
export const ENGINE = {
  idleRpm: 850,
  redlineRpm: 5800,
  peakTorqueRpm: 3500,
  peakTorqueNm: 320,
  // Final drive ratio (differential) and per-gear ratios.
  finalDrive: 3.7,
  gears: [-3.2, 0, 3.6, 2.1, 1.4, 1.0, 0.78], // [reverse, neutral, 1, 2, 3, 4, 5]
  // Index 0 = reverse, 1 = neutral, 2 = first.
  reverseGear: 0,
  neutralGear: 1,
  firstGear: 2,
  shiftUpRpm: 4600,
  shiftDownRpm: 1700,
  // Engine braking when off throttle: torque opposing motion proportional to
  // (rpm - idle).
  engineBrakeCoef: 0.04,
  // Torque drop above redline (acts as a soft rev limiter).
  rpmLimiterFalloff: 800,
} as const;

// Mud / surface friction. Higher = more grip.
export const SURFACE_FRICTION = {
  road: 1.0,
  dirt: 0.85,
  mud: 0.45,
  deepMud: 0.25,
} as const;

// Networking
export const DEFAULT_PORT = 2567;
export const MAX_INPUT_QUEUE = 64;
export const INTERPOLATION_DELAY_MS = 100;

// Rut formation. Each driven wheel in mud carves the heightmap each tick:
//   delta_y = RUT_RATE * (1 - grip) * |throttle| * wheelInContact
// Capped to RUT_MAX_DEPTH per cell. Heightfield collider is rebuilt every
// RUT_REBUILD_INTERVAL_TICKS to keep physics in sync with visuals.
export const RUT_RATE = 0.0035;        // m per tick at full slip
export const RUT_MAX_DEPTH = 0.6;      // m below original height
export const RUT_REBUILD_INTERVAL_TICKS = 30;
