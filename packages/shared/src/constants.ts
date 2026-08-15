// Protocol / build compatibility.
//
// The client and the server deploy on independent triggers (GitHub Pages
// and Railway respectively), and BOTH of them generate the world and the
// vehicle locally from the seed the server hands out - using their own
// compiled-in copy of terrain.ts, obstacles.ts, vehicleGeom.ts and this
// file. So a client running a different commit than the server builds a
// DIFFERENT heightmap and a DIFFERENT truck from the same seed. Nothing
// errors; the soft corrections just fight the local sim forever, which
// the player experiences as "the game feels broken today".
//
// This version is the guard: it rides on `hello` and `welcome`, and a
// mismatch refuses the join with a reason the player can act on. Bump it
// whenever a change would make two builds disagree - the wire tuple
// layout, terrain or obstacle generation, vehicle geometry, or any
// shared wire or map rule.
// 2: dropped the `rut` message and TerrainHandshake.rutVersion.
// 3: welcome carries a MapHandshake { id, rev } instead of the seed
//    triple. The world is a map document now, and its seed/size/
//    resolution live in the document both sides compile in.
// 4: clients own vehicle physics and upload canonical VehicleState; the
//    server relays it instead of simulating and correcting player bodies.
// 6: the object catalog gained ~40 kinds. Obstacle colliders are built
//    independently by every owner client, so two builds that disagree
//    about the catalog disagree about what the world is solid at.
// 7: authored water. MapDoc gains a water block (MAP_FORMAT_VERSION 2),
//    TerrainData gains the level and flow grids, and the vehicle model
//    gains buoyancy, drag, current and drowning. Two builds either side
//    of this disagree about both the map's geometry and how a truck
//    behaves in it.
// 8: complete VehicleBuild identities, drivetrain/damage telemetry and
//    acknowledged workshop leasing/build messages.
// 9: drivetrain telemetry carries the transfer-case position (2H/4H/4L)
//    in place of the old high/low-only flag.
// 10: authoritative winch links and owner-uploaded winch runtime.
// 11: Outclaw vehicle identity and geometry. Mixed builds would disagree on
//     its chassis, axle track and suspension tune.
// 12: workshop builds add selectable axle widths plus wider 37/40-inch
//     tyre packages, changing both the build tuple and vehicle geometry.
// 14: wheel snapshots add carcass deflection and a chassis-local contact
//     normal; schema-5 clients would otherwise misread the 63-value tuple.
// 15: sparse session-rut stamps, authoritative batches, and chunked tile sync.
// 16: combined-slip tyre curves, physical differentials, adjustable tyre
//     pressure and soft-ground sinkage. No wire layout change, but two
//     builds either side of it disagree about how a truck behaves, which
//     is exactly what this guard exists to stop.
// 17: obstacle contact and driveline limits, plus the RPM/reverse drivetrain
//     fixes that landed alongside them. No wire layout change, but a truck
//     either side of this behaves differently against logs, rocks and kerbs:
//     the ledge drive direction is projected into the wheel's own plane, the
//     discrete contact witness is reconstructed rather than taken raw, a wheel
//     on flat ground can now see an obstacle it is pressed against, the ledge
//     normal constraints share a vehicle-wide per-tick bound, and the locked
//     centre transfer can no longer spin a gripping wheel backwards.
// 18: station colliders follow the composed terrain height and the four
//     workshop-front posts are gone. Mixed builds would disagree about the
//     station floor and whether the garage approaches are obstructed.
export const PROTOCOL_VERSION = 18;

// Tick rates and timing - all simulation runs at fixed step.
// The client-owned vehicle simulation advances at this fixed cadence.
export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
export const SNAPSHOT_RATE = 30;
export const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_RATE;

// World
export const GRAVITY_Y = -9.81;

// Vehicle (tunable - feel comes from here). Tuned for a 4x4 SUV / off-road
// car: AWD, smaller than a truck, peppy enough to be fun on dirt.
export const VEHICLE = {
  // Reverted 2500 → 1500. Mass had been bumped to 2500 without
  // rebalancing the rest of the tuning: the suspension damping
  // comment block below derives c=11000 from m=1500 (target ζ≈0.70),
  // so at m=2500 the truck was running ζ≈0.53 (under-damped, wallowy).
  // Brake force, anti-roll, and engine torque headroom were all
  // sized for the lighter mass too. With m=1500 every other tuned
  // value lines up with the comments that explain it.
  mass: 1500,
  chassisHalfExtents: { x: 0.85, y: 0.45, z: 1.9 }, // ~1.7m wide, 3.8m long
  // Rounded edge radius on the chassis collider so bumpers slide off obstacles
  // instead of catching square.  Inner box shrinks by this amount so total
  // extent stays the same.
  chassisColliderRadius: 0.15,
  // Visual roof top relative to the body origin (used to size the collider so
  // the roof doesn't clip the ground when the car is upside-down).
  cabinRoofY: 1.2,
  wheelRadius: 0.46,
  wheelWidth: 0.42,
  // Suspension geometry, spring rates, and wheel positions live in AXLE
  // below (the solid-axle model's per-axle source of truth); the legacy
  // raycast-vehicle fields that used to sit here were deleted with it.
  // AWD torque split front:rear. 0.5/0.5 for symmetric 4x4 feel.
  driveSplit: { front: 0.5, rear: 0.5 },
  brakeForce: 4500,
  // The handbrake is a mechanical lock, not a weaker copy of the foot brake,
  // so it needs its own force above the rear tyre's grip. It reused
  // brakeForce for a long time, and 4500 N is less than half of what a rear
  // tyre can hold: measured peak rear gripLimit across all seven bases is
  // 9826 N (overlander, road, mid-corner load transfer), 5482 N for the
  // lightest (dustback-rs), and ~1200 N in mud. The clamp therefore always
  // bound on brake force rather than grip, and the wheel settled into a
  // perfect-ABS equilibrium at ~8% slip instead of locking. Sized above the
  // measured peak with headroom for pressure and grip multipliers, so the
  // binding constraint becomes the tyre's own sliding tail — which is what
  // makes the rear step out. Raising it further buys nothing: past the grip
  // cap the tyre, not the cable, is the limit.
  handbrakeForce: 12_000,
  maxSteer: 0.72,
  // Owner physics now runs locally, so input already reaches the steering
  // model without the old server round trip. Keep enough travel time for
  // keyboard steering to read as a wheel being turned rather than a snap.
  steerSpeed: 2.2,
  // Keyboard steer is binary, so full input must mean "the strongest
  // sensible turn at this speed", not full mechanical steering lock. The
  // dynamic limit in solidAxleVehicle.ts converts this lateral-acceleration
  // budget into a road-wheel angle using the bicycle model. Full lock is
  // still available at trail speed; at road/rally speed this prevents a
  // brief key press from asking the tyres for an instant rollover turn.
  maxSteerLateralAccel: 6.5,
  // Wheel friction multipliers - front slightly less grippy than rear so
  // the car understeers (slides front-end-out) instead of pivoting hard
  // enough to flip on most turns. Rollover is still possible if you take
  // a slope at speed or hit a rut sideways - which is the point.
  frontGripMult: 1.0,
  rearGripMult: 1.0,
} as const;

/** Recovery-winch tuning. Forces are deliberately softer than a rigid
 * constraint so the 60 Hz owner simulation remains stable under latency. */
export const WINCH = {
  maxAttachDistance: 30,
  maxCableLength: 35,
  minCableLength: 1.5,
  attachSlack: 0.2,
  stiffness: 90_000,
  damping: 18_000,
  ratedPull: 55_000,
  breakForce: 85_000,
  breakDelay: 0.2,
  overloadRecoveryRate: 2,
  reelInSpeed: 0.75,
  reelOutSpeed: 1.25,
  separationGrace: 2,
  maxIncomingLinks: 2,
} as const;

// Engine + gearbox. Torque curve peaks in the 3000-4500 RPM band. Off
// the band the engine produces less torque regardless of throttle.
// Auto-gearbox shifts on RPM thresholds.
export const ENGINE = {
  idleRpm: 850,
  redlineRpm: 5800,
  peakTorqueRpm: 3500,
  // Real crankshaft torque; the gearbox, final drive and tyre radius now
  // produce tractive force without a hidden mass-property scale.
  peakTorqueNm: 290,
  finalDrive: 4.1,
  // Reverse ratio bumped back to -2.5 (from -1.8). The softer -1.8
  // gave a high theoretical reverse top end but anaemic acceleration
  // (~1.65 m/s² peak; only ~5 m/s after 10 s of full reverse from
  // a stop). -2.5 gives ~39% more wheel torque so reverse pulls away
  // from a stop briskly, while the redline-limited top end is still
  // ~27 m/s — far higher than the player ever actually reaches in
  // practice when reversing.
  // Top-gear ratio kept at 0.60 (was 0.72) so the engine still has
  // headroom in 5th and the truck cruises faster on road.
  gears: [-2.5, 0, 4.0, 2.3, 1.5, 1.05, 0.60],
  reverseGear: 0,
  neutralGear: 1,
  firstGear: 2,
  // Upshift near peak-torque RPM (3500) instead of close to redline (4600).
  // The heavy chassis can't actually reach the chassis-speed equivalent of
  // 4600 RPM in 2nd gear, so the box was getting stuck there. Shifting at
  // peak-torque keeps the engine in its sweet spot and lets the box walk
  // up through 3rd/4th/5th on the road.
  shiftUpRpm: 3500,
  shiftDownRpm: 1700,
  engineBrakeCoef: 0.25,
  rpmLimiterFalloff: 800,
  // Minimum ticks between automatic RPM-triggered shifts (~1.5 s at 60 Hz).
  // Prevents hunting when vehicle speed oscillates near a shift threshold.
  shiftHoldTicks: 90,
  // Chassis-speed component of engine braking. The RPM-based component
  // (engineBrakeCoef) models compression braking through the locked
  // drivetrain, but in high gears (low ratio) chassis speed maps to a
  // low engine RPM even at a fast cruise — so a steep downhill coast in
  // overdrive barely raises RPM and the truck runs away. This term adds
  // a brake force proportional to |vehicleAngVel| (chassis speed /
  // wheelRadius) so faster coasting = more drag regardless of gear.
  // Only applies off-throttle and in-gear (see engine.ts).
  engineBrakeSpeedCoef: 6.0,
} as const;

/** Transfer-case low-range bounds. Low range is a crawl mode: its geared
 * wheel-speed limit controls sustained slip, while these chassis limits catch
 * one-tick obstacle impulses after the rigid-body solve. */
export const LOW_RANGE = {
  maxCrawlSpeed: 1.1,
  maxLedgeVerticalSpeed: 0.75,
  ledgeVelocityGraceTicks: 45,
} as const;

// Mud / surface friction. Multipliers in [0, 1] applied on top of
// TIRE_LONG_FRICTION in the friction circle (see solidAxleVehicle.ts).
// Higher = more grip. Spread is intentionally wide so the player feels
// the surface change clearly when leaving the road.
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
  concrete: 1.05, // tarmac/concrete pad - the most planted surface
} as const;

// Per-axle geometry + spring rates for the solid-axle vehicle model
// (see physics/solidAxleVehicle.ts). Each axle is a software state with
// its own ride spring (vertical compression) and roll spring (rotation
// of the beam about the chassis-forward axis - the articulation that
// makes solid-axle rock-crawlers look twisted over a rock).
//
// rideStiffness scales the chassis-restoring force per metre of average
// wheel compression; rollStiffness is intentionally an order of
// magnitude softer so the axle articulates freely until it hits its
// mechanical stop at maxArticulation, at which point the surplus torque
// dumps into the chassis (the body leans over).
export const AXLE = {
  front: {
    centerLocalY: -0.45,
    centerLocalZ: 1.3,
    trackHalf: 0.92,
    suspensionRestLength: 0.55,
    droopMax: 0.30,
    bumpMax: 0.20,
    rideStiffness: 80_000,
    // c_critical for vertical bounce = 2*sqrt(k_total*m)
    // ~ 2*sqrt(170000*1500) ~ 31900 N/s/m total; per axle ~15950.
    // Target ζ ≈ 0.70 (slightly underdamped): c = 0.70 * 15950 ≈ 11150.
    // Previous value of 28k gave ζ ≈ 1.6× (overdamped) — chassis barely
    // moved and never visibly pitched/bounced on terrain.
    rideDamping: 11_000,
    rollStiffness: 35_000,
    rollDamping: 1_800,
    maxArticulation: 0.45,
    axleMass: 110,
    axleRollInertia: 24,
    hasDrive: true,
    hasSteering: true,
    diffLocked: false,
    probe: {
      friction: 0.08,
      tubeRadius: 0.07,
      tubeHalfLength: 0.36,
      housingHalfExtents: { x: 0.20, y: 0.15, z: 0.16 },
      verticalOffset: 0,
      portal: false,
    },
  },
  rear: {
    centerLocalY: -0.45,
    centerLocalZ: -1.3,
    trackHalf: 0.92,
    suspensionRestLength: 0.55,
    droopMax: 0.32,
    bumpMax: 0.20,
    rideStiffness: 90_000,
    // c_crit_rear ≈ 2*sqrt(90000*750) ≈ 16432 N·s/m. Target ζ ≈ 0.70:
    // c = 0.70 * 16432 ≈ 11500. Match front ratio so both ends settle
    // at the same rate — mismatched damping excites sustained pitch
    // oscillation (wheel tread lugs appear to spin while stationary).
    rideDamping: 11_000,
    rollStiffness: 28_000,
    rollDamping: 1_500,
    maxArticulation: 0.50,
    axleMass: 130,
    axleRollInertia: 28,
    hasDrive: true,
    hasSteering: false,
    diffLocked: false,
    probe: {
      friction: 0.08,
      tubeRadius: 0.07,
      tubeHalfLength: 0.36,
      housingHalfExtents: { x: 0.20, y: 0.15, z: 0.16 },
      verticalOffset: 0,
      portal: false,
    },
  },
} as const;

// Lateral tyre-grip parameters used by the solid-axle model. The base
// lateral force is linear in lateral slip SPEED (N per m/s) — that gives
// responsive turn-in but never lets grip fall off, so the tail never
// comes out. The slip-angle curve below (peak/falloff/floor) shapes that
// force: full cornering stiffness up to slipAnglePeak, then exponential
// decay toward slipAngleFloor. Past the peak the tyre is sliding and the
// reduced lateral force is what makes under/oversteer readable and lets
// "drifting in mud" be a thing. The friction-circle clamp (in
// solidAxleVehicle.ts) still couples long+lat, so power-oversteer
// (throttle stealing lateral grip) works on top of this curve.
export const TIRE_LATERAL = {
  stiffness: 14_000,
  longRatio: 0.95,
  // A rolling tyre has static lateral grip even when its contact patch is
  // not yet moving. The dynamic stiffness term alone produces zero force at
  // zero speed, so gravity on a cross-slope creates a small permanent creep.
  // Use a constraint-like correction at walking-pace chassis speeds, then
  // blend it away before normal cornering so the approved slip-angle handling
  // remains unchanged.
  staticHoldSpeed: 0.10,
  staticReleaseSpeed: 0.50,
  // Slip angle (rad) at which lateral grip peaks. ~8 deg. Below this the
  // tyre is in its linear cornering region (full stiffness); past it the
  // grip decays. Real tyres peak ~6-10 deg.
  slipAnglePeak: 0.14,
  // Sharpness of the falloff past peak (higher = more sudden breakaway).
  slipAngleFalloff: 5.0,
  // Minimum lateral grip retained once fully sliding — keeps a sliding
  // tyre recoverable instead of zero-grip (you can counter-steer out).
  slipAngleFloor: 0.35,
  // Combined slip: how much cornering force survives LONGITUDINAL sliding.
  // The pair above shapes lateral force against slip *angle*; these two do
  // it against slip *ratio*, which nothing used to read at all. A locked
  // wheel kept ~50% of its lateral force (measured 3192 N of a 6000 N
  // budget at slip ratio -0.94), so the rear could never step out under the
  // handbrake. Floor is lower than slipAngleFloor because a wheel sliding
  // along its rolling direction has far less tread displacement left for
  // cornering than one merely running at a big slip angle — but non-zero
  // for the same reason: a locked tyre stays recoverable.
  combinedSlipFloor: 0.15,
  // Sharpness of that decay across [peakSlip, 1]. Higher breaks away sooner
  // after the wheel passes its peak-slip knee.
  combinedSlipFalloff: 3.5,
  // Velocity floor (m/s) for the slip-angle denominator. Below this the
  // angle is computed against a fixed reference rather than the actual
  // (tiny) forward speed, so low-speed manoeuvres don't register as full
  // slip and kill slow-speed steering. Mirrors tire.ts SLIP_VEL_FLOOR.
  // The live vehicle also reaches full dynamic lateral stiffness at this
  // speed; below it a bounded ramp prevents 60 Hz left/right force chatter.
  slipAngleVelFloor: 2.5,
} as const;

// Effective longitudinal friction coefficient for the solid-axle model.
// With per-wheel normal load ~3700N (1500kg / 4 wheels), this gives
// ~3700N of grip per wheel on road - around 1g of acceleration across
// all four wheels. Surface multiplier scales below this. 1.15 gives a
// touch more bite at low speed so launching off the line + tight
// cornering both feel less greasy.
export const TIRE_LONG_FRICTION = 1.15;

// Wheel spin physics for the solid-axle model. inertia governs how fast
// a wheel spins up under torque (kg*m^2 of a tyre + rim + brake disc).
// rollingResistance is a viscous drag torque (N*m per rad/s of wheel
// speed) that bleeds spin when the throttle is off, so the truck doesn't
// coast forever. The rollingMult* factors scale it on soft surfaces -
// mud drags far more than hardpack. Friction capacity always uses the
// actual positive contact load, so an unloaded tyre cannot make traction.
//
// rollingResistance was 0.010, which at a 10 m/s cruise is ~0.2 N*m
// against per-wheel drive torques in the thousands - so it did nothing
// and the rollingMult* factors scaled nothing. Coasting off-throttle
// from 10 m/s for 3 s, road / mud / deep mud all landed within 0.03 m/s
// of each other. At 1.2 the same test gives 7.13 / 6.51 / 5.50 m/s: road
// feel is essentially unchanged (7.34 before) while a bog now visibly
// drags the truck down. Calibrated against
// shared/__tests__/rollingResistance.test.ts; the binding constraint on
// raising it further is braking.test.ts / handbrake.test.ts, which
// require the brakes to beat coasting by a clear margin.
export const WHEEL = {
  inertia: 1.6,
  rollingResistance: 1.2,
  rollingMultMud: 4.0,
  rollingMultDeepMud: 18.0,
} as const;

// Suspension raycast / damping shape shared by every axle end.
// rayLift: wheel-end rays start this far above the attachment so they
// don't begin inside the terrain when the chassis is belly-out or a
// wheel is deep in a rut.
// dampingEngageComp: compression (m) over which the damper ramps from
// 0 to full. A wheel just kissing ground stays soft; typical equilibrium
// compression (~87 mm) is already at full damping - see the body-bob
// analysis in solidAxleVehicle.ts.
export const SUSPENSION = {
  rayLift: 0.5,
  dampingEngageComp: 0.05,
  // A cylinder cast on a triangle seam can precede the centre ray by tiny
  // floating-point noise even on flat ground. Only prefer volume support when
  // it finds meaningfully higher terrain under the tread.
  volumeSupportMinAdvance: 0.005,
  // Heightfields are continuous ground even when an authored cell is very
  // steep. Reject only effectively vertical faces; those remain ledge contacts.
  terrainSupportMinNormalY: 0.05,
  // Support is solved before Rapier integrates the chassis but rendered from
  // the post-integration pose. Sample one horizontal tick ahead so a moving
  // tyre cannot tunnel into the next heightfield triangle in that interval.
  supportLookaheadTicks: 1,
} as const;

// Sharp-edge tyre contacts. Suspension rays remain the source of vertical
// support on ordinary terrain, but a ray has no volume and cannot see a
// kerb/rock face until the axle centre has crossed it. The hybrid wheel
// contact path represents each tyre as a cylinder for steep-face queries,
// then transfers the collision and drive reactions to the chassis.
// Driveline limits that are properties of the mechanism rather than of a
// particular vehicle build.
export const DRIVELINE = {
  // The locked centre transfer equalises the front and rear carrier speeds
  // every tick. That rigidity is correct for a part-time transfer case, but
  // the solve happens after the ground torque and without reference to it, so
  // an unbounded correction can spin a wheel that has grip backwards to make
  // the two carriers meet -- which is a yaw couple, not a drivetrain.
  //
  // Chosen just above the ~1980 N.m of torque a loaded stock tyre can react
  // at the contact patch, so a genuine driveline bind still transmits while a
  // runaway wheel can no longer drag its partners to an arbitrary speed.
  centerTransferMaxReactionNm: 2_200,
} as const;

export const LEDGE_CONTACT = {
  // `contactShape` reports contacts up to this separation so the velocity
  // damper can begin resisting a face before the visual tyre penetrates it.
  prediction: 0.015,
  // Normal velocity is resolved inelastically (no spring energy to rebound
  // from). Each of a usual two-wheel axle contact owns half the sprung mass.
  normalMassFraction: 0.5,
  // ...but that share is per wheel, so a row of obstacles catching all four
  // tyres in one tick would claim twice the sprung mass and manufacture
  // chassis momentum. Cap the vehicle-wide total instead of cutting the
  // per-wheel share: at one or two steep contacts the cap is slack and the
  // tuned single-wheel and single-axle ledge behaviour is untouched, while
  // three or four contacts divide this budget between them.
  normalMassBudget: 1,
  normalCorrectionRate: 5,
  maxNormalCorrectionSpeed: 0.15,
  maxForce: 45_000,
  // ...but that is a cap per contact, and nothing bounded the total. Four
  // wheels each running saturated is ~3000 N.s in a single tick on a 1800 kg
  // truck: 1.67 m/s of delta-v, or a sustained 10 g. The constraint also
  // resolves inelastically against the tick's cached velocity, so it does not
  // ease off as penetration clears — a saturated contact is a constant-force
  // pump, and roughly 34 consecutive saturated ticks is all it takes to reach
  // the 56 m/s vertical ejection measured on the six-log crawl course.
  //
  // Bound what every ledge normal constraint together may add to the chassis
  // in one tick. Gravity contributes 0.16 m/s per tick, so this leaves ample
  // headroom to arrest a real impact over a few ticks while making the
  // runaway arithmetically impossible. Sized in delta-v rather than force so
  // it means the same thing on every vehicle mass.
  maxNormalDeltaVPerTick: 0.35,
  // Tangential ledge drive is a compliant tread reaction, not a winch. A
  // separate cap prevents a high-grip prepared tyre from converting its
  // entire axle load into a one-tick upward launch at a square corner.
  maxDriveForce: 8_000,
  // A deformable off-road tread can hook a sharp corner more strongly than
  // rigid face friction alone. This multiplier is ledge-only.
  tractionMultiplier: 1.5,
  // A downward probe just beyond the face accepts a top transition only
  // when an actual upper surface is within this hub-rise. Tall walls do not
  // become driveable simply because the tyre touches them.
  maxClimbHeight: 0.9,
  // Aim slightly beyond the top edge so the drive reaction has a forward
  // component and carries the hub onto the upper support surface.
  edgeAdvance: 0.08,
  // Keep the last validated edge support briefly while the cylinder normal
  // rotates through pure-up and the chassis-axis ray has not yet moved over
  // the top. This bridges query representations, not arbitrary air time.
  handoffGraceTicks: 12,
  // Contacts flatter than this remain the suspension ray's responsibility.
  // 0.65 is approximately a 49 degree maximum support slope.
  maxSupportNormalY: 0.65,
  // A ledge-to-top transition may change the downward-ray depth by the full
  // obstacle height in one tick. Limit that handoff instead of teleporting
  // the axle and feeding the discontinuity into the spring/damper.
  depthCatchupRate: 3.0,
} as const;

// Anti-roll bar. This is suspension-relative load transfer, never a
// chassis-to-world upright spring. torqueStiffness / torqueDamping retain
// the useful flat-corner magnitudes of the previous controller; each axle
// converts its share to paired wheel-end forces through its track width.
// Transfer is capped by that axle's static weight so a drooped wheel can
// tension the bar without turning it into an unlimited self-righting motor.
export const ANTI_ROLL = {
  torqueStiffness: 70_000,
  torqueDamping: 16_000,
  frontShare: 0.55,
  rearShare: 0.45,
  lowRangeFrontDisconnect: 0,
  maxStaticLoadTransfer: 0.45,
} as const;

// Water: buoyancy, drag, current and drowning.
//
// The model is four-corner Archimedes on a box hull plus a single drag
// term taken against the *relative* velocity of vehicle and water. That
// one term is both the drag and the current: a stationary truck in
// flowing water is pushed, one already moving with the flow feels
// nothing, and neither needs its own coefficient.
//
// Do not be tempted to express any of this as rigid-body linearDamping.
// That knob is velocity-proportional rather than aerodynamic, applies
// in all directions equally, and is already tuned for air (see the note
// in solidAxleVehicle's constructor).
export const WATER = {
  /** kg/m^3. Fresh water; the number is here so the buoyancy formula
   *  reads as physics rather than as a magic scale factor. */
  density: 1000,

  /** Displacement of the hull box, m^3. The chassis box is 1.7 x 0.9 x
   *  3.8 = 5.81 m^3, which at 1000 kg/m^3 would lift 5.8 tonnes against
   *  a 1.5 t truck - a beach ball. Real 4x4s are mostly air but they are
   *  also mostly *open* to the water: engine bay, cab, wheel wells and
   *  chassis rails all flood. This is the sealed fraction, tuned so a
   *  fully submerged truck floats just barely (buoyancy a little over
   *  weight) rather than bobbing on the surface. */
  hullVolume: 1.9,

  /** Vertical extent over which a hull sample goes from dry to fully
   *  submerged, m.
   *
   *  This is not just anti-buzz smoothing (though it is that too — four
   *  corner forces switching on and off discretely make the truck
   *  chatter at the waterline). It is where the hull's displacement
   *  LIVES, and so it decides how deep the water has to be before the
   *  truck floats.
   *
   *  It must span the chassis box's full height. At 0.5 the whole
   *  displacement was used up by the time water reached the chassis
   *  mid-line, so a truck floated off its wheels in 1.4 m of water and
   *  drifted across every ford with its air intake serenely above the
   *  surface — which made the snorkel decorative and the crossing
   *  identical for all four kinds. Spanning the real hull height means
   *  you have to be bonnet-deep before buoyancy beats weight, and by
   *  then a factory intake is already under. */
  sampleDepthSpan: 0.95,

  /** Quadratic drag: 0.5 * rho * Cd * A, pre-multiplied, N per (m/s)^2.
   *  Lateral is much higher than longitudinal because a truck presents
   *  its whole flank sideways and its bonnet forward - that ratio is
   *  what makes angling upstream a real technique instead of a cosmetic
   *  one. Vertical is high on purpose: it is the main thing stopping a
   *  buoyant box from oscillating. */
  dragLong: 900,
  dragLat: 3400,
  dragVert: 3200,

  /** Angular drag while submerged, N*m per (rad/s). The rotational half
   *  of the anti-bob damping - a floating box that is free to spin picks
   *  up yaw from the current and never sheds it. */
  dragAngular: 4200,

  /** Grip multiplier for a fully submerged tyre. Water between the tread
   *  and the bed is the classic way to lose a crossing. */
  wheelGripFloor: 0.35,
  /** Depth at which a wheel counts as fully submerged for grip, relative
   *  to wheel radius. Above the hub is plenty. */
  wheelGripDepthRatio: 1.6,
  /** Extra rolling resistance from a fully submerged wheel, as a
   *  multiplier on WHEEL.rollingResistance. Wading is heavy. */
  wheelDragMult: 6.0,

  /** Ticks the air intake must be continuously underwater before the
   *  engine floods. At 60 Hz this is a third of a second, so a splash
   *  cresting the bonnet does not kill it but a real submersion does. */
  drownTicks: 20,
  /** Ticks the starter cranks before it catches. Long enough to hear and
   *  to feel like a recovery, short enough not to be a punishment. */
  crankTicks: 45,

  /** Seconds of continuous submersion to fully swamp the hull, and the
   *  fraction of displacement lost when fully swamped.
   *
   *  This is what gives "swept away" an ending: a floating truck slowly
   *  takes on water, settles, grounds on the bed, and becomes a recovery
   *  problem rather than drifting downstream forever. Set swampLoss to 0
   *  to disable. */
  swampSeconds: 18,
  swampLoss: 0.55,
  /** Seconds to drain back out once clear of the water. Faster than
   *  swamping so one bad crossing does not sour the next. */
  drainSeconds: 6,
} as const;

// Chase camera. Lives shared-side because the constants describe the
// game's feel, not anything client-internal. The chase yaw uses an
// under-damped spring (overshoots a touch through corners) plus a
// lateral push proportional to yaw velocity so the camera swings to
// the outside of the turn instead of locking rigidly behind the car.
export const CAMERA = {
  chaseYawStiffness: 14,    // rad/s^2 per rad of error - higher = tracks faster
  chaseYawDamping: 5.5,     // closer to critical (~7.48) - less post-corner oscillation
  chaseSwingLateral: 0.35,  // metres of side offset per rad/s of camera yaw rate
  chaseSwingMax: 1.0,       // clamp on lateral swing offset (m)
} as const;

// Networking
export const DEFAULT_PORT = 2567;
export const INTERPOLATION_DELAY_MS = 100;

// Terrain generation tunables.
export const TERRAIN = {
  // Defaults. These ARE the production world - Room constructs its World
  // with no size/resolution override, so a change here changes the map
  // players actually drive on.
  //
  // They used to read 200/128 while room.ts passed a hardcoded 320/128.
  // That is worse than it sounds: the mountain, the petrol pad and the map
  // edges below are all expressed as RATIOS of size, so 200 and 320 are
  // not the same world at different scales - they are different worlds.
  // Anything constructed from the defaults (tests, the map dumper) was
  // validating terrain that never shipped.
  defaultSize: 320,
  defaultResolution: 128,
  defaultSeed: 1337,

  // Noise
  noiseFreq: 1 / 40,
  detailFreq: 1 / 12,
  baseAmpMin: 3,
  baseAmpMax: 8,
  roughnessDist: 60,

  // Road
  roadZ: -50,        // world-space z of the main straight road centreline
  roadCore: 8,       // |z - roadZ| < roadCore is exactly flat at y=0
  roadShoulder: 14,  // roadCore <= |z - roadZ| < roadShoulder eases into terrain
  valleyAmp: 1.4,
  valleySigma: 12,

  // Mountain (ratios applied to size).
  // Peak and sigma were chosen targeting ~30 % grade on the switchback
  // traverses, but that figure was analytic (bare Gaussian, earlier world
  // size) and the shipped map does not meet it: measured on the generated
  // 320 m heightmap the trail runs a 39 % median / 87 % p90.
  // production-world.test.ts pins the measured numbers as content only.
  // Steeper off-trail face is intentional — you can't shortcut the path.
  mtnPeak: 70,
  mtnSigmaRatio: 0.19,
  mtnXRatio: 0.23,
  mtnZRatio: 0.36,

  // Radius of the flat lookout plateau at the summit (m).
  lookoutRadius: 8,

  // Petrol station pad (sits 28 m north of the main road on the mountain side)
  padCxRatio: -0.20,
  padCz: -22,
  padHalfW: 14,
  padHalfD: 18,
  padWingDelta: 14,
  padFade: 4,
  padYaw: 0,

  // Map edges
  edgeRamp: 14,
  edgeLift: 14,

  // Mud bogs: world-space coords, depth (m), sigma (m)
  bogs: [
    { x: 30, z: -50, depth: 1.7, sigma: 8 },
    { x: -30, z: -80, depth: 1.5, sigma: 7 },  // spread south: was z=-45, too close to (30,-50)
    { x: 75, z: 55, depth: 1.8, sigma: 9 },    // mountain flank: was (110,60) off in a corner
    { x: -100, z: -90, depth: 1.5, sigma: 7 },
    { x: 50, z: -95, depth: 1.6, sigma: 8 },
    { x: 50, z: 55, depth: 1.4, sigma: 9 },    // mountain approach: no north-side mud existed
  ] as ReadonlyArray<{ x: number; z: number; depth: number; sigma: number }>,

  // Additional roads. Each is a polyline with surface type and width.
  // Road surface rules and height flattening use these. The main asphalt
  // road and mountain-trail connector are built by defaultRoad() /
  // mountainTrail() in terrain.ts; these add a circuit loop and a south
  // trail so the map feels like a real course rather than a single strip.
  extraRoads: [
    // North loop: a scenic dirt circuit through the open terrain north of
    // the main road. Branches off at x=-40, sweeps through rolling
    // hills, and rejoins at x=80. Creates a fun lap loop — the player
    // can drive circuits instead of just out-and-back.
    {
      points: [
        { x: -40, z: -50 },
        { x: -60, z: 5 },
        { x: -35, z: 55 },
        { x: 20, z: 65 },
        { x: 65, z: 40 },
        { x: 80, z: -50 },
      ],
      width: 8,
      surface: 1, // Dirt
      shoulderWidth: 3,
    },
    // South bog trail: a narrow dirt track that branches off the main
    // road and heads into the boggy lowlands. gradeIntoTerrain keeps it
    // following the valley floor instead of cutting a flat bench through
    // the bog depressions.
    {
      points: [
        { x: 10, z: -50 },
        { x: 5, z: -85 },
        { x: 30, z: -110 },
      ],
      width: 5,
      surface: 1, // Dirt
      shoulderWidth: 2,
      gradeIntoTerrain: true,
    },
    // East connector: gravel track from the main road up toward the
    // mountain trail base, providing an alternate approach to the hill
    // climb that avoids the steep dirt connector. Follows the valley
    // wall so it grades naturally into the rising terrain.
    {
      points: [
        { x: 80, z: -50 },
        { x: 90, z: -10 },
        { x: 85, z: 30 },
        { x: 70, z: 55 },
      ],
      width: 6,
      surface: 5, // Gravel
      shoulderWidth: 2,
      gradeIntoTerrain: true,
    },
  ] as ReadonlyArray<{
    points: ReadonlyArray<{ x: number; z: number }>;
    width: number;
    surface: number;
    shoulderWidth: number;
    gradeIntoTerrain?: boolean;
  }>,
} as const;

// Hill-climb trail features.
// The trail itself is just a polyline indented into the mountain side
// (see hillClimbLayer). These features sit ON specific traverses to
// give each one a personality:
//   T1 (lower east):  shallow mud puddle - commit through or pick around
//   T2 (mid west):    whoops sequence - sustained suspension articulation
//   T3 (mid east):    plain (recovery / momentum-building stretch)
//   T4 (upper west):  rocky-step mound - articulate at full steer / steep grade
//   T5 (final):       plain (summit approach)
// Tunables collected here so the feature placement / scale can move
// without touching the height-layer code.
export const TRAIL_FEATURES = {
  // Hill climb path indent (m below natural). Reduced from 2.0:
  // a 2 m ditch made the path read as a trench rather than a graded
  // bench cut. 0.8 m is enough to see the trail from a distance without
  // walling the truck into it.
  pathIndent: 0.8,

  whoops: {
    traverseIdx: 1,           // zero-indexed -> traverse 2 (mid west)
    rangeStart: 0.30,         // parametric range along segment
    rangeEnd: 0.70,
    spacing: 3.5,             // metres between bump centres
    height: 0.3,              // peak height of each bump
    sigmaAlong: 0.7,          // along-segment falloff
    sigmaAcross: 1.5,         // across-segment falloff
  },

  rockyStep: {
    traverseIdx: 3,           // traverse 4 (upper west, steep)
    t: 0.5,                   // parametric position along segment
    height: 0.4,              // peak rise
    sigmaAlong: 1.5,
    sigmaAcross: 2.0,
  },

  mudPuddle: {
    traverseIdx: 0,           // traverse 1 (lower east)
    rangeStart: 0.55,
    rangeEnd: 0.70,
    depth: 0.45,              // dip depth
    sigmaAlong: 1.5,
    sigmaAcross: 1.5,
  },
} as const;

// Sparse session rut field depth range. Quantized 0..255 over this range;
// it never mutates the authored map or the coarse Rapier heightfield.
export const RUT_MAX_DEPTH = 0.6;
