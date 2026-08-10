// Custom solid-axle vehicle. Drops Rapier's DynamicRayCastVehicleController
// in favour of: chassis = Rapier RigidBody, two software AxleStates each
// with two software WheelKinematics, per-tick raycasts from chassis-fixed
// wheel-end positions to read terrain heights, then spring/damper forces
// applied as impulses on the chassis at the axle anchors.
//
// The solid-axle behaviour comes from coupling both wheels of an axle
// through the axle's two DOFs (rideY + rollAngle). When one wheel hits a
// rock, the axle articulates - the other wheel either follows down to
// stay planted (within maxArticulation) or pushes the chassis over
// (beyond the cap). That's the rock-crawler flex pose.
//
// Determinism rules:
//   1. Read body.translation()/rotation()/linvel()/angvel() ONCE per
//      preStep, at the top. Do not re-read mid-loop.
//   2. Iterate axles in fixed [front, rear] order, wheels [FL, FR, RL, RR].
//   3. World-down rays (gravity-aligned), not chassis-down: matters on
//      steep slopes where chassis-down would miss the actual ground.
//   4. Diff-lock equalise BEFORE slip computation, so the slip uses the
//      locked angVel.

import RAPIER from '@dimforge/rapier3d-compat';
import {
  ANTI_ROLL,
  ENGINE,
  FIXED_DT,
  GRAVITY_Y,
  LEDGE_CONTACT,
  SUSPENSION,
  TIRE_LATERAL,
  TIRE_LONG_FRICTION,
  VEHICLE,
  WATER,
  WHEEL,
} from '../constants.js';
import { TUNING } from '../tuning.js';
import {
  BUTTON_FRONT_LOCKER,
  BUTTON_RANGE,
  BUTTON_REAR_LOCKER,
  BUTTON_STARTER,
  EMPTY_INPUT,
  type CarKind,
  type DrivetrainState,
  type PlayerInput,
  type TransferCaseMode,
  type VehicleBuild,
  type VehicleDamageState,
  type VehicleState,
  type WheelState,
} from '../types.js';
import { createStockBuild, normalizeVehicleBuild } from '../vehicleBuild.js';
import { Surface, sampleHeightBilinear, sampleSurface, surfaceInfo } from './terrain.js';
import {
  computeWaterLoad, createWaterLoad, createWaterState, hasWater,
  resetWaterState, sampleWaterDepth, wetGripMult, wheelSubmersion,
  type WaterLoad, type WaterState,
} from './water.js';
import {
  createEngineState, stepEngine, stepEngineFlooding, type EngineState,
} from './engine.js';
// slipRatio / gripFromSlip kept in tire.ts for tests; not used here since
// the impulse-clamped integrator below replaced the Pacejka groundTq path.
// slipAngle / lateralGripFromSlipAngle ARE used to shape the lateral
// force so the tyre breaks loose past its slip-angle peak.
import { rotateVecByQuat } from './util.js';
import { slipAngle, lateralGripFromSlipAngle } from './tire.js';
import {
  carcassRates,
  classifyTireContact,
  solveSeriesCompliance,
  solveSidewallConstraint,
  type TireContactSemantics,
} from './tireCarcass.js';
import { geomFor, type VehicleGeom } from './vehicleGeom.js';
import {
  applyAxleSnap,
  axleSnap,
  computeAntiRollLoadTransfer,
  createAxleState,
  resetAxleState,
  stepAxle,
  type AxleSnap,
  type AxleState,
} from './axle.js';
import {
  createWheelKinematic,
  integrateWheelSpin,
  resetWheelKinematic,
  type WheelKinematic,
} from './wheelDynamics.js';
import type {
  ExternalPointLoad,
  VehicleDebugTelemetry,
  VehicleLike,
  VehicleSpawn,
  WaterStatus,
  WheelDebugTelemetry,
} from './vehicleTypes.js';
import type { World } from './world.js';
import { COLLISION_GROUP_OWNED_VEHICLE, COLLISION_GROUP_WHEEL_RAY } from './collisionGroups.js';
import {
  contactFrame,
  cylinderRotation,
  findSteepWheelContact,
  wheelBasis,
  type SteepWheelContact,
  type WheelBasis,
} from './wheelContact.js';
import { applyCollisionDamage, createDamageState, repairDamage } from './damage.js';

type Vec3 = { x: number; y: number; z: number };

function createWheelDebugTelemetry(): WheelDebugTelemetry {
  return {
    contact: false,
    contactPoint: { x: 0, y: 0, z: 0 },
    contactNormal: { x: 0, y: 1, z: 0 },
    surface: Surface.Dirt,
    waterDepth: 0,
    normalLoad: 0,
    gripCoefficient: 0,
    gripLimit: 0,
    longitudinalForce: 0,
    lateralForce: 0,
    force: { x: 0, y: 0, z: 0 },
    slipRatio: 0,
    slipAngle: 0,
    utilization: 0,
    suspensionCompression: 0,
    suspensionOrigin: { x: 0, y: 0, z: 0 },
    suspensionEnd: { x: 0, y: 0, z: 0 },
    wheelCenter: { x: 0, y: 0, z: 0 },
    suspensionRestLength: 0,
    droopMax: 0,
    bumpMax: 0,
    angularVelocity: 0,
    driveTorque: 0,
    brakeTorque: 0,
    groundTorque: 0,
    contactZone: 'air',
    treadFraction: 0,
    suspensionAxisAlignment: 0,
    carcassDeflection: 0,
    suspensionForce: 0,
    carcassForce: 0,
  };
}

function setSuspensionDebug(
  debug: WheelDebugTelemetry,
  origin: Vec3,
  direction: Vec3,
  length: number,
  geom: { suspensionRestLength: number; droopMax: number; bumpMax: number },
): void {
  debug.suspensionOrigin.x = origin.x;
  debug.suspensionOrigin.y = origin.y;
  debug.suspensionOrigin.z = origin.z;
  debug.suspensionEnd.x = origin.x + direction.x * length;
  debug.suspensionEnd.y = origin.y + direction.y * length;
  debug.suspensionEnd.z = origin.z + direction.z * length;
  debug.suspensionRestLength = geom.suspensionRestLength;
  debug.droopMax = geom.droopMax;
  debug.bumpMax = geom.bumpMax;
}

/** Transfer-case and locker changes are safe at trail speeds up to 20 km/h. */
const DRIVETRAIN_CHANGE_MAX_SPEED = 20 / 3.6;

/** Axle torque shares selected by the transfer case. Exported so the
 *  2H rear-drive invariant can be pinned without reaching into Rapier. */
export function transferCaseDriveSplit(mode: TransferCaseMode): { front: number; rear: number } {
  return mode === '2h' ? { front: 0, rear: 1 } : { ...VEHICLE.driveSplit };
}

/** One deterministic limited-slip coupling step. Unlike a locker this only
 * narrows the wheel-speed difference and never makes both speeds identical. */
export function coupleLimitedSlip(left: number, right: number, coupling: number): [number, number] {
  const correction = (right - left) * Math.max(0, Math.min(0.49, coupling)) * 0.5;
  return [left + correction, right - correction];
}

/** Speed-sensitive mechanical steering limit derived from
 *  a_lat = v^2 * tan(steer) / wheelbase. Binary keyboard input otherwise
 *  requests full lock at any speed, which is both unrealistic and capable of
 *  tripping a fast car over its outside tyres. */
export function steeringLimitForSpeed(
  mechanicalLimit: number,
  wheelbase: number,
  speed: number,
): number {
  if (mechanicalLimit <= 0 || wheelbase <= 0) return 0;
  const v = Math.max(0, Math.abs(speed));
  if (v < 1e-3) return mechanicalLimit;
  const dynamicLimit = Math.atan(wheelbase * TUNING.maxSteerLateralAccel / (v * v));
  return Math.min(mechanicalLimit, dynamicLimit);
}

export class SolidAxleVehicle implements VehicleLike {
  private readonly world: World;
  readonly id: string;
  readonly build: VehicleBuild;
  readonly body: RAPIER.RigidBody;
  readonly chassis: RAPIER.Collider;
  readonly geom: VehicleGeom;
  private readonly wheelShape: RAPIER.Cylinder;

  private input: PlayerInput = { ...EMPTY_INPUT };
  private currentSteer = 0;
  private lastButtons = 0;
  private readonly drivetrain: DrivetrainState = {
    transferCase: '4h',
    frontLocked: false,
    rearLocked: false,
  };
  private readonly damage: VehicleDamageState = createDamageState();
  private drivetrainNotice: string | null = null;
  private impactSpeed = 0;

  private readonly axles: [AxleState, AxleState];
  private readonly wheels: [WheelKinematic, WheelKinematic, WheelKinematic, WheelKinematic];
  private readonly wheelDebug: [WheelDebugTelemetry, WheelDebugTelemetry, WheelDebugTelemetry, WheelDebugTelemetry] = [
    createWheelDebugTelemetry(), createWheelDebugTelemetry(),
    createWheelDebugTelemetry(), createWheelDebugTelemetry(),
  ];

  private engine: EngineState = createEngineState();
  private lastRpm = 0;
  private lastGear = 0;
  private ledgeCrawlTicks = 0;
  private debugDriveTorque = 0;
  private debugVelocityInitialized = false;
  private readonly debugPreviousLinVel: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly debugAcceleration: Vec3 = { x: 0, y: 0, z: 0 };

  private readonly water: WaterState = createWaterState();
  private readonly waterLoad: WaterLoad = createWaterLoad();
  /** Whether this world's map has any water at all. Cached: the terrain
   *  collider is built once and never swapped, so a map that is dry now
   *  is dry for the session, and this keeps the whole water path off the
   *  hot loop for every existing map. */
  private readonly worldHasWater: boolean;

  // Reused scratch vectors so the per-tick force/torque loop doesn't
  // allocate. Contents are valid only for the duration of the call site
  // that wrote them; never store references to these.
  private readonly _scratchForce: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly _scratchStaticLateralHold: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly externalPointLoads: ExternalPointLoad[] = [];

  constructor(
    world: World,
    id: string,
    spawn: VehicleSpawn,
    value: VehicleBuild | CarKind = createStockBuild(),
  ) {
    this.world = world;
    this.id = id;
    this.build = typeof value === 'string'
      ? createStockBuild(value === 'hilux' ? 'stockman-dual'
        : value === 'overlander' || value === 'stockman-single' || value === 'stockman-dual' || value === 'longreach' || value === 'outclaw' || value === 'dustback-rs'
          ? value : 'ridgeback')
      : normalizeVehicleBuild(value);
    this.geom = geomFor(this.build);
    this.drivetrain.transferCase = this.geom.spec.drivetrain === 'fixed-rwd' ? '2h' : '4h';
    this.wheelShape = new RAPIER.Cylinder(this.geom.wheelWidth / 2, this.geom.wheelRadius);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
      // Linear damping in Rapier is velocity-proportional (not real
      // aero drag) so anything above ~0.03 silently bleeds a fixed
      // fraction of speed every second regardless of grip / surface
      // / throttle. 0.1 was costing ~9.5%/s — at 20 m/s that's
      // ~1.9 m/s² of phantom drag, eating ~18% of peak forward
      // accel and making everything feel heavy. 0.02 keeps a tiny
      // amount of velocity decay (helps the truck come to rest from
      // a free coast in a finite time) without measurably hurting
      // top speed or acceleration.
      .setLinearDamping(0.02)
      // Supported roll is settled by the suspension dampers. Keep only a
      // small amount of generic decay so an airborne/tumbling chassis
      // retains angular momentum instead of feeling submerged in syrup.
      .setAngularDamping(0.1)
      .setCanSleep(false);
    if (spawn.yaw) {
      const half = spawn.yaw / 2;
      bodyDesc.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    }
    this.body = world.world.createRigidBody(bodyDesc);

    const ext = this.geom.chassisHalfExtents;
    const r = VEHICLE.chassisColliderRadius;
    // Span the full visual height (chassis bottom → roof top) so the roof
    // doesn't clip through the ground when the car is upside-down.
    const colHalfH = (this.geom.spec.collisionRoofY + ext.y) / 2;
    const colOffsetY = -ext.y + colHalfH; // center between chassis-bottom and roof
    const kindMass = this.geom.spec.massKg;
    const inertiaMult = this.geom.spec.inertiaMult;
    // Principal moments of a box expressed with half-extents:
    // I_x = m/3 * (hy^2 + hz^2), and cyclic permutations. Using the
    // chassis mass envelope rather than the roof collider keeps the flat-
    // ground rotational response close to the previous tuned behavior.
    const principalInertia = {
      x: kindMass / 3 * (ext.y * ext.y + ext.z * ext.z) * inertiaMult,
      y: kindMass / 3 * (ext.x * ext.x + ext.z * ext.z) * inertiaMult,
      z: kindMass / 3 * (ext.x * ext.x + ext.y * ext.y) * inertiaMult,
    };
    const colDesc = RAPIER.ColliderDesc.roundCuboid(ext.x - r, colHalfH - r, ext.z - r, r)
      .setTranslation(0, colOffsetY, 0)
      // Collision geometry reaches the roof, but mass does not have a
      // uniform roof-height distribution. Explicit collider mass properties
      // decouple the collision envelope from the chassis mass envelope.
      .setMassProperties(
        kindMass,
        {
          x: this.geom.spec.centerOfMass.x,
          y: this.geom.spec.centerOfMass.y - colOffsetY,
          z: this.geom.spec.centerOfMass.z,
        },
        principalInertia,
        { x: 0, y: 0, z: 0, w: 1 },
      )
      .setFriction(0.1)
      .setCollisionGroups(COLLISION_GROUP_OWNED_VEHICLE);
    this.chassis = world.world.createCollider(colDesc, this.body);

    this.axles = [
      createAxleState(this.geom.front),
      createAxleState(this.geom.rear),
    ];
    this.wheels = [
      createWheelKinematic(),
      createWheelKinematic(),
      createWheelKinematic(),
      createWheelKinematic(),
    ];
    this.worldHasWater = hasWater(world.terrain);
  }

  setInput(input: PlayerInput): void {
    this.input = input;
  }

  queueExternalPointLoad(load: ExternalPointLoad): void {
    this.externalPointLoads.push({
      force: { ...load.force },
      point: { ...load.point },
    });
  }

  resetTo(spawn: VehicleSpawn): void {
    this.body.setTranslation(
      { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z },
      true,
    );
    if (spawn.yaw !== undefined) {
      const half = spawn.yaw / 2;
      this.body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
    } else {
      this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    }
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.currentSteer = 0;
    this.lastButtons = 0;
    this.input = { ...EMPTY_INPUT };
    this.drivetrain.transferCase = this.geom.spec.drivetrain === 'fixed-rwd' ? '2h' : '4h';
    this.drivetrain.frontLocked = false;
    this.drivetrain.rearLocked = false;
    this.drivetrainNotice = null;
    repairDamage(this.damage);
    for (const a of this.axles) resetAxleState(a);
    for (const w of this.wheels) resetWheelKinematic(w);
    this.engine = createEngineState();
    this.lastRpm = 0;
    this.lastGear = 0;
    this.ledgeCrawlTicks = 0;
    this.debugDriveTorque = 0;
    this.debugVelocityInitialized = false;
    this.debugAcceleration.x = 0;
    this.debugAcceleration.y = 0;
    this.debugAcceleration.z = 0;
    resetWaterState(this.water);
    this.externalPointLoads.length = 0;
  }

  preStep(): void {
    const dt = FIXED_DT;

    // CRITICAL: Rapier accumulates external forces across step() calls
    // until reset. Without these calls, last tick's spring force would
    // add to this tick's, causing a runaway upward force after a few
    // ticks of contact. Reset here so each tick's force is fresh.
    this.body.resetForces(false);
    this.body.resetTorques(false);
    for (const load of this.externalPointLoads) {
      this.body.addForceAtPoint(load.force, load.point, true);
    }
    this.externalPointLoads.length = 0;

    // 1. Capture chassis pose ONCE (determinism rule).
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const fwd = rotateVecByQuat({ x: 0, y: 0, z: 1 }, r);
    const right = rotateVecByQuat({ x: 1, y: 0, z: 0 }, r);
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, r);
    if (this.debugVelocityInitialized) {
      this.debugAcceleration.x = (lv.x - this.debugPreviousLinVel.x) / dt;
      this.debugAcceleration.y = (lv.y - this.debugPreviousLinVel.y) / dt;
      this.debugAcceleration.z = (lv.z - this.debugPreviousLinVel.z) / dt;
    } else {
      this.debugAcceleration.x = 0;
      this.debugAcceleration.y = 0;
      this.debugAcceleration.z = 0;
      this.debugVelocityInitialized = true;
    }
    this.debugPreviousLinVel.x = lv.x;
    this.debugPreviousLinVel.y = lv.y;
    this.debugPreviousLinVel.z = lv.z;
    const groundSpeed = Math.hypot(lv.x, lv.z);
    this.impactSpeed = groundSpeed;
    this.updateDrivetrainControls(groundSpeed);
    const wheelBases: Array<WheelBasis | null> = [null, null, null, null];
    const ledgeContacts: Array<SteepWheelContact | null> = [null, null, null, null];
    const ledgeSemantics: Array<TireContactSemantics | null> = [null, null, null, null];
    const ledgeLoads = [0, 0, 0, 0];

    // 2. Smooth steering.
    const steeringAuthority = 0.28 + this.damage.steering * 0.72;
    const alignmentPull = (1 - this.damage.steering) * 0.16;
    const lockerSteer = this.drivetrain.frontLocked ? 0.68
      : this.drivetrain.rearLocked ? 0.88 : 1;
    const mechanicalSteerLimit = TUNING.maxSteer * this.geom.spec.maxSteerMult;
    const activeSteerLimit = steeringLimitForSpeed(
      mechanicalSteerLimit,
      this.geom.spec.wheelbase,
      groundSpeed,
    );
    const targetSteer = clamp(
      this.input.steer * mechanicalSteerLimit * steeringAuthority * lockerSteer + alignmentPull,
      -activeSteerLimit,
      activeSteerLimit,
    );
    const steerDelta = targetSteer - this.currentSteer;
    const maxStep = TUNING.steerSpeed * this.geom.spec.steeringResponse * dt;
    this.currentSteer = clamp(
      this.currentSteer
        + (Math.abs(steerDelta) < maxStep ? steerDelta : Math.sign(steerDelta) * maxStep),
      -activeSteerLimit,
      activeSteerLimit,
    );

    // 3. Per axle: raycast wheel-ends, integrate axle DOFs, apply chassis
    //    reaction forces. Raycast origins are FIXED in chassis-local space
    //    (do NOT include axle articulation) - this avoids a feedback loop
    //    where the axle's roll changes the rays which changes the target
    //    roll which changes the rays again.
    for (let aIdx = 0; aIdx < 2; aIdx++) {
      const axle = this.axles[aIdx]!;
      const ag = axle.geom;
      // Runtime scalars on this axle's compile-time rates. Multipliers,
      // not overrides, so the per-kind differences baked into ag (the
      // Hilux's softer rear, say) survive a slider move.
      const at = aIdx === 0 ? TUNING.axleFront : TUNING.axleRear;

      const wIdxL = aIdx * 2;
      const wIdxR = aIdx * 2 + 1;
      const wL = this.wheels[wIdxL]!;
      const wR = this.wheels[wIdxR]!;

      // Lift ray origins to prevent rays starting inside terrain. This is
      // vital when the chassis is belly-out or wheels are deep.
      const rayLift = SUSPENSION.rayLift;
      const leftLocal = { x: -ag.trackHalf, y: ag.centerLocalY + rayLift, z: ag.centerLocalZ };
      const rightLocal = { x: +ag.trackHalf, y: ag.centerLocalY + rayLift, z: ag.centerLocalZ };
      const leftWorld = addVec(t, rotateVecByQuat(leftLocal, r));
      const rightWorld = addVec(t, rotateVecByQuat(rightLocal, r));
      const supportLookahead = {
        x: lv.x * dt * SUSPENSION.supportLookaheadTicks,
        y: 0,
        z: lv.z * dt * SUSPENSION.supportLookaheadTicks,
      };
      const leftSupportWorld = addVec(leftWorld, supportLookahead);
      const rightSupportWorld = addVec(rightWorld, supportLookahead);

      // The support query sweeps the real tyre cylinder, so it needs the
      // wheel's current axle/steer orientation before we cast it. Both ends
      // share the same rigid-axle basis; only their cast origins differ.
      const basis = wheelBasis(
        fwd,
        right,
        up,
        axle.targetRollAngle,
        ag.hasSteering ? -this.currentSteer : 0,
      );
      wheelBases[wIdxL] = basis;
      wheelBases[wIdxR] = basis;
      const wheelRotation = cylinderRotation(basis.axle);

      // Cast the ray along the chassis's local -Y axis (rotated to world)
      // rather than world-down. Rationale: the wheel TRAVELS along
      // chassis-Y - that's the suspension axis. Casting world-down works
      // on level ground but on a rolled chassis (truck across a slope)
      // the world-down ray from a chassis-local origin no longer passes
      // through where the wheel actually is, so the ray finds the wrong
      // ground point. Rolled-chassis bug observed: wheels on the
      // higher side reading as buried in terrain because the world-down
      // ray hits a slope crest closer than the wheel's real position.
      const rayDirLocal: Vec3 = { x: 0, y: -1, z: 0 };
      const rayDir = rotateVecByQuat(rayDirLocal, r);
      // A shape cast measures hub travel directly, so its range ends at full
      // droop. (The old point ray needed one extra radius to reach the patch.)
      const maxToi = rayLift + ag.suspensionRestLength + ag.droopMax;

      const debugLeft = this.wheelDebug[wIdxL]!;
      const debugRight = this.wheelDebug[wIdxR]!;
      setSuspensionDebug(debugLeft, leftSupportWorld, rayDir, maxToi, ag);
      setSuspensionDebug(debugRight, rightSupportWorld, rayDir, maxToi, ag);

      castWheelSupport(
        this.world,
        this.body,
        this.wheelShape,
        wheelRotation,
        leftSupportWorld,
        rayDir,
        maxToi,
        ag.suspensionRestLength + rayLift,
        this.geom.wheelRadius,
        this.geom.wheelWidth / 2,
        basis.axle,
        wL,
      );
      castWheelSupport(
        this.world,
        this.body,
        this.wheelShape,
        wheelRotation,
        rightSupportWorld,
        rayDir,
        maxToi,
        ag.suspensionRestLength + rayLift,
        this.geom.wheelRadius,
        this.geom.wheelWidth / 2,
        basis.axle,
        wR,
      );
      // Lookahead is only for choosing next-frame support depth/normal. Tire
      // and spring reactions still act at the current wheel patch; leaving the
      // point one tick ahead adds an artificial moment arm during cornering.
      wL.contactPoint.x -= supportLookahead.x;
      wL.contactPoint.z -= supportLookahead.z;
      wR.contactPoint.x -= supportLookahead.x;
      wR.contactPoint.z -= supportLookahead.z;

      wL.surface = sampleSurface(this.world.terrain, wL.contactPoint.x, wL.contactPoint.z);
      wR.surface = sampleSurface(this.world.terrain, wR.contactPoint.x, wR.contactPoint.z);
      wL.supportGrip = wL.supportIsTerrain ? surfaceGrip(wL.surface, this.geom) : wL.supportColliderFriction;
      wR.supportGrip = wR.supportIsTerrain ? surfaceGrip(wR.surface, this.geom) : wR.supportColliderFriction;

      // Water between the tread and the bed, on top of whatever the bed
      // itself grips at. Keeping the bed surface is the reason water is
      // its own grid rather than a Surface: a gravel ford and a
      // mud-bottom crossing should not feel the same.
      if (this.worldHasWater) {
        wL.waterDepth = sampleWaterDepth(this.world.terrain, wL.contactPoint.x, wL.contactPoint.z);
        wR.waterDepth = sampleWaterDepth(this.world.terrain, wR.contactPoint.x, wR.contactPoint.z);
        wL.supportGrip *= wetGripMult(wL.waterDepth, this.geom.wheelRadius) * this.geom.spec.grip.wet;
        wR.supportGrip *= wetGripMult(wR.waterDepth, this.geom.wheelRadius) * this.geom.spec.grip.wet;
      }

      // A second, volumetric query catches faces the suspension-axis ray
      // cannot see. It is based on the previous axle pose so the tyre starts
      // touching a ledge when its circumference reaches it, not when the
      // wheel centre has already crossed the face.
      const volumeSides: Array<{ index: number; wheel: WheelKinematic; localX: number }> = [
        { index: wIdxL, wheel: wL, localX: -ag.trackHalf },
        { index: wIdxR, wheel: wR, localX: +ag.trackHalf },
      ];
      for (const volumeSide of volumeSides) {
        const w = volumeSide.wheel;
        const center = wheelCenterWorld(t, r, axle, volumeSide.localX);
        const debug = this.wheelDebug[volumeSide.index]!;
        debug.wheelCenter.x = center.x;
        debug.wheelCenter.y = center.y;
        debug.wheelCenter.z = center.z;
        // Exact upward terrain support already accounts for the tyre volume.
        // Running the steep-face path as well would replace its raw depth with
        // the intentionally slow ledge-climb handoff, leaving the visible axle
        // behind the ground it is already supported by.
        let ledge = w.volumeSupport ? null : findSteepWheelContact(
          this.world.world,
          this.wheelShape,
          w.hasPreviousCenter ? w.previousCenter : null,
          center,
          wheelRotation,
          this.geom.wheelRadius,
          this.geom.wheelWidth / 2,
          LEDGE_CONTACT.prediction,
          LEDGE_CONTACT.maxSupportNormalY,
          LEDGE_CONTACT.maxClimbHeight,
          LEDGE_CONTACT.edgeAdvance,
          basis.forward,
          COLLISION_GROUP_WHEEL_RAY,
          basis.axle,
        );
        if (!ledge && !w.contact) {
          ledge = findTerrainSidewallContact(
            this.world,
            center,
            basis.axle,
            this.geom.wheelRadius,
            this.geom.wheelWidth / 2,
            LEDGE_CONTACT.prediction,
          );
        }
        ledgeContacts[volumeSide.index] = ledge;
        const semantics = ledge
          ? classifyTireContact(
            ledge.normal.x * basis.axle.x
            + ledge.normal.y * basis.axle.y
            + ledge.normal.z * basis.axle.z,
          )
          : null;
        ledgeSemantics[volumeSide.index] = semantics;
        w.ledgeContact = ledge !== null;
        w.ledgeNormalForce = 0;
        w.ledgeLongForce = 0;
        w.previousCenter.x = center.x;
        w.previousCenter.y = center.y;
        w.previousCenter.z = center.z;
        w.hasPreviousCenter = true;

        const quarterMass = this.geom.spec.massKg * 0.25;
        const carcass = carcassRates(
          {
            ...this.geom.spec.tireCarcass,
            staticDeflectionRatio: this.geom.spec.tireCarcass.staticDeflectionRatio
              * TUNING.tireCarcassComplianceMult,
            radialDampingRatio: this.geom.spec.tireCarcass.radialDampingRatio
              * TUNING.tireRadialDampingMult,
          },
          this.geom.wheelRadius,
          quarterMass * Math.abs(GRAVITY_Y),
          quarterMass,
        );
        const series = solveSeriesCompliance(
          w.contact ? Math.max(0, w.contactDepth) : 0,
          0.5 * ag.rideStiffness * at.rideStiffnessMult,
          carcass.stiffness,
          carcass.maxDeflection,
        );
        let bridgeActive = false;
        if (ledge && (semantics?.treadFraction ?? 0) > 0) {
          w.ledgeHandoff = true;
          w.ledgeHandoffGrace = LEDGE_CONTACT.handoffGraceTicks;
          bridgeActive = true;
        } else if (w.ledgeHandoff) {
          if (w.contact) bridgeActive = true;
          else if (w.ledgeHandoffGrace > 0) {
            w.ledgeHandoffGrace--;
            bridgeActive = true;
          }
        }
        w.resolvedDepth = w.resolvedDepthInitialized && bridgeActive
          ? moveToward(w.resolvedDepth, series.suspensionDeflection, LEDGE_CONTACT.depthCatchupRate * dt)
          : series.suspensionDeflection;
        w.resolvedDepthInitialized = true;
        if (w.ledgeHandoff && (
          !bridgeActive
          || (w.contact && Math.abs(w.resolvedDepth - series.suspensionDeflection) < 1e-6)
        )) w.ledgeHandoff = false;
        w.tireDeflection = w.contact
          ? series.carcassDeflection
          : Math.max(0, w.previousTireDeflection - 1.5 * dt);
        w.tireDeflectionRate = (w.tireDeflection - w.previousTireDeflection) / dt;
        w.carcassForce = w.contact
          ? Math.max(0, Math.min(
            LEDGE_CONTACT.maxForce,
            carcass.stiffness * w.tireDeflection
              + carcass.radialDamping * w.tireDeflectionRate,
          ))
          : 0;
        w.contactZone = w.contact ? (w.contactZone === 'air' ? 'tread' : w.contactZone) : 'air';
        w.treadFraction = w.contact ? w.treadFraction : 0;
        if (w.contact) {
          w.tireContactNormal.x = w.contactNormal.x;
          w.tireContactNormal.y = w.contactNormal.y;
          w.tireContactNormal.z = w.contactNormal.z;
        }
        if (ledge) {
          const normalSpeed = pointVelocityDot(lv, av, t, ledge.point, ledge.normal);
          const constraint = solveSidewallConstraint(
            ledge.penetration,
            normalSpeed,
            (VEHICLE.mass * this.geom.massMult) * LEDGE_CONTACT.normalMassFraction,
            dt,
            w.contact ? 0 : w.previousTireDeflection,
            carcass.maxDeflection,
            LEDGE_CONTACT.normalCorrectionRate * TUNING.tireSidewallCorrectionMult,
            LEDGE_CONTACT.maxNormalCorrectionSpeed * TUNING.tireSidewallCorrectionMult,
            LEDGE_CONTACT.maxForce * dt,
          );
          const normalForce = constraint.impulse / dt;
          ledgeLoads[volumeSide.index] = normalForce;
          w.ledgeNormalForce = normalForce;
          if (!w.contact || constraint.deflection > w.tireDeflection) {
            w.tireDeflection = constraint.deflection;
            w.tireContactNormal.x = ledge.normal.x;
            w.tireContactNormal.y = ledge.normal.y;
            w.tireContactNormal.z = ledge.normal.z;
            w.contactZone = semantics?.zone ?? 'sidewall';
            w.treadFraction = semantics?.treadFraction ?? 0;
            w.suspensionAxisAlignment = Math.max(0, -(
              ledge.normal.x * rayDir.x + ledge.normal.y * rayDir.y + ledge.normal.z * rayDir.z
            ));
          }
          if (normalForce > 0) {
            const sf = this._scratchForce;
            sf.x = ledge.normal.x * constraint.impulse;
            sf.y = ledge.normal.y * constraint.impulse;
            sf.z = ledge.normal.z * constraint.impulse;
            if (semantics?.zone === 'tread') this.body.applyImpulse(sf, true);
            else this.body.applyImpulseAtPoint(sf, ledge.point, true);
            // A pure sidewall has ordinary carcass scrub, but no rolling
            // frame and therefore no drive/brake torque. Apply that scrub as
            // a bounded chassis impulse at the physical patch.
            if (semantics?.treadFraction === 0) {
              const armX = ledge.point.x - t.x;
              const armY = ledge.point.y - t.y;
              const armZ = ledge.point.z - t.z;
              const vx = lv.x + av.y * armZ - av.z * armY;
              const vy = lv.y + av.z * armX - av.x * armZ;
              const vz = lv.z + av.x * armY - av.y * armX;
              const normalV = vx * ledge.normal.x + vy * ledge.normal.y + vz * ledge.normal.z;
              const tx = vx - ledge.normal.x * normalV;
              const ty = vy - ledge.normal.y * normalV;
              const tz = vz - ledge.normal.z * normalV;
              const tangentSpeed = Math.hypot(tx, ty, tz);
              if (tangentSpeed > 1e-6) {
                const tangentImpulse = Math.min(
                  tangentSpeed * quarterMass,
                  constraint.impulse
                    * this.geom.spec.tireCarcass.sidewallFrictionRatio
                    * TUNING.tireSidewallFrictionMult,
                );
                sf.x = -tx / tangentSpeed * tangentImpulse;
                sf.y = -ty / tangentSpeed * tangentImpulse;
                sf.z = -tz / tangentSpeed * tangentImpulse;
                this.body.applyImpulseAtPoint(sf, ledge.point, true);
              }
            } else if (ledge.climbDirection && (semantics?.treadFraction ?? 0) > 0) {
              // The analytical wheel has no unsprung body for tread wrapping
              // to accelerate. Represent that missing DOF as a bounded
              // velocity constraint along the validated top-edge tangent;
              // it acts on the chassis directly and never changes spring
              // depth, articulation or normal load.
              const treadFraction = semantics?.treadFraction ?? 0;
              const rawClimb = ledge.climbDirection;
              const lateralPart = rawClimb.x * basis.axle.x
                + rawClimb.y * basis.axle.y + rawClimb.z * basis.axle.z;
              const planarX = rawClimb.x - basis.axle.x * lateralPart + basis.forward.x * 0.45;
              const planarY = rawClimb.y - basis.axle.y * lateralPart + basis.forward.y * 0.45;
              const planarZ = rawClimb.z - basis.axle.z * lateralPart + basis.forward.z * 0.45;
              const climbLength = Math.hypot(
                planarX,
                planarY,
                planarZ,
              ) || 1;
              const climb = {
                x: planarX / climbLength,
                y: planarY / climbLength,
                z: planarZ / climbLength,
              };
              const climbSpeed = pointVelocityDot(lv, av, t, ledge.point, climb);
              const targetSpeed = Math.min(
                0.55,
                Math.max(
                  Math.min(LEDGE_CONTACT.edgeMotorMaxSpeed, Math.max(0, w.angVel) * this.geom.wheelRadius),
                  Math.max(0, (ledge.climbTopY! + this.geom.wheelRadius - center.y) * 5),
                ),
              );
              const climbImpulse = clamp(
                (targetSpeed - climbSpeed) * quarterMass * treadFraction,
                0,
                LEDGE_CONTACT.edgeMotorMaxForce * 2 * dt,
              );
              if (climbImpulse > 0) {
                sf.x = climb.x * climbImpulse;
                sf.y = climb.y * climbImpulse;
                sf.z = climb.z * climbImpulse;
                this.body.applyImpulseAtPoint(
                  sf,
                  scaledMomentPoint(t, ledge.point, LEDGE_CONTACT.chassisMomentArmScale),
                  true,
                );
              }
              const forwardSpeed = pointVelocityDot(lv, av, t, ledge.point, basis.forward);
              const forwardImpulse = clamp(
                (0.65 - forwardSpeed) * quarterMass * treadFraction,
                0,
                LEDGE_CONTACT.edgeMotorMaxForce * dt,
              );
              if (forwardImpulse > 0) {
                sf.x = basis.forward.x * forwardImpulse;
                sf.y = basis.forward.y * forwardImpulse;
                sf.z = basis.forward.z * forwardImpulse;
                this.body.applyImpulse(sf, true);
              }
            }
          }
        }
        w.previousTireDeflection = w.tireDeflection;
      }

      // Update axle state (rideY tracks avgComp, rollAngle tracks slope).
      // We still use stepAxle for the kinematic axle bookkeeping that
      // feeds visuals + snapshots, but we IGNORE its chassisRideForce
      // and instead apply per-wheel-end ride forces below. The reason:
      // applying a single ride force at the axle CENTER (chassis-local
      // x=0) gives no roll-restoring torque when the chassis tips - both
      // wheels' contributions sum at x=0 and just push the chassis
      // straight up regardless of tilt, so any small roll perturbation
      // grows unchecked. Splitting the ride force into per-wheel-end
      // components at +/- trackHalf naturally creates the righting
      // moment that solid-axle vehicles get from their leaf-spring or
      // coilover mounts being attached at the axle ends, not the diff.
      const result = stepAxle(axle, {
        leftDepth: wL.resolvedDepth,
        rightDepth: wR.resolvedDepth,
        leftContact: hasSuspensionSupport(wL),
        rightContact: hasSuspensionSupport(wR),
        chassisVertVelAtAnchor: 0, // unused now; per-wheel damping below
        dt,
        rideStiffnessMult: at.rideStiffnessMult,
        rideDampingMult: at.rideDampingMult,
        rollStiffnessMult: at.rollStiffnessMult,
        maxArticulationMult: at.maxArticulationMult,
      });

      // Per-wheel-end ride forces. Compression is read directly from
      // each wheel's raycast (capped at bumpMax to mirror the axle's
      // travel limit). Damping scales with an engagement curve that
      // ramps from 0 to 1 over the first ~80 mm of compression - so a
      // wheel just kissing ground still feels soft, but typical
      // equilibrium (~87 mm of compression under chassis weight) is
      // already at full damping. The earlier `comp / restLength` curve
      // only reached 16% engagement at equilibrium, leaving the
      // chassis vertical mode at ~12% critical - that's the source of
      // the visible 1.7 Hz body bob the user reported as stutter while
      // driving. Saturating earlier brings it to ~critical without
      // hardening the first-contact response.
      const sides: Array<{
        wheel: WheelKinematic;
        localX: number;
        world: Vec3;
        supported: boolean;
        comp: number;
        compRate: number;
        force: number;
      }> = [
        { wheel: wL, localX: -ag.trackHalf, world: leftWorld, supported: false, comp: 0, compRate: 0, force: 0 },
        { wheel: wR, localX: +ag.trackHalf, world: rightWorld, supported: false, comp: 0, compRate: 0, force: 0 },
      ];
      for (const side of sides) {
        const w = side.wheel;
        w.lastForce = 0;
        w.suspensionForce = 0;
        if (!w.contact) {
          w.prevContactDepth = -1;
          continue;
        }
        // Spring is linear in compression. NO bumpMax saturation here:
        // capping spring force at bumpMax was the original cause of the
        // wheel-phasing bug. On a rising slope the ray reports comp >>
        // bumpMax (the slope crest sits above where the wheel-as-point
        // would contact), and a saturated spring can't lift the chassis
        // fast enough — the wheel mesh visibly buries before the chassis
        // catches up. Letting the spring stay linear past bumpMax just
        // makes it a stiffer-than-equilibrium response that drives the
        // chassis off the slope quickly. Capped at restLength to bound
        // the force on degenerate ray reads (e.g. wheel-ray hitting a
        // vertical wall).
        const comp = Math.min(ag.suspensionRestLength, Math.max(0, w.resolvedDepth));
        if (comp <= 0) {
          w.prevContactDepth = -1;
          continue;
        }
        side.supported = true;
        side.comp = comp;
        // Compression-rate damping. Why: the previous formulation damped
        // chassis vertical velocity at the wheel-end (vpY). On a rising
        // slope the chassis MUST lift to follow the slope; vertVel
        // damping then applies a *downward* force during the lift,
        // fighting the spring exactly when it's saturated against the
        // bumpstop. The chassis can't keep up, the chassis collider
        // wedges into the slope, and the truck stalls until friction
        // grinds it back out (the user's wheel-phasing report).
        //
        // Compression rate captures the *suspension* velocity (rate at
        // which the spring is compressing) independent of chassis
        // motion. On a rising slope the wheel is pushed up faster than
        // the chassis lifts → comp increases → compRate > 0 → damping
        // adds force in the same direction as the spring (helps lift).
        // On flat ground at rest, compRate ≈ -vpY (ground stationary),
        // so the damping behaviour matches the old formulation and
        // settling/rollover stability are preserved.
        if (w.prevContactDepth < 0) w.prevContactDepth = comp;
        const rawRate = (comp - w.prevContactDepth) / dt;
        // Clamp: per-tick rate spikes (e.g. ray jumping over a sharp
        // edge) would otherwise produce damping forces that exceed the
        // spring saturation force and destabilise the integrator.
        const compRate = clamp(rawRate, -3, 3);
        side.compRate = compRate;
        // Engagement ramps from 0→1 as compression reaches the engage
        // depth. Suspension only exerts force while compressed (comp > 0).
        const engagement = Math.min(1, comp / SUSPENSION.dampingEngageComp);
        // Per-wheel-end stiffness is HALF the axle's total.
        let F = 0.5 * ag.rideStiffness * at.rideStiffnessMult * comp
              + 0.5 * ag.rideDamping * at.rideDampingMult
                * TUNING.tireRadialDampingMult * engagement * compRate;
        side.force = Math.max(0, F);
        w.suspensionForce = side.force;
      }

      // A sway bar transfers load between the two suspension ends. It is
      // driven by their relative travel/rate, not the chassis's angle to
      // world-up. Unsupported ends sit at full droop for bar deflection,
      // while forces can only enter the chassis through supported ends.
      const frontBarShare = clamp(TUNING.antiRollFrontShare, 0, 1);
      const barShare = aIdx === 0 ? frontBarShare : 1 - frontBarShare;
      const axleMassShare = aIdx === 0 ? 0.52 : 0.48;
      const bar = computeAntiRollLoadTransfer({
        leftDepth: sides[0]!.supported ? sides[0]!.comp : -ag.droopMax,
        rightDepth: sides[1]!.supported ? sides[1]!.comp : -ag.droopMax,
        leftRate: sides[0]!.supported ? sides[0]!.compRate : 0,
        rightRate: sides[1]!.supported ? sides[1]!.compRate : 0,
        leftSupported: sides[0]!.supported,
        rightSupported: sides[1]!.supported,
        trackHalf: ag.trackHalf,
        torqueStiffness: ANTI_ROLL.torqueStiffness * barShare * TUNING.antiRollStiffnessMult,
        torqueDamping: ANTI_ROLL.torqueDamping * barShare * TUNING.antiRollDampingMult,
        maxTransferForce: this.geom.spec.massKg * Math.abs(GRAVITY_Y)
          * axleMassShare * ANTI_ROLL.maxStaticLoadTransfer,
      });
      sides[0]!.force = Math.max(0, sides[0]!.force + bar.leftForce);
      sides[1]!.force = Math.max(0, sides[1]!.force + bar.rightForce);

      for (const side of sides) {
        if (!side.supported) continue;
        const w = side.wheel;
        w.suspensionForce = side.force;
        // Apply the suspension-side resultant once. Carcass reaction is
        // retained separately for diagnostics; applying it again here would
        // double-count the same series load.
        const F = side.force;
        w.lastForce = F;
        // Apply spring force along the CONTACT NORMAL (the direction the
        // ground actually pushes on the wheel), not chassis-up or world-up.
        //   - Flat ground: normal = world-up, so no horizontal component
        //     at any chassis pitch. Earlier chassis-up version creeped
        //     ~0.9 m / 4 s under tan(pitch)*F at any settled pitch; this
        //     formulation has zero creep because the normal IS world-up
        //     when the ground is flat, regardless of how the chassis
        //     itself is oriented.
        //   - Cross-slope: contact normals on both sides point
        //     up-and-uphill (slope perpendicular). The asymmetric
        //     compression (downhill wheel compressed more, uphill less)
        //     produces a chassis roll moment so the body tilts WITH the
        //     slope - fixes the "stays flat" complaint.
        //   - Going up a hill: forward tilt of the chassis is matched by
        //     a slope-normal force that has a backward component
        //     opposing gravity's downhill pull. Net force is
        //     slope-perpendicular - same as a real wheel.
        const n = w.contactNormal;
        const sf = this._scratchForce;
        sf.x = n.x * F; sf.y = n.y * F; sf.z = n.z * F;
        this.body.addForceAtPoint(sf, side.world, true);
        w.prevContactDepth = side.comp;
      }

      // Roll torque dump when terrain demands more articulation than the
      // axle can absorb. Below the cap the per-wheel-end forces above
      // already provide the correct chassis-axle coupling; past the cap
      // the axle has bottomed against its mechanical stop and the
      // surplus has to lever the chassis itself - that's the body-lean-
      // over-a-rock behaviour.
      if (Math.abs(result.chassisRollTorque) > 1e-6) {
        const tq = result.chassisRollTorque;
        const sf = this._scratchForce;
        sf.x = fwd.x * tq; sf.y = fwd.y * tq; sf.z = fwd.z * tq;
        this.body.addTorque(sf, true);
      }
    }

    // 3b. Water: buoyancy, drag and current.
    //
    //     Sits here, after the suspension and anti-roll and before the
    //     engine, for two reasons. The chassis pose, lv, av and the
    //     basis vectors are all already in scope from the single read at
    //     the top of preStep (determinism rule 1), and the engine has
    //     not run yet, so a drowned intake can cut the drive before any
    //     torque is computed rather than after.
    //
    //     Buoyancy is applied as four separate corner forces rather than
    //     one resultant at the centre of buoyancy. Unequal corner lift
    //     IS the righting moment, so pitch and roll response fall out
    //     for free and there is no second torque term to keep in sync.
    //
    //     Nothing here unloads the springs by hand: the suspension force
    //     computed above becomes the tyre's normal load further down, so
    //     a chassis being lifted by water automatically loses grip.
    if (this.worldHasWater) {
      const wl = computeWaterLoad(
        this.world.terrain, this.geom, this.water,
        { t, r, lv, av }, dt, this.waterLoad,
      );
      if (wl.submergedFrac > 0) {
        for (const s of wl.samples) {
          if (s.force.y === 0) continue;
          this.body.addForceAtPoint(s.force, s.point, true);
        }
        // Water pressure acts at the centre of the wetted hull. In a
        // ford that is below the centre of mass, so a cross-current now
        // loads the downstream suspension instead of moving the entire
        // truck sideways as if it were on a conveyor belt.
        this.body.addForceAtPoint(wl.drag, wl.dragPoint, true);
        this.body.addTorque(wl.dragTorque, true);
      }
    } else {
      this.waterLoad.submergedFrac = 0;
      this.waterLoad.intakeSubmerged = false;
      this.waterLoad.drowned = false;
    }

    // 3d. Flood / restart state machine. Must run before the engine so a
    //     drowning cuts the drive on the tick it happens, and so a
    //     successful crank restores idle RPM before stepEngine reads it.
    stepEngineFlooding(
      this.engine,
      this.waterLoad.intakeSubmerged,
      this.waterLoad.drowned,
      (this.input.buttons & BUTTON_STARTER) !== 0,
    );
    if (this.engine.drowned) this.damage.stoppedCause = 'flooding';
    else if (this.damage.stoppedCause === 'flooding') this.damage.stoppedCause = 'none';

    // 4. Engine + gearbox.
    const avgAngVel = (this.wheels[0]!.angVel + this.wheels[1]!.angVel + this.wheels[2]!.angVel + this.wheels[3]!.angVel) / 4;
    const longSpeed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const signedAvg = Math.sign(longSpeed || avgAngVel) * Math.abs(avgAngVel);
    // vehicleAngVel is chassis speed expressed as equivalent wheel rad/s.
    // Passed separately so the engine uses it for shift decisions without
    // being confused by wheel slip (see engine.ts for the full rationale).
    const vehicleAngVel = Math.abs(longSpeed) / this.geom.wheelRadius;
    // In manual mode W / the gas pedal supplies power and the selected gear
    // supplies direction. The input layer turns S into a brake in manual
    // mode, so negative throttle cannot accidentally power the chosen gear.
    const engineThrottle = this.input.manualGear === null
      ? this.input.throttle
      : Math.max(0, this.input.throttle);
    let engineOut = stepEngine(
      this.engine,
      signedAvg,
      vehicleAngVel,
      engineThrottle,
      dt,
      this.input.manualGear,
      ENGINE.finalDrive * this.geom.spec.finalDriveMult,
    );
    if (this.damage.engine <= 0.08) {
      engineOut = { wheelForce: 0, rpm: Math.max(0, this.lastRpm - 900 * dt), gear: 0 };
      this.damage.stoppedCause = 'collision';
    }
    this.lastRpm = engineOut.rpm;
    this.lastGear = engineOut.gear;
    const engineHealthMult = 0.38 + this.damage.engine * 0.62;
    const rangeMult = this.drivetrain.transferCase === '4l' ? this.geom.spec.lowRangeRatio : 1;
    // engine.ts returns torque-shaped values. The final scale preserves the
    // approved acceleration after removing the collider's accidental mass.
    const drivePerWheelTorque = engineOut.wheelForce * this.geom.powerMult
      * engineHealthMult * rangeMult * VEHICLE.massPropertyDriveScale;
    this.debugDriveTorque = drivePerWheelTorque;

    // Incline assist (matches legacy semantics).
    const climb = Math.min(0.5, Math.max(0, fwd.y));
    const inclineMult = 1 + (climb / 0.5) * TUNING.inclineAssistMax;

    // 5. Diff lock equalisation (per axle, before slip).
    if (this.geom.spec.drivetrain !== 'fixed-rwd' && (TUNING.diffLockFront || this.drivetrain.frontLocked)) {
      const a = this.wheels[0]!, b = this.wheels[1]!;
      const avg = 0.5 * (a.angVel + b.angVel);
      a.angVel = avg; b.angVel = avg;
    }
    if (this.geom.spec.drivetrain !== 'fixed-rwd' && (TUNING.diffLockRear || this.drivetrain.rearLocked)) {
      const a = this.wheels[2]!, b = this.wheels[3]!;
      const avg = 0.5 * (a.angVel + b.angVel);
      a.angVel = avg; b.angVel = avg;
    } else if (this.geom.spec.rearDiffCoupling > 0) {
      const a = this.wheels[2]!, b = this.wheels[3]!;
      [a.angVel, b.angVel] = coupleLimitedSlip(a.angVel, b.angVel, this.geom.spec.rearDiffCoupling);
    }

    // 6. Per wheel tire forces + spin integration.
    const driveSplit = transferCaseDriveSplit(this.drivetrain.transferCase);
    const frontShare = driveSplit.front;
    const rearShare = driveSplit.rear;
    // A transfer-case low range changes the ratio for the whole driveline,
    // not just the tyre that happens to be touching the ledge. Boosting only
    // the front contact produced a large upward force with too little rear
    // push: the wall reaction sent the truck backwards and the nose kicked
    // up. Keeping all driven wheels in the same crawl ratio lets the rear
    // axle push the front hubs over the edge while the front tread climbs it.
    if (ledgeContacts.some((contact, index) => contact !== null && (ledgeSemantics[index]?.treadFraction ?? 0) > 0)) {
      this.ledgeCrawlTicks = LEDGE_CONTACT.crawlHoldTicks;
    } else if (this.ledgeCrawlTicks > 0) {
      this.ledgeCrawlTicks--;
    }
    const crawlActive = this.ledgeCrawlTicks > 0;
    const crawlRatio = crawlActive ? LEDGE_CONTACT.crawlTorqueMultiplier : 1;
    if (this.drivetrain.transferCase === '4l' && Math.abs(longSpeed) > this.geom.spec.lowRangeMaxSpeed) {
      const overspeed = Math.abs(longSpeed) - this.geom.spec.lowRangeMaxSpeed;
      const governorForce = Math.min(14_000, overspeed * 5_000);
      const sign = Math.sign(longSpeed);
      this.body.addForce({
        x: -fwd.x * governorForce * sign,
        y: -fwd.y * governorForce * sign,
        z: -fwd.z * governorForce * sign,
      }, true);
    }
    if (crawlActive && Math.abs(longSpeed) > LEDGE_CONTACT.crawlMaxSpeed) {
      const overspeed = Math.abs(longSpeed) - LEDGE_CONTACT.crawlMaxSpeed;
      const governorForce = Math.min(
        LEDGE_CONTACT.crawlMaxBrakeForce,
        overspeed * LEDGE_CONTACT.crawlSpeedDamping,
      );
      const sign = Math.sign(longSpeed);
      const sf = this._scratchForce;
      sf.x = -fwd.x * governorForce * sign;
      sf.y = -fwd.y * governorForce * sign;
      sf.z = -fwd.z * governorForce * sign;
      this.body.addForce(sf, true);
    }
    if (crawlActive) {
      const pitchRate = av.x * right.x + av.y * right.y + av.z * right.z;
      const pitchTorque = clamp(
        LEDGE_CONTACT.crawlPitchStiffness * fwd.y
          - LEDGE_CONTACT.crawlPitchDamping * pitchRate,
        -LEDGE_CONTACT.crawlMaxPitchTorque,
        LEDGE_CONTACT.crawlMaxPitchTorque,
      );
      const sf = this._scratchForce;
      sf.x = right.x * pitchTorque;
      sf.y = right.y * pitchTorque;
      sf.z = right.z * pitchTorque;
      this.body.addTorque(sf, true);
    }

    // A locked wheel is a tangential contact constraint, not merely a wheel
    // whose angular velocity happens to be zero. Split the chassis mass among
    // the braked contact patches by normal load so the solver below can drive
    // their patch velocity to zero and cancel gravity along the slope. The
    // previous wheel-inertia-only force allowed a constant downhill creep:
    // gravity first had to create slip before the tyre produced any reaction.
    let supportedNormalLoadTotal = 0;
    let brakedNormalLoadTotal = 0;
    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const isFront = wIdx < 2;
      const isBraked = this.input.brake > 0
        || (!isFront && this.input.handbrake > 0);

      const w = this.wheels[wIdx]!;
      const basis = wheelBases[wIdx]!;
      const ledge = ledgeContacts[wIdx];
      const ledgeFrame = ledge
        ? contactFrame(ledge.normal, basis.axle, basis.forward)
        : null;
      let contactLoad = 0;
      const ledgeTreadFraction = ledgeSemantics[wIdx]?.treadFraction ?? 0;
      if (ledge && ledgeFrame && ledgeTreadFraction > 0) {
        contactLoad = Math.max(
          LEDGE_CONTACT.minHookNormalLoad,
          ledgeLoads[wIdx]!,
        );
      } else if (w.contact) {
        contactLoad = Math.max(WHEEL.minNormalLoad, w.lastForce ?? 0);
      }
      supportedNormalLoadTotal += contactLoad;
      if (isBraked) brakedNormalLoadTotal += contactLoad;
    }
    const vehicleMass = VEHICLE.mass * this.geom.massMult;
    const staticLateralHold = this._scratchStaticLateralHold;
    staticLateralHold.x = 0;
    staticLateralHold.y = 0;
    staticLateralHold.z = 0;

    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const w = this.wheels[wIdx]!;
      const debug = this.wheelDebug[wIdx]!;
      const isFront = wIdx < 2;
      const axle = isFront ? this.axles[0]! : this.axles[1]!;
      const ag = axle.geom;

      const basis = wheelBases[wIdx]!;

      const driveShare = (isFront ? frontShare : rearShare) * 0.5; // per wheel
      const driveTq = ag.hasDrive ? drivePerWheelTorque * driveShare : 0;
      const brakeForceN =
        this.input.brake * TUNING.brakeForce
        + (isFront ? 0 : this.input.handbrake * TUNING.brakeForce * 1.5);
      const brakeTq = brakeForceN * this.geom.wheelRadius;

      // Surface-dependent rolling resistance. Mud and deep mud provide
      // significantly more drag than hard surfaces.
      let rollingMult = 1.0;
      if (w.surface === Surface.Mud) rollingMult = TUNING.rollingResistanceMudMult;
      else if (w.surface === Surface.DeepMud) rollingMult = TUNING.rollingResistanceDeepMudMult;
      // Wading is heavy. Additive on top of the bed's own resistance, so
      // a submerged mud bog is worse than either alone.
      if (w.waterDepth > 0) {
        rollingMult += (WATER.wheelDragMult - 1) * wheelSubmersion(w.waterDepth, this.geom.wheelRadius);
      }
      const rollingResistance = WHEEL.rollingResistance * TUNING.rollingResistanceMult * rollingMult
        * this.geom.spec.rollingResistanceMult;

      // Pick one torque-transmitting patch. A steep tyre-volume contact
      // takes priority so drive torque acts up its tangent; the support ray
      // still supplies suspension force but must not transmit the same drive
      // torque a second time. A pure sidewall contact has no rolling frame
      // and therefore falls back to the support patch.
      let cp: Vec3;
      let tireLong: Vec3;
      let tireLat: Vec3;
      let surfMult: number;
      let normalLoad: number;
      let contactInclineMult: number;
      const appliedDriveTq = driveTq * crawlRatio;
      debug.driveTorque = appliedDriveTq;
      debug.brakeTorque = brakeTq;
      debug.groundTorque = 0;
      const ledge = ledgeContacts[wIdx];
      const ledgeFrame = ledge
        ? contactFrame(ledge.normal, basis.axle, basis.forward)
        : null;
      const treadFraction = ledgeSemantics[wIdx]?.treadFraction ?? 0;
      if (ledge && ledgeFrame && treadFraction > 0) {
        cp = ledge.point;
        tireLong = ledge.climbDirection ?? ledgeFrame.longitudinal;
        tireLat = ledgeFrame.lateral;
        surfMult = clamp(ledge.friction, 0, 2) * LEDGE_CONTACT.tractionMultiplier * treadFraction;
        normalLoad = Math.max(LEDGE_CONTACT.minHookNormalLoad, ledgeLoads[wIdx]!);
        // Incline assist compensates suspension load loss on long slopes. A
        // wall contact has its own constraint load and must not receive it.
        contactInclineMult = 1;
      } else if (w.contact) {
        const supportFrame = contactFrame(w.contactNormal, basis.axle, basis.forward);
        cp = w.contactPoint;
        tireLong = supportFrame?.longitudinal ?? basis.forward;
        tireLat = supportFrame?.lateral ?? basis.axle;
        surfMult = w.supportGrip * w.treadFraction;
        normalLoad = Math.max(WHEEL.minNormalLoad, w.lastForce ?? 0);
        contactInclineMult = 1 + (inclineMult - 1) * w.treadFraction;
      } else {
        // No torque-transmitting patch on a free wheel.
        debug.driveTorque = 0;
        debug.contact = false;
        debug.surface = w.surface;
        debug.waterDepth = w.waterDepth;
        debug.normalLoad = 0;
        debug.gripCoefficient = 0;
        debug.gripLimit = 0;
        debug.longitudinalForce = 0;
        debug.lateralForce = 0;
        debug.force.x = 0;
        debug.force.y = 0;
        debug.force.z = 0;
        debug.slipRatio = 0;
        debug.slipAngle = 0;
        debug.utilization = 0;
        debug.suspensionCompression = Math.max(0, w.resolvedDepth);
        debug.contactZone = w.contactZone;
        debug.treadFraction = w.treadFraction;
        debug.suspensionAxisAlignment = w.suspensionAxisAlignment;
        debug.carcassDeflection = w.tireDeflection;
        debug.suspensionForce = w.suspensionForce;
        debug.carcassForce = w.carcassForce;
        integrateWheelSpin(w, appliedDriveTq, brakeTq, 0, dt);
        debug.angularVelocity = w.angVel;
        continue;
      }

      // Velocity of the chassis at the selected contact point.
      const armX = cp.x - t.x;
      const armY = cp.y - t.y;
      const armZ = cp.z - t.z;
      const cvX = lv.x + av.y * armZ - av.z * armY;
      const cvY = lv.y + av.z * armX - av.x * armZ;
      const cvZ = lv.z + av.x * armY - av.y * armX;
      const longV = cvX * tireLong.x + cvY * tireLong.y + cvZ * tireLong.z;
      const latV = cvX * tireLat.x + cvY * tireLat.y + cvZ * tireLat.z;

      const axleGripMult = isFront ? TUNING.frontGripMult : TUNING.rearGripMult;
      const longGripCap =
        TIRE_LONG_FRICTION * TUNING.tireLongGripMult
        * surfMult * axleGripMult * contactInclineMult * normalLoad;

      // Friction circle (elliptical) coupling. We compute the forces
      // needed for zero longitudinal slip and zero lateral velocity,
      // then clamp the combined vector to the available friction limit.
      // This ensures that spinning the wheels (high longitudinal force)
      // reduces the available lateral grip, making the car slide — the
      // essential "drifting in mud" or "power-sliding" feel.
      const groundAngVel = longV / this.geom.wheelRadius;
      const neededTq = (groundAngVel - w.angVel) * WHEEL.inertia / dt;
      let rawLongForce = -neededTq / this.geom.wheelRadius;
      if (brakeForceN > 0 && brakedNormalLoadTotal > 1e-6) {
        const supportedMass = vehicleMass * normalLoad / brakedNormalLoadTotal;
        // Predict the contact's free velocity after gravity, then request the
        // force that makes it zero this tick. Brake torque and tyre grip are
        // independent caps: the former is applied here and the friction
        // circle below applies the latter.
        const freeLongAccel = GRAVITY_Y * tireLong.y;
        rawLongForce = clamp(
          -supportedMass * (longV / dt + freeLongAccel),
          -brakeForceN,
          brakeForceN,
        );
      }
      // Slip-angle shaping of lateral force. The base lateral force is
      // linear in lateral slip SPEED (responsive turn-in), but without a
      // slip-angle curve the tyre never loses lateral grip — the car
      // can't power-oversteer or drift. lateralGripFromSlipAngle stays
      // at 1.0 up to slipAnglePeak (linear cornering region, full
      // stiffness), then decays so a sliding tyre lets the tail step
      // out. The friction-circle clamp below still couples long+lat, so
      // wheelspin (high longitudinal force) ALSO steals lateral grip —
      // the "throttle oversteer in mud" feel.
      const alpha = slipAngle(latV, longV);
      const latGripMult = lateralGripFromSlipAngle(alpha);
      // A force directly proportional to patch velocity is a discrete
      // damper. At walking pace the full cornering stiffness can reverse the
      // patch velocity before the next 60 Hz sample; all four tyres then ask
      // for the opposite full-grip correction and settle into a left/right
      // limit cycle. Ramp the dynamic branch in with road speed, retaining a
      // quarter-stiffness floor so slow steering still has useful authority.
      // The static constraint below owns the near-rest range, while normal
      // trail/road speeds reach the exact configured stiffness.
      const dynamicStiffnessScale = Math.max(0.25, smoothstep(
        TIRE_LATERAL.staticHoldSpeed,
        TIRE_LATERAL.slipAngleVelFloor,
        groundSpeed,
      ));
      const dynamicLatForce = -TUNING.tireLatStiffness * dynamicStiffnessScale
        * latV * latGripMult;

      // Dynamic lateral stiffness cannot hold a true rest state: its force is
      // zero at latV=0, so gravity first creates sideways velocity and the
      // tyre settles into a small non-zero creep. At chassis speeds below the
      // release threshold, blend toward the chassis-level force needed to
      // cancel lateral translation and gravity projected along the tyre's
      // lateral tangent. Using chassis velocity here avoids trying to cancel
      // every wheel-end's roll velocity in one tick, which over-constrains the
      // suspension. The friction circle below remains the final authority: a
      // steep slope, mud, water-unloaded tyre, or simultaneous drive force can
      // still exceed available grip and slide naturally.
      const staticBlend = 1 - smoothstep(
        TIRE_LATERAL.staticHoldSpeed,
        TIRE_LATERAL.staticReleaseSpeed,
        groundSpeed,
      );
      const supportedMass = supportedNormalLoadTotal > 1e-6
        ? vehicleMass * normalLoad / supportedNormalLoadTotal
        : 0;
      const chassisLatV = lv.x * tireLat.x + lv.y * tireLat.y + lv.z * tireLat.z;
      const gravityLatAccel = GRAVITY_Y * tireLat.y;
      const staticTargetLatForce = -supportedMass
        * (chassisLatV / dt + gravityLatAccel);
      const rawStaticLatForce = (staticTargetLatForce - dynamicLatForce)
        * staticBlend;
      const rawLatForce = dynamicLatForce + rawStaticLatForce;

      let finalLongForce = 0;
      let finalLatForce = 0;

      if (longGripCap > 1e-6) {
        const longMax = longGripCap;
        const latMax = longGripCap * TUNING.tireLateralGripRatio;
        const longNorm = rawLongForce / longMax;
        const latNorm = rawLatForce / latMax;
        const combined = Math.sqrt(longNorm * longNorm + latNorm * latNorm);

        if (combined > 1) {
          finalLongForce = rawLongForce / combined;
          finalLatForce = rawLatForce / combined;
        } else {
          finalLongForce = rawLongForce;
          finalLatForce = rawLatForce;
        }
      }

      // The rest-constraint portion is assembled from per-tyre grip budgets.
      // Applying it at every ground patch would add the same roll moment on
      // every tick and keep a parked chassis
      // rotating into the slope. Preserve the friction-circle scaling, remove
      // only that holding share from the patch force, and apply its resultant
      // centrally after all wheels have been solved. Dynamic lateral force
      // remains at each patch, so normal steering/yaw/roll behavior is
      // unchanged once the vehicle is moving.
      const lateralScale = Math.abs(rawLatForce) > 1e-8
        ? finalLatForce / rawLatForce
        : 0;
      const staticLatForce = rawStaticLatForce * lateralScale;
      const contactLatForce = finalLatForce - staticLatForce;
      staticLateralHold.x += tireLat.x * staticLatForce;
      staticLateralHold.y += tireLat.y * staticLatForce;
      staticLateralHold.z += tireLat.z * staticLatForce;

      if (ledge?.climbDirection && ledgeFrame && treadFraction > 0) {
        const targetClimbSpeed = Math.min(
          LEDGE_CONTACT.edgeMotorMaxSpeed,
          Math.max(0, w.angVel) * this.geom.wheelRadius,
        );
        const motorForce = clamp(
          (targetClimbSpeed - longV)
            * (VEHICLE.mass * this.geom.massMult)
            * LEDGE_CONTACT.edgeMotorMassFraction
            / dt,
          -LEDGE_CONTACT.edgeMotorMaxForce,
          LEDGE_CONTACT.edgeMotorMaxForce,
        );
        finalLongForce = clamp(
          finalLongForce + motorForce,
          -longGripCap,
          longGripCap,
        );
      }

      const wheelSurfaceSpeed = w.angVel * this.geom.wheelRadius;
      const slipDenom = Math.max(0.5, Math.abs(longV), Math.abs(wheelSurfaceSpeed));
      const longMax = longGripCap;
      const latMax = longGripCap * TUNING.tireLateralGripRatio;
      const utilization = longMax > 1e-6 && latMax > 1e-6
        ? Math.min(1, Math.hypot(finalLongForce / longMax, finalLatForce / latMax))
        : 0;
      debug.contact = true;
      debug.contactPoint.x = cp.x;
      debug.contactPoint.y = cp.y;
      debug.contactPoint.z = cp.z;
      const contactNormal = ledge?.normal ?? w.contactNormal;
      debug.contactNormal.x = contactNormal.x;
      debug.contactNormal.y = contactNormal.y;
      debug.contactNormal.z = contactNormal.z;
      debug.surface = w.surface;
      debug.waterDepth = w.waterDepth;
      debug.normalLoad = normalLoad;
      debug.gripCoefficient = normalLoad > 1e-6 ? longGripCap / normalLoad : 0;
      debug.gripLimit = longGripCap;
      debug.longitudinalForce = finalLongForce;
      debug.lateralForce = finalLatForce;
      // This is the force applied at the patch. The low-speed static holding
      // share is applied centrally below, so it is intentionally absent from
      // the world arrow even though it still consumes the tire budget above.
      debug.force.x = tireLong.x * finalLongForce + tireLat.x * contactLatForce;
      debug.force.y = tireLong.y * finalLongForce + tireLat.y * contactLatForce;
      debug.force.z = tireLong.z * finalLongForce + tireLat.z * contactLatForce;
      debug.slipRatio = (wheelSurfaceSpeed - longV) / slipDenom;
      debug.slipAngle = alpha;
      debug.utilization = utilization;
      debug.suspensionCompression = Math.max(0, w.resolvedDepth);
      debug.contactZone = w.contactZone;
      debug.treadFraction = w.treadFraction;
      debug.suspensionAxisAlignment = w.suspensionAxisAlignment;
      debug.carcassDeflection = w.tireDeflection;
      debug.suspensionForce = w.suspensionForce;
      debug.carcassForce = w.carcassForce;

      // Update wheel angular velocity using the force actually transmitted
      // through the contact patch (impulse-clamped integration).
      const finalGroundTq = -finalLongForce * this.geom.wheelRadius;
      debug.groundTorque = finalGroundTq;
      integrateWheelSpin(w, appliedDriveTq, brakeTq, finalGroundTq, dt, rollingResistance);
      debug.angularVelocity = w.angVel;
      if (ledge && ledgeFrame) {
        w.ledgeLongForce = finalLongForce;
      }

      // Apply combined tire force to chassis at contact point.
      const f = this._scratchForce;
      f.x = tireLong.x * finalLongForce + tireLat.x * contactLatForce;
      f.y = tireLong.y * finalLongForce + tireLat.y * contactLatForce;
      f.z = tireLong.z * finalLongForce + tireLat.z * contactLatForce;
      const forcePoint = ledge && ledgeFrame
        ? scaledMomentPoint(t, cp, LEDGE_CONTACT.chassisMomentArmScale)
        : cp;
      this.body.addForceAtPoint(f, forcePoint, true);
    }
    if (
      Math.abs(staticLateralHold.x) > 1e-8
      || Math.abs(staticLateralHold.y) > 1e-8
      || Math.abs(staticLateralHold.z) > 1e-8
    ) {
      this.body.addForce(staticLateralHold, true);
    }
  }

  postStep(): void {
    const lv = this.body.linvel();
    const groundSpeed = Math.hypot(lv.x, lv.z);
    const STATIONARY = 0.3;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]!;
      if (groundSpeed < STATIONARY && Math.abs(w.angVel) < 1.0) continue;
      w.spin += w.angVel * FIXED_DT;
    }
    let strongestImpulse = 0;
    let strongestPoint: Vec3 | null = null;
    this.world.world.contactPairsWith(this.chassis, (other) => {
      this.world.world.contactPair(this.chassis, other, (manifold, flipped) => {
        for (let i = 0; i < manifold.numContacts(); i++) {
          const impulse = Math.abs(manifold.contactImpulse(i));
          if (impulse <= strongestImpulse) continue;
          const point = flipped
            ? manifold.localContactPoint2(i)
            : manifold.localContactPoint1(i);
          if (!point) continue;
          strongestImpulse = impulse;
          strongestPoint = { x: point.x, y: point.y, z: point.z };
        }
      });
    });
    if (strongestPoint) {
      applyCollisionDamage(this.damage, {
        impulse: strongestImpulse,
        localPoint: strongestPoint,
        chassisHalfExtents: this.geom.chassisHalfExtents,
        approach: Math.min(1, this.impactSpeed / 10),
      }, this.geom.spec.damageResistance, this.geom.spec.bullbarEngineProtection);
    }
    // Visual axle pose (rideY/rollAngle) is left at the value preStep
    // computed from the pre-integration body pose. The previous
    // implementation re-cast 4 rays per vehicle here so the axle visual
    // matched the post-integration chassis pose; that cost ~480 raycasts
    // per second per player and was the dominant server tick overrun
    // when load was high. Trade-off: at 60 Hz the wheels visually trail
    // the chassis by one tick (~4-5 mm at typical spring frequencies) -
    // not noticeable on a moving chassis, dwarfed by camera motion.
  }

  getState(): VehicleState {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const wheels: WheelState[] = [];
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]!;
      const axle = i < 2 ? this.axles[0]! : this.axles[1]!;
      const susp = Math.max(0, axle.geom.suspensionRestLength - w.resolvedDepth);
      wheels.push({
        steer: i < 2 ? this.currentSteer : 0,
        spin: w.spin,
        contact: w.contact || (w.ledgeContact && w.treadFraction > 0),
        suspensionLength: susp,
        angVel: w.angVel,
        tireDeflection: w.tireDeflection,
        tireContactNormal: worldNormalToLocal(w.tireContactNormal, r),
      });
    }
    const aFront = this.axles[0]!;
    const aRear = this.axles[1]!;
    return {
      position: { x: t.x, y: t.y, z: t.z },
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      linVel: { x: lv.x, y: lv.y, z: lv.z },
      angVel: { x: av.x, y: av.y, z: av.z },
      rpm: this.lastRpm,
      gear: this.lastGear,
      throttle: this.input.throttle,
      drivetrain: { ...this.drivetrain },
      damage: { ...this.damage },
      wheels,
      axles: [
        { rideY: aFront.rideY, rollAngle: aFront.rollAngle },
        { rideY: aRear.rideY, rollAngle: aRear.rollAngle },
      ],
    };
  }

  /** Water state as of the last preStep, for the HUD and the renderer.
   *
   *  Deliberately not on VehicleState and not on the wire: a drowned
   *  engine already reads as rpm 0 / gear 0 through the existing tuple,
   *  and a remote truck's spray can be derived from its transmitted
   *  position against the water height both ends compute from the same
   *  map document. Adding a field would have cost a SNAPSHOT_SCHEMA bump
   *  for information both sides already have. */
  waterStatus(): WaterStatus {
    return {
      submerged: this.waterLoad.submergedFrac,
      wheelDepths: [
        this.wheels[0]!.waterDepth, this.wheels[1]!.waterDepth,
        this.wheels[2]!.waterDepth, this.wheels[3]!.waterDepth,
      ],
      intakeSubmerged: this.waterLoad.intakeSubmerged,
      // The latched engine flag, not waterLoad.drowned. That one is the
      // momentary "the intake has been under for drownTicks" trigger and
      // goes false the instant you surface — which would clear the HUD's
      // restart prompt while the engine was still dead, and would report
      // a drowned truck as healthy the moment it was towed out.
      drowned: this.engine.drowned,
      flood: this.water.floodFrac,
    };
  }

  debugTelemetry(): VehicleDebugTelemetry {
    const t = this.body.translation();
    const r = this.body.rotation();
    const comLocal = this.geom.spec.centerOfMass;
    const comOffset = rotateVecByQuat(comLocal, r);
    const comWorld = {
      x: t.x + comOffset.x,
      y: t.y + comOffset.y,
      z: t.z + comOffset.z,
    };
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, r);
    const fwd = rotateVecByQuat({ x: 0, y: 0, z: 1 }, r);
    const right = rotateVecByQuat({ x: 1, y: 0, z: 0 }, r);
    const lv = this.body.linvel();
    const av = this.body.angvel();
    let supportY = 0;
    let supportCount = 0;
    for (const wheel of this.wheelDebug) {
      if (!wheel.contact) continue;
      supportY += wheel.contactPoint.y;
      supportCount++;
    }
    supportY = supportCount > 0
      ? supportY / supportCount
      : t.y - this.geom.chassisHalfExtents.y - this.geom.wheelRadius;
    const comHeight = Math.max(0.1, comWorld.y - supportY);
    const halfTrack = Math.min(this.geom.front.trackHalf, this.geom.rear.trackHalf);
    const pitchLever = Math.max(0.1, this.geom.spec.wheelbase * 0.5 - Math.abs(comLocal.z));
    let buoyancyY = 0;
    let buoyancyPointX = 0;
    let buoyancyPointY = 0;
    let buoyancyPointZ = 0;
    for (const sample of this.waterLoad.samples) {
      const weight = Math.max(0, sample.force.y);
      buoyancyY += weight;
      buoyancyPointX += sample.point.x * weight;
      buoyancyPointY += sample.point.y * weight;
      buoyancyPointZ += sample.point.z * weight;
    }
    const buoyancyPoint = buoyancyY > 1e-6 ? {
      x: buoyancyPointX / buoyancyY,
      y: buoyancyPointY / buoyancyY,
      z: buoyancyPointZ / buoyancyY,
    } : { ...this.waterLoad.dragPoint };
    const gravity = Math.abs(GRAVITY_Y);

    return {
      position: { x: t.x, y: t.y, z: t.z },
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      centerOfMassLocal: { ...comLocal },
      centerOfMassWorld: comWorld,
      massKg: this.geom.spec.massKg,
      wheelbase: this.geom.spec.wheelbase,
      track: halfTrack * 2,
      wheelRadius: this.geom.wheelRadius,
      rollAngle: Math.atan2(-right.y, Math.max(1e-6, up.y)),
      pitchAngle: Math.atan2(fwd.y, Math.hypot(fwd.x, fwd.z)),
      staticRollLimit: Math.atan2(halfTrack, comHeight),
      staticPitchLimit: Math.atan2(pitchLever, comHeight),
      linearVelocity: { x: lv.x, y: lv.y, z: lv.z },
      angularVelocity: { x: av.x, y: av.y, z: av.z },
      accelerationWorld: { ...this.debugAcceleration },
      longitudinalG: (this.debugAcceleration.x * fwd.x + this.debugAcceleration.y * fwd.y + this.debugAcceleration.z * fwd.z) / gravity,
      lateralG: (this.debugAcceleration.x * right.x + this.debugAcceleration.y * right.y + this.debugAcceleration.z * right.z) / gravity,
      yawRate: av.x * up.x + av.y * up.y + av.z * up.z,
      driveline: {
        rpm: this.lastRpm,
        gear: this.lastGear,
        throttle: this.input.throttle,
        transferCase: this.drivetrain.transferCase,
        frontLocked: this.drivetrain.frontLocked,
        rearLocked: this.drivetrain.rearLocked,
        outputTorque: this.debugDriveTorque,
      },
      water: {
        submerged: this.waterLoad.submergedFrac,
        buoyancyForce: { x: 0, y: buoyancyY, z: 0 },
        buoyancyPoint,
        dragForce: { ...this.waterLoad.drag },
        dragPoint: { ...this.waterLoad.dragPoint },
        dragTorque: { ...this.waterLoad.dragTorque },
      },
      wheels: this.wheelDebug.map((wheel) => ({
        ...wheel,
        contactPoint: { ...wheel.contactPoint },
        contactNormal: { ...wheel.contactNormal },
        force: { ...wheel.force },
        suspensionOrigin: { ...wheel.suspensionOrigin },
        suspensionEnd: { ...wheel.suspensionEnd },
        wheelCenter: { ...wheel.wheelCenter },
      })) as VehicleDebugTelemetry['wheels'],
    };
  }

  axleSnaps(): [AxleSnap, AxleSnap] {
    return [axleSnap(this.axles[0]!), axleSnap(this.axles[1]!)];
  }

  applyAxleSnaps(snaps: [AxleSnap, AxleSnap]): void {
    applyAxleSnap(this.axles[0]!, snaps[0]);
    applyAxleSnap(this.axles[1]!, snaps[1]);
  }

  repair(): void {
    repairDamage(this.damage);
    this.engine = createEngineState();
    this.lastRpm = this.engine.rpm;
    this.lastGear = 0;
    resetWaterState(this.water);
  }

  damageStatus(): VehicleDamageState {
    return { ...this.damage };
  }

  drivetrainStatus(): DrivetrainState {
    return { ...this.drivetrain };
  }

  consumeDrivetrainNotice(): string | null {
    const notice = this.drivetrainNotice;
    this.drivetrainNotice = null;
    return notice;
  }

  private updateDrivetrainControls(speed: number): void {
    if (this.geom.spec.drivetrain === 'fixed-rwd') {
      const rising = this.input.buttons & ~this.lastButtons;
      this.lastButtons = this.input.buttons;
      this.drivetrain.transferCase = '2h';
      this.drivetrain.frontLocked = false;
      this.drivetrain.rearLocked = false;
      if ((this.input.transferCase !== null && this.input.transferCase !== '2h')
        || (rising & (BUTTON_RANGE | BUTTON_REAR_LOCKER | BUTTON_FRONT_LOCKER)) !== 0) {
        this.drivetrainNotice = 'RWD · fixed high range';
      }
      return;
    }
    if (this.drivetrain.frontLocked && speed > 7.5) {
      this.drivetrain.frontLocked = false;
      this.drivetrainNotice = 'Front locker disengaged above its safe speed.';
    }
    if (this.drivetrain.rearLocked && speed > 14) {
      this.drivetrain.rearLocked = false;
      this.drivetrainNotice = 'Rear locker disengaged above its safe speed.';
    }
    const rising = this.input.buttons & ~this.lastButtons;
    this.lastButtons = this.input.buttons;
    const canShift = speed <= DRIVETRAIN_CHANGE_MAX_SPEED
      && Math.abs(this.input.throttle) < 0.18;
    const requestedTransfer = this.input.transferCase
      ?? ((rising & BUTTON_RANGE) !== 0 ? nextTransferCase(this.drivetrain.transferCase) : null);
    if (requestedTransfer !== null && requestedTransfer !== this.drivetrain.transferCase) {
      if (!canShift) this.drivetrainNotice = 'Slow to 20 km/h or less and release the throttle to move the transfer case.';
      else this.drivetrain.transferCase = requestedTransfer;
    }
    if ((rising & BUTTON_REAR_LOCKER) !== 0) {
      if (!this.build.rearLocker) this.drivetrainNotice = 'Fit a rear locker in the workshop first.';
      else if (this.drivetrain.rearLocked) this.drivetrain.rearLocked = false;
      else if (!canShift) this.drivetrainNotice = 'Slow to 20 km/h or less and release the throttle to engage the rear locker.';
      else this.drivetrain.rearLocked = true;
    }
    if ((rising & BUTTON_FRONT_LOCKER) !== 0) {
      if (!this.build.frontLocker) this.drivetrainNotice = 'Fit a front locker in the workshop first.';
      else if (this.drivetrain.frontLocked) this.drivetrain.frontLocked = false;
      else if (!canShift) this.drivetrainNotice = 'Slow to 20 km/h or less and release the throttle to engage the front locker.';
      else this.drivetrain.frontLocked = true;
    }
  }

  dispose(): void {
    this.world.world.removeRigidBody(this.body);
  }
}

/** Sweep the tyre's real cylinder down its suspension axis.
 *
 * A centre ray followed by `toi - radius` is only exact on a plane whose
 * normal is parallel to the suspension. At a crest or an abrupt gradient
 * change, the front/rear tread reaches the higher triangle first while the
 * centre ray still sees the lower one; that lets part (or all) of the visible
 * tyre pass through the heightfield. Shape casting accounts for the complete
 * rolling circumference and tyre width, while preserving the existing
 * software spring/solid-axle model.
 */
function castWheelSupport(
  world: World,
  ownBody: RAPIER.RigidBody,
  shape: RAPIER.Shape,
  rotation: { x: number; y: number; z: number; w: number },
  origin: Vec3,
  dir: Vec3,
  maxToi: number,
  restLength: number,
  wheelRadius: number,
  wheelHalfWidth: number,
  wheelAxle: Vec3,
  out: WheelKinematic,
): void {
  out.contactZone = 'air';
  out.treadFraction = 0;
  out.suspensionAxisAlignment = 0;
  // Keep the centre ray as the stable baseline on ordinary ground. Rapier's
  // cylinder normals contain small triangle-seam noise even on a perfectly
  // flat heightfield; applying those normals directly produces visible creep.
  castWheelRayFallback(
    world,
    ownBody,
    origin,
    dir,
    maxToi + wheelRadius,
    restLength,
    wheelRadius,
    out,
  );
  if (out.contact) {
    const semantics = classifyTireContact(
      out.contactNormal.x * wheelAxle.x
      + out.contactNormal.y * wheelAxle.y
      + out.contactNormal.z * wheelAxle.z,
    );
    const approach = Math.max(0, -(
      out.contactNormal.x * dir.x
      + out.contactNormal.y * dir.y
      + out.contactNormal.z * dir.z
    ));
    if (semantics.treadFraction <= 0 || approach < 0.25) {
      out.contact = false;
      out.contactDepth = 0;
    } else {
      out.contactZone = semantics.zone;
      out.treadFraction = semantics.treadFraction;
      out.suspensionAxisAlignment = approach;
    }
  }

  const hit = world.world.castShape(
    origin,
    rotation,
    dir,
    shape,
    0,
    maxToi,
    true,
    undefined,
    COLLISION_GROUP_WHEEL_RAY,
    undefined,
    ownBody,
  );
  if (hit) {
    const center = {
      x: origin.x + dir.x * hit.time_of_impact,
      y: origin.y + dir.y * hit.time_of_impact,
      z: origin.z + dir.z * hit.time_of_impact,
    };
    const normal = hit.normal1;
    if (
      hit.collider.handle === world.terrainCollider.handle
      && normal.y >= SUSPENSION.terrainSupportMinNormalY
      && (
        !out.contact
        || restLength - hit.time_of_impact
          > out.contactDepth + SUSPENSION.volumeSupportMinAdvance
      )
      && (
        normal.x * dir.x
        + normal.y * dir.y
        + normal.z * dir.z
      ) < -0.05
    ) {
      // Rapier 0.14 exposes shape-cast witnesses in shape-local frames. Build
      // the world-space cylinder support point explicitly instead: radial
      // tread support plus the appropriate sidewall-cap offset.
      const axle = rotateVecByQuat({ x: 0, y: 1, z: 0 }, rotation);
      const axialDot = normal.x * axle.x + normal.y * axle.y + normal.z * axle.z;
      const radial = {
        x: normal.x - axle.x * axialDot,
        y: normal.y - axle.y * axialDot,
        z: normal.z - axle.z * axialDot,
      };
      const radialLength = Math.hypot(radial.x, radial.y, radial.z);
      const radialScale = radialLength > 1e-8 ? wheelRadius / radialLength : 0;
      const capScale = Math.sign(axialDot) * wheelHalfWidth;
      out.contact = true;
      out.contactDepth = restLength - hit.time_of_impact;
      out.contactPoint = {
        x: center.x - radial.x * radialScale - axle.x * capScale,
        y: center.y - radial.y * radialScale - axle.y * capScale,
        z: center.z - radial.z * radialScale - axle.z * capScale,
      };
      out.contactNormal = {
        x: normal.x,
        y: normal.y,
        z: normal.z,
      };
      out.supportIsTerrain = true;
      out.supportColliderFriction = hit.collider.friction();
      out.volumeSupport = true;
      const semantics = classifyTireContact(axialDot);
      const approach = Math.max(0, -(normal.x * dir.x + normal.y * dir.y + normal.z * dir.z));
      if (semantics.treadFraction <= 0 || approach < 0.25) {
        out.contact = false;
        out.contactDepth = 0;
        out.volumeSupport = false;
      } else {
        out.contactZone = semantics.zone;
        out.treadFraction = semantics.treadFraction;
        out.suspensionAxisAlignment = approach;
      }
      return;
    }
  }
}

function castWheelRayFallback(
  world: World,
  ownBody: RAPIER.RigidBody,
  origin: Vec3,
  dir: Vec3,
  maxToi: number,
  restLength: number,
  wheelRadius: number,
  out: WheelKinematic,
): void {
  out.volumeSupport = false;
  const ray = new world.rapier.Ray(origin, dir);
  let hit = world.world.castRayAndGetNormal(
    ray,
    maxToi,
    true,
    undefined,
    COLLISION_GROUP_WHEEL_RAY,
    undefined,
    ownBody,
  );
  // A pitched chassis-down ray can strike a vertical face before the ground
  // underneath the tyre. That face belongs to the volumetric contact path;
  // ignore its collider once and continue the support query behind it.
  if (hit && hit.normal.y < LEDGE_CONTACT.maxSupportNormalY) {
    const blockedCollider = hit.collider;
    const fallback = world.world.castRayAndGetNormal(
      ray,
      maxToi,
      true,
      undefined,
      COLLISION_GROUP_WHEEL_RAY,
      blockedCollider,
      ownBody,
    );
    hit = fallback && fallback.normal.y >= LEDGE_CONTACT.maxSupportNormalY
      ? fallback
      : null;
  }
  if (hit) {
    const toi = hit.timeOfImpact;
    out.contact = true;
    // Depth can be negative when the ground is below restLength (droop).
    out.contactDepth = restLength - (toi - wheelRadius);
    out.contactPoint = {
      x: origin.x + dir.x * toi,
      y: origin.y + dir.y * toi,
      z: origin.z + dir.z * toi,
    };
    out.contactNormal = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
    out.supportIsTerrain = hit.collider.handle === world.terrainCollider.handle;
    out.supportColliderFriction = hit.collider.friction();
  } else {
    out.contact = false;
    out.contactDepth = 0;
    out.contactPoint = {
      x: origin.x + dir.x * maxToi,
      y: origin.y + dir.y * maxToi,
      z: origin.z + dir.z * maxToi,
    };
    out.contactNormal = { x: 0, y: 1, z: 0 };
    out.supportIsTerrain = true;
    out.supportColliderFriction = 1;
  }
}

function wheelCenterWorld(
  bodyPosition: Vec3,
  bodyRotation: { x: number; y: number; z: number; w: number },
  axle: AxleState,
  localX: number,
): Vec3 {
  // Contact queries use the instantaneous geometric target. The public
  // rideY/rollAngle pose is damped for rendering and snapshots; feeding
  // that lag back into collision detection would make a wheel reach a
  // ledge later merely because its mesh is still catching up visually.
  const cr = Math.cos(axle.targetRollAngle);
  const sr = Math.sin(axle.targetRollAngle);
  const local = {
    x: localX * cr,
    y: axle.geom.centerLocalY - axle.geom.suspensionRestLength
      + axle.targetRideY + localX * sr,
    z: axle.geom.centerLocalZ,
  };
  return addVec(bodyPosition, rotateVecByQuat(local, bodyRotation));
}

function pointVelocityDot(
  linearVelocity: Vec3,
  angularVelocity: Vec3,
  bodyPosition: Vec3,
  point: Vec3,
  direction: Vec3,
): number {
  const armX = point.x - bodyPosition.x;
  const armY = point.y - bodyPosition.y;
  const armZ = point.z - bodyPosition.z;
  const vx = linearVelocity.x + angularVelocity.y * armZ - angularVelocity.z * armY;
  const vy = linearVelocity.y + angularVelocity.z * armX - angularVelocity.x * armZ;
  const vz = linearVelocity.z + angularVelocity.x * armY - angularVelocity.y * armX;
  return vx * direction.x + vy * direction.y + vz * direction.z;
}

function moveToward(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

function hasSuspensionSupport(
  wheel: WheelKinematic,
): boolean {
  return wheel.contact;
}

function worldNormalToLocal(
  normal: Vec3,
  rotation: { x: number; y: number; z: number; w: number },
): Vec3 {
  // Inverse rotation for a unit quaternion is its conjugate.
  return rotateVecByQuat(normal, {
    x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w,
  });
}

/** Analytic terrain fallback for a tyre lying on its side. Heightfield shape
 * contact queries are one-sided and may return no manifold once the cylinder
 * centre crosses below the surface; the support extent remains well-defined. */
function findTerrainSidewallContact(
  world: World,
  center: Vec3,
  axle: Vec3,
  radius: number,
  halfWidth: number,
  prediction: number,
): SteepWheelContact | null {
  const h = 0.08;
  const height = sampleHeightBilinear(world.terrain, center.x, center.z);
  const dx = (sampleHeightBilinear(world.terrain, center.x + h, center.z)
    - sampleHeightBilinear(world.terrain, center.x - h, center.z)) / (2 * h);
  const dz = (sampleHeightBilinear(world.terrain, center.x, center.z + h)
    - sampleHeightBilinear(world.terrain, center.x, center.z - h)) / (2 * h);
  const inv = 1 / (Math.hypot(dx, 1, dz) || 1);
  const normal = { x: -dx * inv, y: inv, z: -dz * inv };
  const axial = normal.x * axle.x + normal.y * axle.y + normal.z * axle.z;
  const semantics = classifyTireContact(axial);
  if (semantics.zone !== 'sidewall') return null;
  const extent = halfWidth * Math.abs(axial)
    + radius * Math.sqrt(Math.max(0, 1 - axial * axial));
  const distance = (center.y - height) * normal.y - extent;
  if (distance > prediction) return null;
  return {
    point: {
      x: center.x - normal.x * extent,
      y: center.y - normal.y * extent,
      z: center.z - normal.z * extent,
    },
    normal,
    climbDirection: null,
    climbTopY: null,
    distance,
    penetration: Math.max(0, -distance),
    friction: world.terrainCollider.friction(),
    timeOfImpact: 0,
  };
}

function scaledMomentPoint(origin: Vec3, point: Vec3, scale: number): Vec3 {
  return {
    x: origin.x + (point.x - origin.x) * scale,
    y: origin.y + (point.y - origin.y) * scale,
    z: origin.z + (point.z - origin.z) * scale,
  };
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function nextTransferCase(mode: TransferCaseMode): TransferCaseMode {
  if (mode === '2h') return '4h';
  if (mode === '4h') return '4l';
  return '2h';
}

function surfaceGrip(s: number, geom: VehicleGeom): number {
  // TUNING rather than SURFACE_FRICTION: the debug panel mutates the
  // former in place, and this is the reader that makes those sliders do
  // something.
  const key = surfaceInfo(s).friction;
  const compound = key === 'road' || key === 'concrete' ? geom.spec.grip.road
    : key === 'dirt' || key === 'grass' ? geom.spec.grip.dirt
    : key === 'gravel' ? geom.spec.grip.gravel
    : key === 'mud' ? geom.spec.grip.mud
    : geom.spec.grip.deepMud;
  return TUNING.surfaceFriction[key] * compound;
}
