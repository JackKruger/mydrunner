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
  // Wheel positions relative to chassis center.
  wheelPositions: [
    { x: -0.78, y: -0.25, z: 1.3 },  // FL
    { x: 0.78, y: -0.25, z: 1.3 },   // FR
    { x: -0.78, y: -0.25, z: -1.3 }, // RL
    { x: 0.78, y: -0.25, z: -1.3 },  // RR
  ],
  // AWD torque split front:rear. 0.5/0.5 for symmetric 4x4 feel.
  engineForce: 4200,
  driveSplit: { front: 0.5, rear: 0.5 },
  brakeForce: 2800,
  maxSteer: 0.55, // radians
  steerSpeed: 3.0, // rad/s response
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
