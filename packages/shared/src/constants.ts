// Tick rates and timing - all simulation runs at fixed step.
// FIXED_DT must be identical on client (prediction) and server (authoritative).
export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 30;
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_RATE;

// World
export const GRAVITY_Y = -9.81;

// Vehicle (tunable - feel comes from here)
export const VEHICLE = {
  mass: 1500,
  chassisHalfExtents: { x: 1.0, y: 0.4, z: 2.0 },
  wheelRadius: 0.4,
  wheelWidth: 0.3,
  suspensionRestLength: 0.5,
  suspensionStiffness: 35,
  suspensionDamping: 4,
  suspensionCompression: 0.83,
  maxSuspensionForce: 6000,
  maxSuspensionTravel: 0.5,
  // Wheel positions relative to chassis center
  wheelPositions: [
    { x: -0.9, y: -0.2, z: 1.4 },  // FL
    { x: 0.9, y: -0.2, z: 1.4 },   // FR
    { x: -0.9, y: -0.2, z: -1.4 }, // RL
    { x: 0.9, y: -0.2, z: -1.4 },  // RR
  ],
  engineForce: 4000,
  brakeForce: 2500,
  maxSteer: 0.5, // radians
  steerSpeed: 2.5, // rad/s response
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
