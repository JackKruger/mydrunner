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
  wheelRadius: 0.46,
  wheelWidth: 0.32,
  // Suspension geometry. Chassis-connection points (wp.y) sit at the
  // chassis bottom edge; wheels hang below at restLength. Lifted ride
  // height + chunky tyres for that off-road look: chassis-bottom rests
  // roughly (restLength + wheelRadius - chassisHalfY) ~= 0.55m above
  // ground at equilibrium, more than a stock SUV.
  suspensionRestLength: 0.55,
  suspensionStiffness: 35,
  suspensionDamping: 4.5,
  suspensionCompression: 0.83,
  maxSuspensionForce: 9000,
  maxSuspensionTravel: 0.3,
  wheelPositions: [
    { x: -0.92, y: -0.45, z: 1.3 },  // FL (chassis-connection: bottom edge)
    { x: 0.92, y: -0.45, z: 1.3 },   // FR
    { x: -0.92, y: -0.45, z: -1.3 }, // RL
    { x: 0.92, y: -0.45, z: -1.3 },  // RR
  ],
  // AWD torque split front:rear. 0.5/0.5 for symmetric 4x4 feel.
  engineForce: 3200,
  driveSplit: { front: 0.5, rear: 0.5 },
  brakeForce: 2500,
  maxSteer: 0.42,
  steerSpeed: 2.2,
  // Wheel friction multipliers - front slightly less grippy than rear so
  // the car understeers (slides front-end-out) instead of pivoting hard
  // enough to flip on most turns. Rollover is still possible if you take
  // a slope at speed or hit a rut sideways - which is the point.
  frontGripMult: 0.9,
  rearGripMult: 1.0,
} as const;

// Tire slip model. Real tires have a Pacejka-style "magic formula"
// grip-vs-slip curve: grip rises with slip up to ~10-20% slip, then
// falls off as the tire breaks loose. We approximate it cheaply: peak
// grip at SLIP_PEAK, falls off either side. Force scales the chassis
// throttle output by this curve so wheel-spin actually loses traction
// (you'll spin out from a hard launch on mud, then have to back off).
export const TIRE = {
  // Slip ratio at peak grip. Beyond this the tire is sliding.
  slipPeak: 0.12,
  // Sharpness of the falloff after peak (higher = more sudden loss).
  slipFalloff: 4.0,
  // Minimum grip retained after the tire is fully sliding (so you can
  // still recover from a slide instead of losing all traction).
  slipFloor: 0.45,
} as const;

// Engine + gearbox. Torque curve peaks in the 3000-4500 RPM band. Off
// the band the engine produces less torque regardless of throttle.
// Auto-gearbox shifts on RPM thresholds.
export const ENGINE = {
  idleRpm: 850,
  redlineRpm: 5800,
  peakTorqueRpm: 3500,
  // Off-roader peak torque - bumped from 320 so the truck has enough
  // grunt to climb the hills around the road. Matches what a real ~3L
  // SUV diesel would put down.
  peakTorqueNm: 480,
  finalDrive: 4.1,
  gears: [-3.6, 0, 4.0, 2.3, 1.5, 1.05, 0.82],
  reverseGear: 0,
  neutralGear: 1,
  firstGear: 2,
  shiftUpRpm: 4600,
  shiftDownRpm: 1700,
  engineBrakeCoef: 0.04,
  rpmLimiterFalloff: 800,
} as const;

// Mud / surface friction. Multipliers in [0, 1] applied on top of
// TIRE_BASE_GRIP. Higher = more grip. Spread is intentionally wide so
// the player feels the surface change clearly when leaving the road.
//   road    1.00 - tarmac, planted
//   dirt    0.78 - off-road but driveable, mild slip
//   mud     0.32 - clearly slippy, throttle wants to overrun grip
//   deepMud 0.15 - bog: barely makes progress, very easy to spin
//   grass   0.68 - softer than dirt, slick when wet
//   gravel  0.62 - loose stones; less grip than dirt, similar to wet grass
export const SURFACE_FRICTION = {
  road: 1.0,
  dirt: 0.78,
  mud: 0.32,
  deepMud: 0.15,
  grass: 0.68,
  gravel: 0.62,
} as const;

// Base Rapier wheel friction-slip before surface / axle / slip-curve
// modifiers. Higher = more grip overall. 2.8 keeps the road feeling
// planted while leaving headroom for surfaceMult to bite hard on mud.
export const TIRE_BASE_GRIP = 2.8;

// Hill-climb traction assist. Real 4x4s lose grip on slopes because
// gravity peels the tyre's contact away; in our model it manifests as
// chronic spin-out partway up. Boost per-wheel grip linearly with the
// chassis "nose up" component (forward.y, =sin(pitch)). At flat ground
// the multiplier is 1; at forward.y=0.5 (~30 degree climb) it's
// (1 + INCLINE_ASSIST_MAX). Negative pitch (nose down, descending)
// gets no boost - going downhill grip isn't the problem. Tuned to make
// a properly-driven 4x4 climb the rocky-hill route to the summit.
export const INCLINE_ASSIST_MAX = 1.1;

// Chase camera. Lives shared-side because the constants describe the
// game's feel, not anything client-internal. The chase yaw uses an
// under-damped spring (overshoots a touch through corners) plus a
// lateral push proportional to yaw velocity so the camera swings to
// the outside of the turn instead of locking rigidly behind the car.
export const CAMERA = {
  chaseYawStiffness: 14,    // rad/s^2 per rad of error - higher = tracks faster
  chaseYawDamping: 2.8,     // critical at 2*sqrt(stiffness) ~7.48; well below that for visible swing
  chaseSwingLateral: 0.75,  // metres of side offset per rad/s of camera yaw rate
  chaseSwingMax: 2.2,       // clamp on lateral swing offset (m)
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
// Disabled for now: at the current world size (200m) / heightfield
// resolution (64), each rut cell is ~3.17m across - much wider than a
// tire - so wheel passes sink large patches instead of carving tracks.
// Also causes prediction divergence (the client's prediction world
// never receives rut deltas), producing periodic rubberbanding on mud.
// Re-enable once terrain resolution bumps or a sub-cell rut overlay
// (visuals decoupled from the collider) lands.
export const RUTS_ENABLED = false;
