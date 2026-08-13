// Custom solid-axle vehicle. Drops Rapier's DynamicRayCastVehicleController
// in favour of: chassis = Rapier RigidBody, two software AxleStates each
// with two software WheelKinematics, per-tick raycasts from chassis-fixed
// predicted beam wheel-centres to read terrain heights, then spring/damper forces
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
//   3. Exactly two predictor/corrector contact queries per axle, both solved
//      from the original tick state; commit only the second.
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
import {
  Surface, sampleHeightBilinear, sampleSurface, surfaceInfo,
  type SurfaceTractionSpec, type TerrainData,
} from './terrain.js';
import {
  computeWaterLoad, createWaterLoad, createWaterState, hasWater,
  resetWaterState, sampleWaterDepth, wetGripMult, wheelSubmersion,
  type WaterLoad, type WaterState,
} from './water.js';
import {
  createEngineState, stepEngine, stepEngineFlooding,
  type EngineOutput, type EngineState,
} from './engine.js';
// slipRatio / gripFromSlip kept in tire.ts for tests; not used here since
// the impulse-clamped integrator below replaced the Pacejka groundTq path.
// slipAngle / lateralGripFromSlipAngle ARE used to shape the lateral
// force so the tyre breaks loose past its slip-angle peak, and
// lateralGripFromLongitudinalSlip so a locked or spinning wheel gives up
// the cornering force it is no longer able to make.
import { rotateVecByQuat, rotateVecByQuatInto } from './util.js';
import {
  combineFrictionEllipse,
  lateralGripFromLongitudinalSlip,
  lateralGripFromSlipAngle,
  longitudinalGripFromSlip,
  relaxLongitudinalForce,
  slipAngle,
  tyreFrictionCapacity,
} from './tire.js';
import {
  SIDEWALL_RELEASE_RATE,
  carcassRatesInto,
  classifyTireContactInto,
  pressureEdgeWrapScale,
  pressureLateralScale,
  pressureRadialScale,
  pressureRollingScale,
  sealedRoadPressureGripScale,
  solveSeriesComplianceInto,
  solveSidewallConstraintInto,
  type CarcassRates,
  type SeriesSpringResult,
  type SidewallConstraintResult,
  type TireContactSemantics,
} from './tireCarcass.js';
import { geomFor, type AxleGeom, type VehicleGeom } from './vehicleGeom.js';
import {
  applyAxleSnap,
  applyTravelStopReactionToAxle,
  axleSnap,
  computeAntiRollLoadTransfer,
  createAxleState,
  progressiveTravelStopForce,
  resetAxleState,
  stepAxle,
  type AntiRollLoadInput,
  type AntiRollLoadTransfer,
  type AxleSnap,
  type AxleState,
  type StepAxleInputs,
} from './axle.js';
import {
  createWheelKinematic,
  integrateWheelSpin,
  resetWheelKinematic,
  type WheelKinematic,
} from './wheelDynamics.js';
import {
  differentialCarrierSpeed,
  drivenCarrierSpeed,
  solveCenterTransferImpulse,
  solveDifferentialAngularImpulse,
} from './differential.js';
import { stepSoftGround } from './soil.js';
import type {
  ExternalPointLoad,
  VehicleDebugTelemetry,
  VehicleLike,
  VehicleSpawn,
  WaterStatus,
  PressureStatus,
  WheelDebugTelemetry,
} from './vehicleTypes.js';
import type { World } from './world.js';
import { COLLISION_GROUP_OWNED_VEHICLE, COLLISION_GROUP_WHEEL_RAY } from './collisionGroups.js';
import {
  contactFrameInto,
  createSteepWheelContact,
  cylinderRotationInto,
  findHeightfieldLedgeContactInto,
  findSteepWheelContactInto,
  wheelBasisInto,
  type ContactQuat,
  type SteepWheelContact,
  type WheelBasis,
  type WheelContactFrame,
} from './wheelContact.js';
import { applyCollisionDamage, createDamageState, repairDamage } from './damage.js';

type Vec3 = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };

/** The one chassis capture every phase reads, plus the handful of scalars
 *  phases hand forward to later phases. The vectors are written in place by
 *  `captureStepContext`; the scalars are written by the phase named beside
 *  them and are read-only to everything downstream. */
interface VehicleStepContext {
  readonly dt: number;
  readonly t: Vec3;
  readonly r: Quat;
  readonly lv: Vec3;
  readonly av: Vec3;
  readonly fwd: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  /** phaseBegin -> phaseTyreSoil */
  groundSpeed: number;
  /** phaseEngine -> phaseDriveline, phaseTyreSoil */
  totalDrivelineTorque: number;
  /** phaseDriveline -> phaseTyreSoil */
  frontShare: number;
  rearShare: number;
}

function createVehicleStepContext(): VehicleStepContext {
  return {
    dt: FIXED_DT,
    t: { x: 0, y: 0, z: 0 },
    r: { x: 0, y: 0, z: 0, w: 1 },
    lv: { x: 0, y: 0, z: 0 },
    av: { x: 0, y: 0, z: 0 },
    fwd: { x: 0, y: 0, z: 1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    groundSpeed: 0,
    totalDrivelineTorque: 0,
    frontShare: 0,
    rearShare: 0,
  };
}

/** Per-axle working storage for the contact and suspension phases. One
 *  instance per axle because the wheel basis outlives its phase: the tyre
 *  phase reads both axles' bases after each has been resolved. */
interface AxleStepScratch {
  localPoint: Vec3;
  leftMountWorld: Vec3;
  rightMountWorld: Vec3;
  supportLookahead: Vec3;
  rayDir: Vec3;
  leftCenter: Vec3;
  rightCenter: Vec3;
  leftSupportWorld: Vec3;
  rightSupportWorld: Vec3;
  portalOffset: Vec3;
  tubeCenter: Vec3;
  housingCenter: Vec3;
  wheelCenter: Vec3;
  basis: WheelBasis;
  wheelRotation: ContactQuat;
  probeRotation: ContactQuat;
  stepInputs: StepAxleInputs;
  antiRollInput: AntiRollLoadInput;
  antiRollOut: AntiRollLoadTransfer;
  carcass: CarcassRates;
  series: SeriesSpringResult;
  sidewall: SidewallConstraintResult;
}

function createAxleStepScratch(): AxleStepScratch {
  return {
    localPoint: { x: 0, y: 0, z: 0 },
    leftMountWorld: { x: 0, y: 0, z: 0 },
    rightMountWorld: { x: 0, y: 0, z: 0 },
    supportLookahead: { x: 0, y: 0, z: 0 },
    rayDir: { x: 0, y: 0, z: 0 },
    leftCenter: { x: 0, y: 0, z: 0 },
    rightCenter: { x: 0, y: 0, z: 0 },
    leftSupportWorld: { x: 0, y: 0, z: 0 },
    rightSupportWorld: { x: 0, y: 0, z: 0 },
    portalOffset: { x: 0, y: 0, z: 0 },
    tubeCenter: { x: 0, y: 0, z: 0 },
    housingCenter: { x: 0, y: 0, z: 0 },
    wheelCenter: { x: 0, y: 0, z: 0 },
    basis: {
      forward: { x: 0, y: 0, z: 0 },
      axle: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 0 },
    },
    wheelRotation: { x: 0, y: 0, z: 0, w: 1 },
    probeRotation: { x: 0, y: 0, z: 0, w: 1 },
    stepInputs: {
      leftDepth: 0,
      rightDepth: 0,
      leftContact: false,
      rightContact: false,
      chassisVertVelAtAnchor: 0,
      dt: FIXED_DT,
      rideStiffnessMult: 1,
      rideDampingMult: 1,
      rollStiffnessMult: 1,
      maxArticulationMult: 1,
    },
    antiRollInput: {
      leftDepth: 0,
      rightDepth: 0,
      leftRate: 0,
      rightRate: 0,
      leftSupported: false,
      rightSupported: false,
      trackHalf: 0,
      torqueStiffness: 0,
      torqueDamping: 0,
      maxTransferForce: 0,
    },
    antiRollOut: { leftForce: 0, rightForce: 0 },
    carcass: { stiffness: 0, radialDamping: 0, sidewallDamping: 0, maxDeflection: 0 },
    series: {
      force: 0,
      suspensionDeflection: 0,
      carcassDeflection: 0,
      suspensionForce: 0,
      carcassForce: 0,
    },
    sidewall: { impulse: 0, correctionSpeed: 0, deflection: 0 },
  };
}

function createWheelContactFrame(): WheelContactFrame {
  return { longitudinal: { x: 0, y: 0, z: 0 }, lateral: { x: 0, y: 0, z: 0 } };
}

interface ContactPatchSample {
  grip: number;
  traction: SurfaceTractionSpec;
}

interface SuspensionSideScratch {
  wheel: WheelKinematic | null;
  localX: number;
  world: Vec3;
  supported: boolean;
  comp: number;
  compRate: number;
  force: number;
}

function createContactPatchSample(): ContactPatchSample {
  return {
    grip: 0,
    traction: {
      peakSlip: 0,
      slidingToPeak: 0,
      relaxationLength: 0,
      lateralPeakAngle: 0,
      loadSensitivityExponent: 0,
      soil: 'none',
    },
  };
}

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
    relaxedLongitudinalForce: 0,
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
    sinkDepth: 0,
    soilDrag: 0,
    slipWork: 0,
    verticalVelocity: 0,
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
  private readonly axleTubeShapes: [RAPIER.Cuboid, RAPIER.Cuboid];
  private readonly axleHousingShapes: [RAPIER.Cuboid, RAPIER.Cuboid];

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
  private readonly surfacePatches: [ContactPatchSample, ContactPatchSample, ContactPatchSample, ContactPatchSample] = [
    createContactPatchSample(), createContactPatchSample(),
    createContactPatchSample(), createContactPatchSample(),
  ];

  private engine: EngineState = createEngineState();
  private tirePressurePsi: number;
  private tireEdgeWrapPressureScale: number;
  private pressureReason: string | null = null;
  private lastRpm = 0;
  private lastGear = 0;
  private debugDriveTorque = 0;
  private debugDrivenCarrierRpm = 0;
  private debugDifferentialReactionTorque = 0;
  private debugVelocityInitialized = false;
  private readonly debugPreviousLinVel: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly debugAcceleration: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly axleDebug: [{
    iterationResidual: number; tubeContact: boolean; housingContact: boolean;
    antiRollLeftForce: number; antiRollRightForce: number;
  }, {
    iterationResidual: number; tubeContact: boolean; housingContact: boolean;
    antiRollLeftForce: number; antiRollRightForce: number;
  }] = [
    {
      iterationResidual: 0, tubeContact: false, housingContact: false,
      antiRollLeftForce: 0, antiRollRightForce: 0,
    },
    {
      iterationResidual: 0, tubeContact: false, housingContact: false,
      antiRollLeftForce: 0, antiRollRightForce: 0,
    },
  ];

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
  private readonly _scratchCombinedForce = { longitudinal: 0, lateral: 0, utilization: 0 };
  private readonly _scratchDifferential = {
    leftAngularVelocity: 0,
    rightAngularVelocity: 0,
    angularImpulse: 0,
    reactionTorque: 0,
  };
  private readonly _scratchProbeVelocity: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly _stepContext = createVehicleStepContext();
  private readonly _wheelBases: [WheelBasis | null, WheelBasis | null, WheelBasis | null, WheelBasis | null] = [
    null, null, null, null,
  ];
  private readonly _ledgeContacts: [SteepWheelContact | null, SteepWheelContact | null, SteepWheelContact | null, SteepWheelContact | null] = [
    null, null, null, null,
  ];
  private readonly _ledgeSemantics: [TireContactSemantics | null, TireContactSemantics | null, TireContactSemantics | null, TireContactSemantics | null] = [
    null, null, null, null,
  ];
  private readonly _ledgeLoads: [number, number, number, number] = [0, 0, 0, 0];
  private readonly _suspensionSides: [SuspensionSideScratch, SuspensionSideScratch] = [
    { wheel: null, localX: 0, world: { x: 0, y: 0, z: 0 }, supported: false, comp: 0, compRate: 0, force: 0 },
    { wheel: null, localX: 0, world: { x: 0, y: 0, z: 0 }, supported: false, comp: 0, compRate: 0, force: 0 },
  ];
  private readonly _axleScratch: [AxleStepScratch, AxleStepScratch] = [
    createAxleStepScratch(), createAxleStepScratch(),
  ];
  /** One reusable steep/sidewall contact per wheel. The tyre phase reads the
   *  contact its wheel resolved, so these cannot be a single shared slot. */
  private readonly _ledgeStorage: [
    SteepWheelContact, SteepWheelContact, SteepWheelContact, SteepWheelContact,
  ] = [
    createSteepWheelContact(), createSteepWheelContact(),
    createSteepWheelContact(), createSteepWheelContact(),
  ];
  private readonly _ledgeSemanticsStorage: [
    TireContactSemantics, TireContactSemantics, TireContactSemantics, TireContactSemantics,
  ] = [
    { zone: 'tread', treadFraction: 0, axleAlignment: 0 },
    { zone: 'tread', treadFraction: 0, axleAlignment: 0 },
    { zone: 'tread', treadFraction: 0, axleAlignment: 0 },
    { zone: 'tread', treadFraction: 0, axleAlignment: 0 },
  ];
  private readonly _contactFrames: [
    WheelContactFrame, WheelContactFrame, WheelContactFrame, WheelContactFrame,
  ] = [
    createWheelContactFrame(), createWheelContactFrame(),
    createWheelContactFrame(), createWheelContactFrame(),
  ];
  private readonly _supportFrames: [
    WheelContactFrame, WheelContactFrame, WheelContactFrame, WheelContactFrame,
  ] = [
    createWheelContactFrame(), createWheelContactFrame(),
    createWheelContactFrame(), createWheelContactFrame(),
  ];
  private readonly _engineOut: EngineOutput = { totalDrivelineTorque: 0, rpm: 0, gear: 0 };
  /** Re-pointed at the step context each tick; computeWaterLoad only reads it. */
  private readonly _waterPose: { t: Vec3; r: Quat; lv: Vec3; av: Vec3 } = {
    t: { x: 0, y: 0, z: 0 },
    r: { x: 0, y: 0, z: 0, w: 1 },
    lv: { x: 0, y: 0, z: 0 },
    av: { x: 0, y: 0, z: 0 },
  };
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
    this.tirePressurePsi = this.geom.spec.tireCarcass.nominalPressurePsi;
    this.tireEdgeWrapPressureScale = pressureEdgeWrapScale(
      this.tirePressurePsi,
      this.geom.spec.tireCarcass.nominalPressurePsi,
    );
    this.drivetrain.transferCase = this.geom.spec.drivetrain === 'fixed-rwd' ? '2h' : '4h';
    this.wheelShape = new RAPIER.Cylinder(this.geom.wheelWidth / 2, this.geom.wheelRadius);
    this.axleTubeShapes = [this.geom.front, this.geom.rear].map((axle) => new RAPIER.Cuboid(
      axle.trackHalf, axle.probe.tubeRadius, axle.probe.tubeRadius,
    )) as [RAPIER.Cuboid, RAPIER.Cuboid];
    this.axleHousingShapes = [this.geom.front, this.geom.rear].map((axle) => new RAPIER.Cuboid(
      axle.probe.housingHalfExtents.x,
      axle.probe.housingHalfExtents.y,
      axle.probe.housingHalfExtents.z,
    )) as [RAPIER.Cuboid, RAPIER.Cuboid];

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
    this.pressureReason = null;
    repairDamage(this.damage);
    for (const a of this.axles) resetAxleState(a);
    for (const w of this.wheels) resetWheelKinematic(w);
    this.engine = createEngineState();
    this.lastRpm = 0;
    this.lastGear = 0;
    this.debugDriveTorque = 0;
    this.debugDrivenCarrierRpm = 0;
    this.debugDifferentialReactionTorque = 0;
    this.debugVelocityInitialized = false;
    this.debugAcceleration.x = 0;
    this.debugAcceleration.y = 0;
    this.debugAcceleration.z = 0;
    resetWaterState(this.water);
    this.externalPointLoads.length = 0;
  }

  private captureStepContext(): VehicleStepContext {
    const context = this._stepContext;
    const translation = this.body.translation();
    const rotation = this.body.rotation();
    const linearVelocity = this.body.linvel();
    const angularVelocity = this.body.angvel();
    context.t.x = translation.x; context.t.y = translation.y; context.t.z = translation.z;
    context.r.x = rotation.x; context.r.y = rotation.y; context.r.z = rotation.z; context.r.w = rotation.w;
    context.lv.x = linearVelocity.x; context.lv.y = linearVelocity.y; context.lv.z = linearVelocity.z;
    context.av.x = angularVelocity.x; context.av.y = angularVelocity.y; context.av.z = angularVelocity.z;

    const x = rotation.x; const y = rotation.y; const z = rotation.z; const w = rotation.w;
    const xx = x * x; const yy = y * y; const zz = z * z;
    const xy = x * y; const xz = x * z; const yz = y * z;
    const xw = x * w; const yw = y * w; const zw = z * w;
    context.right.x = 1 - 2 * (yy + zz);
    context.right.y = 2 * (xy + zw);
    context.right.z = 2 * (xz - yw);
    context.up.x = 2 * (xy - zw);
    context.up.y = 1 - 2 * (xx + zz);
    context.up.z = 2 * (yz + xw);
    context.fwd.x = 2 * (xz + yw);
    context.fwd.y = 2 * (yz - xw);
    context.fwd.z = 1 - 2 * (xx + yy);
    return context;
  }

  /** The fixed phase order the whole model depends on.
   *
   *  Every phase reads the one chassis capture `phaseBegin` takes and passes
   *  its results forward through `VehicleStepContext` and the preallocated
   *  scratch on this class; none of them re-reads the body mid-tick
   *  (determinism rule 1). Contact is resolved for one axle before that same
   *  axle's suspension runs, in fixed [front, rear] order: splitting these
   *  into two whole-vehicle passes would reorder the impulses each axle
   *  applies to the chassis, which is a different simulation, not a
   *  refactor. */
  preStep(): void {
    const ctx = this.phaseBegin();
    for (let aIdx = 0; aIdx < 2; aIdx++) {
      this.phaseContact(ctx, aIdx);
      this.phaseSuspension(ctx, aIdx);
    }
    this.phaseWater(ctx);
    this.phaseEngine(ctx);
    this.phaseDriveline(ctx);
    this.phaseTyreSoil(ctx);
  }

  /** Capture, force reset, driver controls and steering. @hotloop */
  private phaseBegin(): VehicleStepContext {
    const stepContext = this.captureStepContext();
    const dt = stepContext.dt;

    // CRITICAL: Rapier accumulates external forces across step() calls
    // until reset. Without these calls, last tick's spring force would
    // add to this tick's, causing a runaway upward force after a few
    // ticks of contact. Reset here so each tick's force is fresh.
    this.body.resetForces(false);
    this.body.resetTorques(false);
    for (let i = 0; i < this.externalPointLoads.length; i++) {
      const load = this.externalPointLoads[i]!;
      this.body.addForceAtPoint(load.force, load.point, true);
    }
    this.externalPointLoads.length = 0;

    // 1. Capture chassis pose ONCE (determinism rule).
    const lv = stepContext.lv;
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
    stepContext.groundSpeed = groundSpeed;
    this.impactSpeed = groundSpeed;
    this.updateDrivetrainControls(groundSpeed);
    this.updatePressure(groundSpeed, dt);
    const wheelBases = this._wheelBases;
    const ledgeContacts = this._ledgeContacts;
    const ledgeSemantics = this._ledgeSemantics;
    const ledgeLoads = this._ledgeLoads;
    for (let wheelIndex = 0; wheelIndex < 4; wheelIndex++) {
      wheelBases[wheelIndex] = null;
      ledgeContacts[wheelIndex] = null;
      ledgeSemantics[wheelIndex] = null;
      ledgeLoads[wheelIndex] = 0;
    }

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
    return stepContext;
  }

  /** 3. One axle's contact resolution: exactly two deterministic contact
   *  iterations, the axle-beam probes, the rut/water/surface reads and the
   *  volumetric tyre query with its carcass and sidewall response. Both
   *  iterations solve from the state captured at tick start; only the second
   *  contact result is committed to the axle integrator. @hotloop */
  private phaseContact(ctx: VehicleStepContext, aIdx: number): void {
    const dt = ctx.dt;
    const t = ctx.t;
    const r = ctx.r;
    const lv = ctx.lv;
    const av = ctx.av;
    const fwd = ctx.fwd;
    const right = ctx.right;
    const up = ctx.up;
    const wheelBases = this._wheelBases;
    const ledgeContacts = this._ledgeContacts;
    const ledgeSemantics = this._ledgeSemantics;
    const ledgeLoads = this._ledgeLoads;
    const scratch = this._axleScratch[aIdx]!;
    const local = scratch.localPoint;

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

    const rayLift = SUSPENSION.rayLift;
    const leftMountWorld = scratch.leftMountWorld;
    local.x = -ag.trackHalf; local.y = ag.centerLocalY; local.z = ag.centerLocalZ;
    rotateVecByQuatInto(local, r, leftMountWorld);
    leftMountWorld.x += t.x; leftMountWorld.y += t.y; leftMountWorld.z += t.z;
    const rightMountWorld = scratch.rightMountWorld;
    local.x = +ag.trackHalf; local.y = ag.centerLocalY; local.z = ag.centerLocalZ;
    rotateVecByQuatInto(local, r, rightMountWorld);
    rightMountWorld.x += t.x; rightMountWorld.y += t.y; rightMountWorld.z += t.z;
    const supportLookahead = scratch.supportLookahead;
    supportLookahead.x = lv.x * dt * SUSPENSION.supportLookaheadTicks;
    supportLookahead.y = 0;
    supportLookahead.z = lv.z * dt * SUSPENSION.supportLookaheadTicks;
    const rayDir = scratch.rayDir;
    local.x = 0; local.y = -1; local.z = 0;
    rotateVecByQuatInto(local, r, rayDir);
    const maxToi = rayLift + ag.suspensionRestLength + ag.droopMax;
    const visualMax = ag.suspensionRestLength * 0.85;
    let candidateRide = clamp(
      axle.rideY + axle.rideVelY * dt,
      -ag.droopMax,
      visualMax,
    );
    let candidateRoll = clamp(
      axle.rollAngle + axle.rollVel * dt,
      -ag.maxArticulation * at.maxArticulationMult,
      ag.maxArticulation * at.maxArticulationMult,
    );
    const basis = wheelBasisInto(
      fwd, right, up, candidateRoll, ag.hasSteering ? -this.currentSteer : 0, scratch.basis,
    );
    const wheelRotation = cylinderRotationInto(basis.axle, scratch.wheelRotation);
    let sinCandidate = Math.sin(candidateRoll);
    let leftCandidateDepth = candidateRide - ag.trackHalf * sinCandidate;
    let rightCandidateDepth = candidateRide + ag.trackHalf * sinCandidate;
    const leftCenter = scratch.leftCenter;
    const rightCenter = scratch.rightCenter;
    wheelCenterWorldPoseInto(t, r, ag, candidateRide, candidateRoll, -ag.trackHalf, local, leftCenter);
    wheelCenterWorldPoseInto(t, r, ag, candidateRide, candidateRoll, +ag.trackHalf, local, rightCenter);
    const leftSupportWorld = scratch.leftSupportWorld;
    leftSupportWorld.x = leftCenter.x - rayDir.x * rayLift + supportLookahead.x;
    leftSupportWorld.y = leftCenter.y - rayDir.y * rayLift;
    leftSupportWorld.z = leftCenter.z - rayDir.z * rayLift + supportLookahead.z;
    const rightSupportWorld = scratch.rightSupportWorld;
    rightSupportWorld.x = rightCenter.x - rayDir.x * rayLift + supportLookahead.x;
    rightSupportWorld.y = rightCenter.y - rayDir.y * rayLift;
    rightSupportWorld.z = rightCenter.z - rayDir.z * rayLift + supportLookahead.z;
    castWheelSupport(
      this.world,
      this.body,
      this.wheelShape,
      wheelRotation,
      leftSupportWorld,
      rayDir,
      maxToi,
      leftCandidateDepth + rayLift,
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
      rightCandidateDepth + rayLift,
      this.geom.wheelRadius,
      this.geom.wheelWidth / 2,
      basis.axle,
      wR,
    );
    const leftFirstDepth = wL.contact ? wL.contactDepth : -ag.droopMax;
    const rightFirstDepth = wR.contact ? wR.contactDepth : -ag.droopMax;
    const correctedRide = clamp(0.5 * (leftFirstDepth + rightFirstDepth), -ag.droopMax, visualMax);
    const correctedRoll = clamp(
      Math.atan2(rightFirstDepth - leftFirstDepth, 2 * ag.trackHalf),
      -ag.maxArticulation * at.maxArticulationMult,
      ag.maxArticulation * at.maxArticulationMult,
    );
    candidateRide = moveToward(candidateRide, correctedRide, 0.025);
    candidateRoll = moveToward(candidateRoll, correctedRoll, 0.025 / Math.max(0.1, ag.trackHalf));

    // Corrector query: rebuild both centres from the corrected beam pose,
    // then overwrite the predictor contacts. No predictor state is kept.
    wheelBasisInto(
      fwd, right, up, candidateRoll, ag.hasSteering ? -this.currentSteer : 0, basis,
    );
    cylinderRotationInto(basis.axle, wheelRotation);
    wheelBases[wIdxL] = basis;
    wheelBases[wIdxR] = basis;
    sinCandidate = Math.sin(candidateRoll);
    leftCandidateDepth = candidateRide - ag.trackHalf * sinCandidate;
    rightCandidateDepth = candidateRide + ag.trackHalf * sinCandidate;
    wheelCenterWorldPoseInto(t, r, ag, candidateRide, candidateRoll, -ag.trackHalf, local, leftCenter);
    wheelCenterWorldPoseInto(t, r, ag, candidateRide, candidateRoll, +ag.trackHalf, local, rightCenter);
    leftSupportWorld.x = leftCenter.x - rayDir.x * rayLift + supportLookahead.x;
    leftSupportWorld.y = leftCenter.y - rayDir.y * rayLift;
    leftSupportWorld.z = leftCenter.z - rayDir.z * rayLift + supportLookahead.z;
    rightSupportWorld.x = rightCenter.x - rayDir.x * rayLift + supportLookahead.x;
    rightSupportWorld.y = rightCenter.y - rayDir.y * rayLift;
    rightSupportWorld.z = rightCenter.z - rayDir.z * rayLift + supportLookahead.z;
    castWheelSupport(
      this.world, this.body, this.wheelShape, wheelRotation,
      leftSupportWorld, rayDir, maxToi, leftCandidateDepth + rayLift,
      this.geom.wheelRadius, this.geom.wheelWidth / 2, basis.axle, wL,
    );
    castWheelSupport(
      this.world, this.body, this.wheelShape, wheelRotation,
      rightSupportWorld, rayDir, maxToi, rightCandidateDepth + rayLift,
      this.geom.wheelRadius, this.geom.wheelWidth / 2, basis.axle, wR,
    );
    const leftSecondDepth = wL.contact ? wL.contactDepth : -ag.droopMax;
    const rightSecondDepth = wR.contact ? wR.contactDepth : -ag.droopMax;
    const axleDebug = this.axleDebug[aIdx]!;
    axleDebug.iterationResidual = Math.max(
      Math.abs(leftSecondDepth - leftFirstDepth),
      Math.abs(rightSecondDepth - rightFirstDepth),
    );
    axleDebug.tubeContact = false;
    axleDebug.housingContact = false;
    const probeRotation = axleBeamRotationInto(r, candidateRoll, scratch.probeRotation);
    const portalOffset = scratch.portalOffset;
    local.x = 0; local.y = ag.probe.verticalOffset; local.z = 0;
    rotateVecByQuatInto(local, r, portalOffset);
    const tubeCenter = scratch.tubeCenter;
    const housingCenter = scratch.housingCenter;
    wheelCenterWorldPoseInto(t, r, ag, candidateRide, candidateRoll, 0, local, tubeCenter);
    wheelCenterWorldPoseInto(t, r, ag, candidateRide, candidateRoll, 0, local, housingCenter);
    tubeCenter.x += portalOffset.x; tubeCenter.y += portalOffset.y; tubeCenter.z += portalOffset.z;
    housingCenter.x += portalOffset.x; housingCenter.y += portalOffset.y; housingCenter.z += portalOffset.z;
    const probeSurface = sampleSurface(this.world.terrain, housingCenter.x, housingCenter.z);
    const probeDry = !this.worldHasWater
      || sampleWaterDepth(this.world.terrain, housingCenter.x, housingCenter.z) <= 0;
    if (up.y > 0.9 && probeDry
      && surfaceInfo(probeSurface).traction.soil === 'none') {
      this.applyAxleProbe(aIdx, false, this.axleTubeShapes[aIdx]!, tubeCenter, probeRotation, t, lv, av, dt);
      this.applyAxleProbe(aIdx, true, this.axleHousingShapes[aIdx]!, housingCenter, probeRotation, t, lv, av, dt);
    }
    const debugLeft = this.wheelDebug[wIdxL]!;
    const debugRight = this.wheelDebug[wIdxR]!;
    setSuspensionDebug(debugLeft, leftSupportWorld, rayDir, maxToi, ag);
    setSuspensionDebug(debugRight, rightSupportWorld, rayDir, maxToi, ag);
    // Lookahead is only for choosing next-frame support depth/normal. Tire
    // and spring reactions still act at the current wheel patch; leaving the
    // point one tick ahead adds an artificial moment arm during cornering.
    wL.contactPoint.x -= supportLookahead.x;
    wL.contactPoint.z -= supportLookahead.z;
    wR.contactPoint.x -= supportLookahead.x;
    wR.contactPoint.z -= supportLookahead.z;
    if (wL.contact && wL.sinkDepth > 0) {
      wL.contactDepth = Math.max(0, wL.contactDepth - wL.sinkDepth);
      wL.contactPoint.y -= wL.sinkDepth;
    }
    if (wR.contact && wR.sinkDepth > 0) {
      wR.contactDepth = Math.max(0, wR.contactDepth - wR.sinkDepth);
      wR.contactPoint.y -= wR.sinkDepth;
    }
    if (wL.contact) {
      const rutDepth = this.world.ruts.sampleDepth(wL.contactPoint.x, wL.contactPoint.z);
      wL.contactDepth = Math.max(0, wL.contactDepth - rutDepth);
      wL.contactPoint.y -= rutDepth;
    }
    if (wR.contact) {
      const rutDepth = this.world.ruts.sampleDepth(wR.contactPoint.x, wR.contactPoint.z);
      wR.contactDepth = Math.max(0, wR.contactDepth - rutDepth);
      wR.contactPoint.y -= rutDepth;
    }

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
    for (let volumeSideIndex = 0; volumeSideIndex < 2; volumeSideIndex++) {
      const wheelIndex = volumeSideIndex === 0 ? wIdxL : wIdxR;
      const w = volumeSideIndex === 0 ? wL : wR;
      const localX = volumeSideIndex === 0 ? -ag.trackHalf : ag.trackHalf;
      const center = scratch.wheelCenter;
      wheelCenterWorldPoseInto(t, r, ag, candidateRide, candidateRoll, localX, local, center);
      const debug = this.wheelDebug[wheelIndex]!;
      debug.wheelCenter.x = center.x;
      debug.wheelCenter.y = center.y;
      debug.wheelCenter.z = center.z;
      debug.verticalVelocity = w.hasPreviousCenter
        ? (center.y - w.previousCenter.y) / dt
        : 0;
      // Upward terrain support already accounts for the tyre volume. A steep
      // heightfield hit is different: reuse its cast normal and witness, then
      // validate the upper surface analytically because Rapier 0.14 may return
      // null when the same heightfield/cylinder pair is reconstructed through
      // `contactShape`.
      let ledge = w.volumeSupport
        ? (w.contactNormal.y < LEDGE_CONTACT.maxSupportNormalY
          ? findHeightfieldLedgeContactInto(
            this.world.terrain,
            center,
            w.contactPoint,
            w.contactNormal,
            basis.forward,
            basis.axle,
            this.geom.wheelRadius,
            this.geom.wheelWidth / 2,
            LEDGE_CONTACT.prediction,
            LEDGE_CONTACT.maxSupportNormalY,
            LEDGE_CONTACT.maxClimbHeight,
            LEDGE_CONTACT.edgeAdvance * this.tireEdgeWrapPressureScale
              * TUNING.tireEdgeWrapMult,
            this.world.terrainCollider.friction(),
            this._ledgeStorage[wheelIndex]!,
          )
          : null)
        : findSteepWheelContactInto(
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
          LEDGE_CONTACT.edgeAdvance * this.tireEdgeWrapPressureScale
            * TUNING.tireEdgeWrapMult,
          basis.forward,
          COLLISION_GROUP_WHEEL_RAY,
          this._ledgeStorage[wheelIndex]!,
          basis.axle,
        );
      if (!ledge && !w.contact) {
        ledge = findTerrainSidewallContactInto(
          this.world,
          center,
          basis.axle,
          this.geom.wheelRadius,
          this.geom.wheelWidth / 2,
          LEDGE_CONTACT.prediction,
          this._ledgeStorage[wheelIndex]!,
        );
      }
      ledgeContacts[wheelIndex] = ledge;
      const semantics = ledge
        ? classifyTireContactInto(
          ledge.normal.x * basis.axle.x
          + ledge.normal.y * basis.axle.y
          + ledge.normal.z * basis.axle.z,
          this._ledgeSemanticsStorage[wheelIndex]!,
        )
        : null;
      ledgeSemantics[wheelIndex] = semantics;
      w.ledgeContact = ledge !== null;
      w.ledgeNormalForce = 0;
      w.ledgeLongForce = 0;
      w.previousCenter.x = center.x;
      w.previousCenter.y = center.y;
      w.previousCenter.z = center.z;
      w.hasPreviousCenter = true;

      const quarterMass = this.geom.spec.massKg * 0.25;
      const carcass = carcassRatesInto(
        this.geom.spec.tireCarcass.staticDeflectionRatio * TUNING.tireCarcassComplianceMult,
        this.geom.spec.tireCarcass.radialDampingRatio * TUNING.tireRadialDampingMult,
        this.geom.spec.tireCarcass.sidewallDampingRatio,
        this.geom.wheelRadius,
        quarterMass * Math.abs(GRAVITY_Y),
        quarterMass,
        pressureRadialScale(
          this.tirePressurePsi,
          this.geom.spec.tireCarcass.nominalPressurePsi,
        ),
        scratch.carcass,
      );
      const series = solveSeriesComplianceInto(
        w.contact ? Math.max(0, w.contactDepth) : 0,
        0.5 * ag.rideStiffness * at.rideStiffnessMult,
        carcass.stiffness,
        carcass.maxDeflection,
        scratch.series,
      );
      let bridgeActive = false;
      if (ledge && !w.volumeSupport && (semantics?.treadFraction ?? 0) > 0) {
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
      // A heightfield ledge is reconstructed from this wheel's existing
      // volume-support hit, so its suspension reaction already owns the
      // contact normal. Discrete scenery has no such support and keeps the
      // separate sidewall constraint below.
      if (ledge && !w.volumeSupport) {
        const normalSpeed = pointVelocityDot(lv, av, t, ledge.point, ledge.normal);
        const constraint = solveSidewallConstraintInto(
          ledge.penetration,
          normalSpeed,
          (VEHICLE.mass * this.geom.massMult) * LEDGE_CONTACT.normalMassFraction,
          dt,
          w.previousTireDeflection,
          carcass.maxDeflection,
          LEDGE_CONTACT.normalCorrectionRate * TUNING.tireSidewallCorrectionMult,
          LEDGE_CONTACT.maxNormalCorrectionSpeed * TUNING.tireSidewallCorrectionMult,
          LEDGE_CONTACT.maxForce * dt,
          SIDEWALL_RELEASE_RATE,
          scratch.sidewall,
        );
        const normalForce = constraint.impulse / dt;
        ledgeLoads[wheelIndex] = normalForce;
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
          }
        }
      }
      w.previousTireDeflection = w.tireDeflection;
    }
  }

  /** 3a. One axle's suspension: beam integration, per-wheel-end ride forces,
   *  the sway bar, the mechanical travel stops and the roll-torque dump past
   *  the articulation cap. @hotloop */
  private phaseSuspension(ctx: VehicleStepContext, aIdx: number): void {
    const dt = ctx.dt;
    const fwd = ctx.fwd;
    const up = ctx.up;
    const scratch = this._axleScratch[aIdx]!;
    const axle = this.axles[aIdx]!;
    const ag = axle.geom;
    const at = aIdx === 0 ? TUNING.axleFront : TUNING.axleRear;
    const wL = this.wheels[aIdx * 2]!;
    const wR = this.wheels[aIdx * 2 + 1]!;
    const leftMountWorld = scratch.leftMountWorld;
    const rightMountWorld = scratch.rightMountWorld;

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
    const stepInputs = scratch.stepInputs;
    stepInputs.leftDepth = wL.resolvedDepth;
    stepInputs.rightDepth = wR.resolvedDepth;
    stepInputs.leftContact = hasSuspensionSupport(wL);
    stepInputs.rightContact = hasSuspensionSupport(wR);
    stepInputs.chassisVertVelAtAnchor = 0; // unused now; per-wheel damping below
    stepInputs.dt = dt;
    stepInputs.rideStiffnessMult = at.rideStiffnessMult;
    stepInputs.rideDampingMult = at.rideDampingMult;
    stepInputs.rollStiffnessMult = at.rollStiffnessMult;
    stepInputs.maxArticulationMult = at.maxArticulationMult;
    const result = stepAxle(axle, stepInputs, axle.stepResult);
    const finalRollSin = Math.sin(axle.rollAngle);
    const leftStop = progressiveTravelStopForce(
      axle.rideY - ag.trackHalf * finalRollSin,
      ag.bumpMax,
      ag.droopMax,
      0.5 * ag.rideStiffness * at.rideStiffnessMult,
      axle.travelStops[0],
    );
    const rightStop = progressiveTravelStopForce(
      axle.rideY + ag.trackHalf * finalRollSin,
      ag.bumpMax,
      ag.droopMax,
      0.5 * ag.rideStiffness * at.rideStiffnessMult,
      axle.travelStops[1],
    );

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
    const sides = this._suspensionSides;
    sides[0].wheel = wL;
    sides[0].localX = -ag.trackHalf;
    sides[0].world.x = leftMountWorld.x;
    sides[0].world.y = leftMountWorld.y;
    sides[0].world.z = leftMountWorld.z;
    sides[1].wheel = wR;
    sides[1].localX = ag.trackHalf;
    sides[1].world.x = rightMountWorld.x;
    sides[1].world.y = rightMountWorld.y;
    sides[1].world.z = rightMountWorld.z;
    for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
      const side = sides[sideIndex]!;
      side.supported = false;
      side.comp = 0;
      side.compRate = 0;
      side.force = 0;
    }
    for (let suspensionSideIndex = 0; suspensionSideIndex < 2; suspensionSideIndex++) {
      const side = sides[suspensionSideIndex]!;
      const w = side.wheel!;
      const stop = axle.travelStops[suspensionSideIndex]!;
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
      const travel = clamp(w.resolvedDepth, -ag.droopMax, ag.suspensionRestLength);
      const comp = Math.max(0, travel);
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
      // Carcass and suspension are a series path: apply their shared
      // spring load once, plus the suspension damper. The carcass damper
      // is already included in w.carcassForce above.
      const F = comp > 0
        ? w.carcassForce
          + 0.5 * ag.rideDamping * at.rideDampingMult * engagement * compRate
        : 0;
      side.force = clamp(F, 0, LEDGE_CONTACT.maxForce - stop.bumpForce);
      w.suspensionForce = side.force;
    }

    // A sway bar transfers load between the two suspension ends. It is
    // driven by their relative travel/rate, not the chassis's angle to
    // world-up. Unsupported ends sit at full droop for bar deflection,
    // while forces can only enter the chassis through supported ends.
    const frontBarShare = clamp(TUNING.antiRollFrontShare, 0, 1);
    const barShare = aIdx === 0
      ? frontBarShare * (this.drivetrain.transferCase === '4l'
        ? ANTI_ROLL.lowRangeFrontDisconnect
        : 1)
      : 1 - frontBarShare;
    const axleMassShare = aIdx === 0 ? 0.52 : 0.48;
    const antiRollInput = scratch.antiRollInput;
    antiRollInput.leftDepth = sides[0]!.supported ? sides[0]!.comp : -ag.droopMax;
    antiRollInput.rightDepth = sides[1]!.supported ? sides[1]!.comp : -ag.droopMax;
    antiRollInput.leftRate = sides[0]!.supported ? sides[0]!.compRate : 0;
    antiRollInput.rightRate = sides[1]!.supported ? sides[1]!.compRate : 0;
    antiRollInput.leftSupported = sides[0]!.supported;
    antiRollInput.rightSupported = sides[1]!.supported;
    antiRollInput.trackHalf = ag.trackHalf;
    antiRollInput.torqueStiffness = ANTI_ROLL.torqueStiffness * barShare * TUNING.antiRollStiffnessMult;
    antiRollInput.torqueDamping = ANTI_ROLL.torqueDamping * barShare * TUNING.antiRollDampingMult;
    antiRollInput.maxTransferForce = this.geom.spec.massKg * Math.abs(GRAVITY_Y)
      * axleMassShare * ANTI_ROLL.maxStaticLoadTransfer;
    const bar = computeAntiRollLoadTransfer(antiRollInput, scratch.antiRollOut);
    this.axleDebug[aIdx]!.antiRollLeftForce = bar.leftForce;
    this.axleDebug[aIdx]!.antiRollRightForce = bar.rightForce;
    sides[0]!.force = clamp(
      sides[0]!.force + bar.leftForce,
      0,
      LEDGE_CONTACT.maxForce,
    );
    sides[1]!.force = clamp(
      sides[1]!.force + bar.rightForce,
      0,
      LEDGE_CONTACT.maxForce,
    );

    for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
      const side = sides[sideIndex]!;
      if (!side.supported) continue;
      const w = side.wheel!;
      w.suspensionForce = side.force;
      // Apply the suspension-side resultant once. Carcass reaction is
      // retained separately for diagnostics; applying it again here would
      // double-count the same series load.
      const F = side.force;
      w.lastForce = Math.max(0, F);
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

    // Mechanical travel stops act between the chassis mount and beam, not
    // between the chassis and terrain. Apply their chassis half along the
    // suspension axis at each final mount and feed the equal/opposite
    // generalized reaction into the axle's unsprung heave/roll state.
    // The Rapier chassis owns total vehicle mass, including the abstract
    // beam. With no ground support an internal stop may move the relative
    // axle DOF, but must not accelerate that total-mass rigid body.
    const leftStopForce = hasSuspensionSupport(wL)
      ? clamp(leftStop.totalForce, -LEDGE_CONTACT.maxForce, LEDGE_CONTACT.maxForce)
      : 0;
    const rightStopForce = hasSuspensionSupport(wR)
      ? clamp(rightStop.totalForce, -LEDGE_CONTACT.maxForce, LEDGE_CONTACT.maxForce)
      : 0;
    if (leftStopForce !== 0) {
      const sf = this._scratchForce;
      sf.x = up.x * leftStopForce; sf.y = up.y * leftStopForce; sf.z = up.z * leftStopForce;
      this.body.addForceAtPoint(sf, leftMountWorld, true);
    }
    if (rightStopForce !== 0) {
      const sf = this._scratchForce;
      sf.x = up.x * rightStopForce; sf.y = up.y * rightStopForce; sf.z = up.z * rightStopForce;
      this.body.addForceAtPoint(sf, rightMountWorld, true);
    }
    applyTravelStopReactionToAxle(axle, leftStopForce, rightStopForce, dt);
    wL.suspensionForce += Math.max(0, leftStopForce);
    wR.suspensionForce += Math.max(0, rightStopForce);

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

  /** 3b. Water: buoyancy, drag and current.
   *
   *  Sits here, after the suspension and anti-roll and before the
   *  engine, for two reasons. The chassis pose, lv, av and the
   *  basis vectors are all already in scope from the single read at
   *  the top of preStep (determinism rule 1), and the engine has
   *  not run yet, so a drowned intake can cut the drive before any
   *  torque is computed rather than after.
   *
   *  Buoyancy is applied as four separate corner forces rather than
   *  one resultant at the centre of buoyancy. Unequal corner lift
   *  IS the righting moment, so pitch and roll response fall out
   *  for free and there is no second torque term to keep in sync.
   *
   *  Nothing here unloads the springs by hand: the suspension force
   *  computed above becomes the tyre's normal load further down, so
   *  a chassis being lifted by water automatically loses grip.
   *  @hotloop */
  private phaseWater(ctx: VehicleStepContext): void {
    if (this.worldHasWater) {
      const pose = this._waterPose;
      pose.t = ctx.t;
      pose.r = ctx.r;
      pose.lv = ctx.lv;
      pose.av = ctx.av;
      const wl = computeWaterLoad(
        this.world.terrain, this.geom, this.water,
        pose, ctx.dt, this.waterLoad,
      );
      if (wl.submergedFrac > 0) {
        for (let i = 0; i < wl.samples.length; i++) {
          const s = wl.samples[i]!;
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
  }

  /** 3d/4. Flood-restart state machine, then the engine and gearbox. The
   *  flood machine must run first so a drowning cuts the drive on the tick
   *  it happens, and so a successful crank restores idle RPM before
   *  stepEngine reads it. @hotloop */
  private phaseEngine(ctx: VehicleStepContext): void {
    const dt = ctx.dt;
    const lv = ctx.lv;
    const fwd = ctx.fwd;
    stepEngineFlooding(
      this.engine,
      this.waterLoad.intakeSubmerged,
      this.waterLoad.drowned,
      (this.input.buttons & BUTTON_STARTER) !== 0,
    );
    if (this.engine.drowned) this.damage.stoppedCause = 'flooding';
    else if (this.damage.stoppedCause === 'flooding') this.damage.stoppedCause = 'none';

    const frontCarrier = differentialCarrierSpeed(this.wheels[0]!.angVel, this.wheels[1]!.angVel);
    const rearCarrier = differentialCarrierSpeed(this.wheels[2]!.angVel, this.wheels[3]!.angVel);
    const drivenCarrier = drivenCarrierSpeed(this.drivetrain.transferCase, frontCarrier, rearCarrier);
    const longSpeed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const signedCarrier = Math.sign(longSpeed || drivenCarrier) * Math.abs(drivenCarrier);
    // In manual mode W / the gas pedal supplies power and the selected gear
    // supplies direction. The input layer turns S into a brake in manual
    // mode, so negative throttle cannot accidentally power the chosen gear.
    const engineThrottle = this.input.manualGear === null
      ? this.input.throttle
      : Math.max(0, this.input.throttle);
    // Shift speed follows motion in the commanded direction. A truck rolling
    // backwards on a climb must remain in first instead of upshifting through
    // the forward gears as its downhill speed rises.
    const commandedSpeed = engineThrottle === 0
      ? Math.abs(longSpeed)
      : Math.max(0, Math.sign(engineThrottle) * longSpeed);
    const vehicleAngVel = commandedSpeed / this.geom.wheelRadius;
    const carrierForEngine = engineThrottle !== 0
      && longSpeed * Math.sign(engineThrottle) < 0
      ? 0
      : signedCarrier;
    const engineOut = stepEngine(
      this.engine,
      carrierForEngine,
      vehicleAngVel,
      engineThrottle,
      dt,
      this.input.manualGear,
      ENGINE.finalDrive * this.geom.spec.finalDriveMult
        * (this.drivetrain.transferCase === '4l' ? this.geom.spec.lowRangeRatio : 1),
      this._engineOut,
    );
    if (this.damage.engine <= 0.08) {
      engineOut.totalDrivelineTorque = 0;
      engineOut.rpm = Math.max(0, this.lastRpm - 900 * dt);
      engineOut.gear = 0;
      this.damage.stoppedCause = 'collision';
    }
    this.lastRpm = engineOut.rpm;
    this.lastGear = engineOut.gear;
    const engineHealthMult = 0.38 + this.damage.engine * 0.62;
    const totalDrivelineTorque = engineOut.totalDrivelineTorque * this.geom.powerMult
      * engineHealthMult;
    ctx.totalDrivelineTorque = totalDrivelineTorque;
    this.debugDriveTorque = totalDrivelineTorque;
    this.debugDrivenCarrierRpm = Math.abs(drivenCarrier) * 60 / (2 * Math.PI);
  }

  /** 5. Axle differential impulses in fixed front/rear order, then the
   *  centre transfer. Runs before slip so the tyre phase reads the locked
   *  angular velocities. @hotloop */
  private phaseDriveline(ctx: VehicleStepContext): void {
    const dt = ctx.dt;
    const totalDrivelineTorque = ctx.totalDrivelineTorque;
    // transferCaseDriveSplit's shape, read field by field: the exported
    // helper copies VEHICLE.driveSplit so its caller cannot mutate the
    // constant, and that copy is exactly the allocation this phase must not
    // make 60 times a second.
    const mode = this.drivetrain.transferCase;
    const frontShare = mode === '2h' ? 0 : VEHICLE.driveSplit.front;
    const rearShare = mode === '2h' ? 1 : VEHICLE.driveSplit.rear;
    ctx.frontShare = frontShare;
    ctx.rearShare = rearShare;
    this.debugDifferentialReactionTorque = 0;
    for (let axleIndex = 0; axleIndex < 2; axleIndex++) {
      const left = this.wheels[axleIndex * 2]!;
      const rightWheel = this.wheels[axleIndex * 2 + 1]!;
      const spec = axleIndex === 0
        ? this.geom.spec.differentials.front
        : this.geom.spec.differentials.rear;
      const selectedLock = this.geom.spec.drivetrain !== 'fixed-rwd' && (axleIndex === 0
        ? TUNING.diffLockFront || this.drivetrain.frontLocked
        : TUNING.diffLockRear || this.drivetrain.rearLocked);
      const diffMode = selectedLock ? 'locked' : spec.mode === 'lsd' ? 'lsd' : 'open';
      const axleTorque = totalDrivelineTorque * (axleIndex === 0 ? frontShare : rearShare);
      const solved = solveDifferentialAngularImpulse(
        left.angVel,
        rightWheel.angVel,
        this.geom.spec.wheelInertiaKgM2,
        dt,
        diffMode,
        axleTorque,
        spec.torqueBiasRatio,
        spec.preloadNm,
        this._scratchDifferential,
      );
      left.angVel = solved.leftAngularVelocity;
      rightWheel.angVel = solved.rightAngularVelocity;
      this.debugDifferentialReactionTorque += Math.abs(solved.reactionTorque);
    }
    if (this.drivetrain.transferCase !== '2h') {
      const postFrontCarrier = differentialCarrierSpeed(this.wheels[0]!.angVel, this.wheels[1]!.angVel);
      const postRearCarrier = differentialCarrierSpeed(this.wheels[2]!.angVel, this.wheels[3]!.angVel);
      const center = solveCenterTransferImpulse(
        postFrontCarrier,
        postRearCarrier,
        this.geom.spec.wheelInertiaKgM2,
        dt,
        this._scratchDifferential,
      );
      const frontDelta = center.leftAngularVelocity - postFrontCarrier;
      const rearDelta = center.rightAngularVelocity - postRearCarrier;
      this.wheels[0]!.angVel += frontDelta;
      this.wheels[1]!.angVel += frontDelta;
      this.wheels[2]!.angVel += rearDelta;
      this.wheels[3]!.angVel += rearDelta;
      this.debugDifferentialReactionTorque += Math.abs(center.reactionTorque);
    }
  }

  /** 6. Per-wheel tyre forces, soil response and spin integration.
   *
   *  A locked wheel is a tangential contact constraint, not merely a wheel
   *  whose angular velocity happens to be zero. Split the chassis mass among
   *  the braked contact patches by normal load so the solver below can drive
   *  their patch velocity to zero and cancel gravity along the slope. The
   *  previous wheel-inertia-only force allowed a constant downhill creep:
   *  gravity first had to create slip before the tyre produced any reaction.
   *  @hotloop */
  private phaseTyreSoil(ctx: VehicleStepContext): void {
    const dt = ctx.dt;
    const t = ctx.t;
    const lv = ctx.lv;
    const av = ctx.av;
    const groundSpeed = ctx.groundSpeed;
    const totalDrivelineTorque = ctx.totalDrivelineTorque;
    const frontShare = ctx.frontShare;
    const rearShare = ctx.rearShare;
    const wheelBases = this._wheelBases;
    const ledgeContacts = this._ledgeContacts;
    const ledgeSemantics = this._ledgeSemantics;
    const ledgeLoads = this._ledgeLoads;

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
        ? contactFrameInto(ledge.normal, basis.axle, basis.forward, this._contactFrames[wIdx]!)
        : null;
      let contactLoad = 0;
      const ledgeTreadFraction = ledgeSemantics[wIdx]?.treadFraction ?? 0;
      if (ledge && ledgeFrame && ledgeTreadFraction > 0) {
        contactLoad = Math.max(0, w.volumeSupport ? (w.lastForce ?? 0) : ledgeLoads[wIdx]!);
      } else if (w.contact) {
        contactLoad = Math.max(0, w.lastForce ?? 0);
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
      const driveTq = ag.hasDrive ? totalDrivelineTorque * driveShare : 0;
      // The handbrake is rear-only and carries its own force: it has to
      // exceed the rear tyre's grip to lock the wheel, where the service
      // brake deliberately stays under it. Sharing brakeForce made the clamp
      // below bind on force rather than grip, which is threshold braking.
      const brakeForceN =
        this.input.brake * TUNING.brakeForce
        + (isFront ? 0 : this.input.handbrake * TUNING.handbrakeForce);
      const brakeTq = brakeForceN * this.geom.wheelRadius;

      // Surface-dependent rolling resistance. Mud and deep mud provide
      // significantly more drag than hard surfaces.
      let rollingMult = 1.0;
      if (w.surface === Surface.Mud) rollingMult = TUNING.rollingResistanceMudMult;
      else if (w.surface === Surface.DeepMud) rollingMult = TUNING.rollingResistanceDeepMudMult;
      const terrainRollingMult = rollingMult;
      // Wading is heavy. Additive on top of the bed's own resistance, so
      // a submerged mud bog is worse than either alone.
      if (w.waterDepth > 0) {
        rollingMult += (WATER.wheelDragMult - 1) * wheelSubmersion(w.waterDepth, this.geom.wheelRadius);
      }
      const rollingResistance = WHEEL.rollingResistance * TUNING.rollingResistanceMult * rollingMult
        * this.geom.spec.rollingResistanceMult
        * (surfaceInfo(w.surface).traction.soil === 'none'
          ? pressureRollingScale(
            this.tirePressurePsi,
            this.geom.spec.tireCarcass.nominalPressurePsi,
          )
          : 1);
      const terrainRollingResistance = WHEEL.rollingResistance
        * TUNING.rollingResistanceMult * terrainRollingMult
        * this.geom.spec.rollingResistanceMult
        // A soft tyre's extra hysteresis is a sealed-surface penalty. In soil
        // its larger footprint is already represented by pressure-dependent
        // bearing/sinkage and must not be charged a second opposing torque.
        * (surfaceInfo(w.surface).traction.soil === 'none'
          ? pressureRollingScale(
            this.tirePressurePsi,
            this.geom.spec.tireCarcass.nominalPressurePsi,
          )
          : 1);

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
      const appliedDriveTq = driveTq;
      debug.driveTorque = appliedDriveTq;
      debug.brakeTorque = brakeTq;
      debug.groundTorque = 0;
      const ledge = ledgeContacts[wIdx];
      const ledgeFrame = ledge
        ? contactFrameInto(ledge.normal, basis.axle, basis.forward, this._contactFrames[wIdx]!)
        : null;
      const treadFraction = ledgeSemantics[wIdx]?.treadFraction ?? 0;
      if (ledge && ledgeFrame && treadFraction > 0) {
        const edgeWrapScale = this.tireEdgeWrapPressureScale * TUNING.tireEdgeWrapMult;
        cp = ledge.point;
        tireLong = ledge.climbDirection ?? ledgeFrame.longitudinal;
        tireLat = ledgeFrame.lateral;
        surfMult = clamp(ledge.friction, 0, 2) * LEDGE_CONTACT.tractionMultiplier
          * edgeWrapScale * treadFraction;
        normalLoad = Math.max(0, w.volumeSupport ? (w.lastForce ?? 0) : ledgeLoads[wIdx]!);
      } else if (w.contact) {
        const supportFrame = contactFrameInto(
          w.contactNormal, basis.axle, basis.forward, this._supportFrames[wIdx]!,
        );
        cp = w.contactPoint;
        tireLong = supportFrame?.longitudinal ?? basis.forward;
        tireLat = supportFrame?.lateral ?? basis.axle;
        surfMult = w.supportGrip * w.treadFraction;
        normalLoad = Math.max(0, w.lastForce ?? 0);
      } else {
        // No torque-transmitting patch on a free wheel.
        stepSoftGround(
          w, 'none', 0, this.tirePressurePsi,
          this.geom.wheelWidth, this.geom.wheelRadius, 0, 0, dt,
          w.soilResult,
        );
        debug.driveTorque = 0;
        debug.contact = false;
        debug.surface = w.surface;
        debug.waterDepth = w.waterDepth;
        debug.normalLoad = 0;
        debug.gripCoefficient = 0;
        debug.gripLimit = 0;
        debug.longitudinalForce = 0;
        debug.relaxedLongitudinalForce = w.relaxedLongitudinalForce;
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
        debug.sinkDepth = w.sinkDepth;
        debug.soilDrag = w.bulldozingResistance;
        debug.slipWork = w.slipWork;
        integrateWheelSpin(w, appliedDriveTq, brakeTq, 0, dt, WHEEL.rollingResistance, this.geom.spec.wheelInertiaKgM2);
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
      const patch = this.surfacePatches[wIdx]!;
      if (!ledge && w.supportIsTerrain) {
        sampleContactPatch(this.world.terrain, cp, tireLong, tireLat, this.geom, patch);
      } else {
        setSingleSurfacePatch(patch, w.surface, this.geom, surfMult);
      }
      if (!ledge && w.supportIsTerrain) {
        const wetMult = w.waterDepth > 0
          ? wetGripMult(w.waterDepth, this.geom.wheelRadius) * this.geom.spec.grip.wet
          : 1;
        surfMult = patch.grip * wetMult * w.treadFraction;
        const frictionKey = surfaceInfo(w.surface).friction;
        if (frictionKey === 'road' || frictionKey === 'concrete') {
          surfMult *= sealedRoadPressureGripScale(
            this.tirePressurePsi,
            this.geom.spec.tireCarcass.nominalPressurePsi,
          );
        }
      }
      const referenceLoad = this.geom.spec.massKg * Math.abs(GRAVITY_Y) * 0.25;
      let longGripCap = tyreFrictionCapacity(
        normalLoad,
        TIRE_LONG_FRICTION * TUNING.tireLongGripMult * surfMult * axleGripMult,
        referenceLoad,
        patch.traction.loadSensitivityExponent,
      );

      // Friction circle (elliptical) coupling. We compute the forces
      // needed for zero longitudinal slip and zero lateral velocity,
      // then clamp the combined vector to the available friction limit.
      // This ensures that spinning the wheels (high longitudinal force)
      // reduces the available lateral grip, making the car slide — the
      // essential "drifting in mud" or "power-sliding" feel.
      const wheelSurfaceSpeed = w.angVel * this.geom.wheelRadius;
      const longSlip = (wheelSurfaceSpeed - longV)
        / Math.max(0.5, Math.abs(longV), Math.abs(wheelSurfaceSpeed));
      const soil = stepSoftGround(
        w,
        patch.traction.soil,
        normalLoad,
        this.tirePressurePsi,
        this.geom.wheelWidth,
        this.geom.wheelRadius,
        wheelSurfaceSpeed - longV,
        longV,
        dt,
        w.soilResult,
      );
      longGripCap *= soil.shearMultiplier;
      const slipGrip = longitudinalGripFromSlip(
        longSlip,
        patch.traction.peakSlip,
        patch.traction.slidingToPeak,
      );
      let dynamicLongForce = Math.sign(longSlip) * longGripCap * slipGrip;
      const groundAngVel = longV / this.geom.wheelRadius;
      const staticLongForce = clamp(
        (w.angVel - groundAngVel) * this.geom.spec.wheelInertiaKgM2 / (dt * this.geom.wheelRadius),
        -longGripCap,
        longGripCap,
      );
      const dynamicLongBlend = smoothstep(
        0.25,
        0.5,
        Math.max(Math.abs(longV), Math.abs(wheelSurfaceSpeed)),
      );
      let staticLongCandidate = staticLongForce;
      if (brakeForceN > 0 && brakedNormalLoadTotal > 1e-6) {
        const supportedMass = vehicleMass * normalLoad / brakedNormalLoadTotal;
        // Predict the contact's free velocity after gravity, then request the
        // force that makes it zero this tick. Brake torque and tyre grip are
        // independent caps: the former is applied here and the friction
        // circle below applies the latter.
        const freeLongAccel = GRAVITY_Y * tireLong.y;
        // At walking pace the static branch may use peak grip to hold a
        // grade. Once the wheel is genuinely sliding, its cap follows the
        // surface's sliding tail rather than retaining peak friction.
        const brakeGripCap = longGripCap * (
          1 + (slipGrip - 1) * dynamicLongBlend
        );
        staticLongCandidate = clamp(
          -supportedMass * (longV / dt + freeLongAccel),
          -Math.min(brakeForceN, brakeGripCap),
          Math.min(brakeForceN, brakeGripCap),
        );
        dynamicLongForce = staticLongCandidate;
      }
      const relaxedDynamicLongForce = w.relaxedLongitudinalForce = relaxLongitudinalForce(
        w.relaxedLongitudinalForce,
        dynamicLongForce,
        longV,
        patch.traction.relaxationLength,
        dt,
      );
      // The low-speed constraint is intentionally not relaxation-delayed:
      // a parked tyre must oppose gravity on the first tick rather than roll
      // downhill while a dynamic force state spends metres winding up.
      let rawLongForce = staticLongCandidate
        + (relaxedDynamicLongForce - staticLongCandidate) * dynamicLongBlend;
      if (brakeForceN > 0) {
        // A hydraulic brake imposes the wheel constraint immediately. The
        // available force still follows peak-to-sliding tyre grip above, but
        // delaying it by carcass relaxation lets gravity accelerate a parked
        // truck before the brake reaction exists.
        rawLongForce = staticLongCandidate;
        w.relaxedLongitudinalForce = staticLongCandidate;
      }
      if (dynamicLongBlend < 1) {
        // Carry the static solution into the relaxation state. Otherwise a
        // tyre that acquires a few cm/s while suspension load is settling
        // abruptly reveals a near-zero dynamic history and rolls away before
        // the relaxed force can catch it.
        w.relaxedLongitudinalForce = rawLongForce;
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
      //
      // The ellipse is not enough on its own, though: it scales the two
      // demands by a common factor and so preserves whatever ratio they
      // asked for, which left a locked wheel holding about half its
      // cornering force. lateralGripFromLongitudinalSlip is the missing
      // combined-slip term — the tread displacement spent sliding along the
      // rolling direction is not available to make lateral force with.
      const alpha = slipAngle(latV, longV);
      const latGripMult = lateralGripFromSlipAngle(alpha, patch.traction.lateralPeakAngle)
        * lateralGripFromLongitudinalSlip(longSlip, patch.traction.peakSlip);
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
        * pressureLateralScale(
          this.tirePressurePsi,
          this.geom.spec.tireCarcass.nominalPressurePsi,
        ) * latV * latGripMult;

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

      const combinedForce = combineFrictionEllipse(
        rawLongForce,
        rawLatForce,
        longGripCap,
        longGripCap * TUNING.tireLateralGripRatio,
        this._scratchCombinedForce,
      );
      let finalLongForce = combinedForce.longitudinal;
      if (ledge) {
        finalLongForce = clamp(
          finalLongForce,
          -LEDGE_CONTACT.maxDriveForce,
          LEDGE_CONTACT.maxDriveForce,
        );
      }
      const finalLatForce = combinedForce.lateral;
      let resistiveLongForce = 0;
      // Rolling deformation and bulldozing dissipate energy independently
      // of the soil shear budget, so deep mud remains resistive even when
      // the contact patch cannot transmit much tractive force.
      if (Math.abs(longV) > 1e-4) {
        const rollingDragForce = terrainRollingResistance * Math.abs(longV)
          / (this.geom.wheelRadius * this.geom.wheelRadius);
        resistiveLongForce = -Math.sign(longV) * (rollingDragForce + soil.bulldozingForce);
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

      const utilization = combinedForce.utilization;
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
      debug.longitudinalForce = finalLongForce + resistiveLongForce;
      debug.relaxedLongitudinalForce = rawLongForce;
      debug.lateralForce = finalLatForce;
      // This is the force applied at the patch. The low-speed static holding
      // share is applied centrally below, so it is intentionally absent from
      // the world arrow even though it still consumes the tire budget above.
      debug.force.x = tireLong.x * (finalLongForce + resistiveLongForce) + tireLat.x * contactLatForce;
      debug.force.y = tireLong.y * (finalLongForce + resistiveLongForce) + tireLat.y * contactLatForce;
      debug.force.z = tireLong.z * (finalLongForce + resistiveLongForce) + tireLat.z * contactLatForce;
      debug.slipRatio = longSlip;
      debug.slipAngle = alpha;
      debug.utilization = utilization;
      debug.suspensionCompression = Math.max(0, w.resolvedDepth);
      debug.contactZone = w.contactZone;
      debug.treadFraction = w.treadFraction;
      debug.suspensionAxisAlignment = w.suspensionAxisAlignment;
      debug.carcassDeflection = w.tireDeflection;
      debug.suspensionForce = w.suspensionForce;
      debug.carcassForce = w.carcassForce;
      debug.sinkDepth = w.sinkDepth;
      debug.soilDrag = w.bulldozingResistance;
      debug.slipWork = w.slipWork;

      // Update wheel angular velocity using the force actually transmitted
      // through the contact patch (impulse-clamped integration).
      const finalGroundTq = -finalLongForce * this.geom.wheelRadius;
      debug.groundTorque = finalGroundTq;
      integrateWheelSpin(w, appliedDriveTq, brakeTq, finalGroundTq, dt, rollingResistance, this.geom.spec.wheelInertiaKgM2);
      debug.angularVelocity = w.angVel;
      if (ledge && ledgeFrame) {
        w.ledgeLongForce = finalLongForce;
      }

      // Apply combined tire force to chassis at contact point.
      const f = this._scratchForce;
      f.x = tireLong.x * (finalLongForce + resistiveLongForce) + tireLat.x * contactLatForce;
      f.y = tireLong.y * (finalLongForce + resistiveLongForce) + tireLat.y * contactLatForce;
      f.z = tireLong.z * (finalLongForce + resistiveLongForce) + tireLat.z * contactLatForce;
      this.body.addForceAtPoint(f, cp, true);
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

  pressureStatus(): PressureStatus {
    const adjusting = this.input.pressureAdjust ?? 0;
    return {
      currentPsi: this.tirePressurePsi,
      nominalPsi: this.geom.spec.tireCarcass.nominalPressurePsi,
      minPsi: this.minimumPressurePsi(),
      maxPsi: this.geom.spec.tireCarcass.maxPressurePsi,
      adjusting,
      reason: this.pressureReason,
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
      pressurePsi: this.tirePressurePsi,
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
        drivenCarrierRpm: this.debugDrivenCarrierRpm,
        differentialReactionTorque: this.debugDifferentialReactionTorque,
      },
      water: {
        submerged: this.waterLoad.submergedFrac,
        buoyancyForce: { x: 0, y: buoyancyY, z: 0 },
        buoyancyPoint,
        dragForce: { ...this.waterLoad.drag },
        dragPoint: { ...this.waterLoad.dragPoint },
        dragTorque: { ...this.waterLoad.dragTorque },
      },
      axles: [
        {
          ...this.axleDebug[0],
          rideVelocity: this.axles[0].rideVelY,
          rollVelocity: this.axles[0].rollVel,
        },
        {
          ...this.axleDebug[1],
          rideVelocity: this.axles[1].rideVelY,
          rollVelocity: this.axles[1].rollVel,
        },
      ],
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

  private minimumPressurePsi(): number {
    const beadlockReduction = this.build.wheelId.endsWith('.beadlock-alloy') ? 4 : 0;
    return Math.max(4, this.geom.spec.tireCarcass.minPressurePsi - beadlockReduction);
  }

  private updatePressure(speed: number, dt: number): void {
    const adjust = this.input.pressureAdjust ?? 0;
    this.pressureReason = null;
    if (adjust === 0) return;
    if (speed >= 1 / 3.6) {
      this.pressureReason = 'Stop below 1 km/h to adjust tyre pressure.';
      return;
    }
    if (Math.abs(this.input.throttle) >= 0.05) {
      this.pressureReason = 'Release the throttle to adjust tyre pressure.';
      return;
    }
    if (adjust > 0 && (this.engine.drowned || this.engine.rpm <= 0)) {
      this.pressureReason = 'Start the engine before inflating.';
      return;
    }
    const min = this.minimumPressurePsi();
    const max = this.geom.spec.tireCarcass.maxPressurePsi;
    const rate = adjust < 0 ? 2 : 1;
    const next = clamp(this.tirePressurePsi + adjust * rate * dt, min, max);
    if (Math.abs(next - this.tirePressurePsi) < 1e-9) {
      this.pressureReason = adjust < 0 ? 'Minimum tyre pressure reached.' : 'Maximum tyre pressure reached.';
      return;
    }
    this.tirePressurePsi = next;
    this.tireEdgeWrapPressureScale = pressureEdgeWrapScale(
      next,
      this.geom.spec.tireCarcass.nominalPressurePsi,
    );
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

  private applyAxleProbe(
    axleIndex: number,
    housing: boolean,
    shape: RAPIER.Shape,
    position: Vec3,
    rotation: { x: number; y: number; z: number; w: number },
    bodyPosition: Vec3,
    linearVelocity: Vec3,
    angularVelocity: Vec3,
    dt: number,
  ): void {
    const step = Math.max(1e-6, dt);
    const velocity = this._scratchProbeVelocity;
    velocity.x = linearVelocity.x * step;
    velocity.y = linearVelocity.y * step - 0.025;
    velocity.z = linearVelocity.z * step;
    const hit = this.world.world.castShape(
      position,
      rotation,
      velocity,
      shape,
      0,
      1,
      true,
      undefined,
      COLLISION_GROUP_WHEEL_RAY,
      undefined,
      this.body,
    );
    if (!hit) return;
    const normal = hit.normal1;
    const normalSpeed = pointVelocityDot(
      linearVelocity, angularVelocity, bodyPosition, position, normal,
    );
    const correctionSpeed = (1 - clamp(hit.time_of_impact, 0, 1)) * 0.0025 / step;
    const impulse = clamp(
      (correctionSpeed - normalSpeed) * this.axles[axleIndex]!.geom.axleMass,
      0,
      LEDGE_CONTACT.maxForce * 0.35 * step,
    );
    if (impulse <= 0) return;
    const force = this._scratchForce;
    force.x = normal.x * impulse;
    force.y = normal.y * impulse;
    force.z = normal.z * impulse;
    this.body.applyImpulseAtPoint(force, position, true);

    const vn = linearVelocity.x * normal.x
      + linearVelocity.y * normal.y
      + linearVelocity.z * normal.z;
    const tx = linearVelocity.x - normal.x * vn;
    const ty = linearVelocity.y - normal.y * vn;
    const tz = linearVelocity.z - normal.z * vn;
    const tangentSpeed = Math.hypot(tx, ty, tz);
    if (tangentSpeed > 1e-6) {
      const tangentImpulse = Math.min(
        impulse * this.axles[axleIndex]!.geom.probe.friction,
        tangentSpeed * this.axles[axleIndex]!.geom.axleMass,
      );
      force.x = -tx / tangentSpeed * tangentImpulse;
      force.y = -ty / tangentSpeed * tangentImpulse;
      force.z = -tz / tangentSpeed * tangentImpulse;
      this.body.applyImpulseAtPoint(force, position, true);
    }
    const debug = this.axleDebug[axleIndex]!;
    if (housing) debug.housingContact = true;
    else debug.tubeContact = true;
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
    const semantics = classifyTireContactInto(
      out.contactNormal.x * wheelAxle.x
      + out.contactNormal.y * wheelAxle.y
      + out.contactNormal.z * wheelAxle.z,
      _castSemantics,
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
    const center = _castCenter;
    center.x = origin.x + dir.x * hit.time_of_impact;
    center.y = origin.y + dir.y * hit.time_of_impact;
    center.z = origin.z + dir.z * hit.time_of_impact;
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
      const axle = _castAxle;
      _castUp.x = 0; _castUp.y = 1; _castUp.z = 0;
      rotateVecByQuatInto(_castUp, rotation, axle);
      const axialDot = normal.x * axle.x + normal.y * axle.y + normal.z * axle.z;
      const radial = _castRadial;
      radial.x = normal.x - axle.x * axialDot;
      radial.y = normal.y - axle.y * axialDot;
      radial.z = normal.z - axle.z * axialDot;
      const radialLength = Math.hypot(radial.x, radial.y, radial.z);
      const radialScale = radialLength > 1e-8 ? wheelRadius / radialLength : 0;
      const capScale = Math.sign(axialDot) * wheelHalfWidth;
      out.contact = true;
      out.contactDepth = restLength - hit.time_of_impact;
      out.contactPoint.x = center.x - radial.x * radialScale - axle.x * capScale;
      out.contactPoint.y = center.y - radial.y * radialScale - axle.y * capScale;
      out.contactPoint.z = center.z - radial.z * radialScale - axle.z * capScale;
      out.contactNormal.x = normal.x;
      out.contactNormal.y = normal.y;
      out.contactNormal.z = normal.z;
      out.supportIsTerrain = true;
      out.supportColliderFriction = hit.collider.friction();
      out.volumeSupport = true;
      const semantics = classifyTireContactInto(axialDot, _castSemantics);
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
  // The world's single Ray, re-pointed rather than reallocated per wheel.
  const ray = world.wheelRay;
  ray.origin = origin;
  ray.dir = dir;
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
    out.contactPoint.x = origin.x + dir.x * toi;
    out.contactPoint.y = origin.y + dir.y * toi;
    out.contactPoint.z = origin.z + dir.z * toi;
    out.contactNormal.x = hit.normal.x;
    out.contactNormal.y = hit.normal.y;
    out.contactNormal.z = hit.normal.z;
    out.supportIsTerrain = hit.collider.handle === world.terrainCollider.handle;
    out.supportColliderFriction = hit.collider.friction();
  } else {
    out.contact = false;
    out.contactDepth = 0;
    out.contactPoint.x = origin.x + dir.x * maxToi;
    out.contactPoint.y = origin.y + dir.y * maxToi;
    out.contactPoint.z = origin.z + dir.z * maxToi;
    out.contactNormal.x = 0;
    out.contactNormal.y = 1;
    out.contactNormal.z = 0;
    out.supportIsTerrain = true;
    out.supportColliderFriction = 1;
  }
}

// Scratch for the two cast helpers above and the sidewall fallback below.
// Module-level rather than per-vehicle: their lifetime is a single call, and
// owner physics steps one vehicle at a time.
const _castCenter: Vec3 = { x: 0, y: 0, z: 0 };
const _castAxle: Vec3 = { x: 0, y: 0, z: 0 };
const _castUp: Vec3 = { x: 0, y: 0, z: 0 };
const _castRadial: Vec3 = { x: 0, y: 0, z: 0 };
const _castSemantics: TireContactSemantics = {
  zone: 'tread', treadFraction: 0, axleAlignment: 0,
};
const _sidewallSemantics: TireContactSemantics = {
  zone: 'tread', treadFraction: 0, axleAlignment: 0,
};

/** @hotloop */
function wheelCenterWorldPoseInto(
  bodyPosition: Vec3,
  bodyRotation: { x: number; y: number; z: number; w: number },
  geom: AxleGeom,
  rideY: number,
  rollAngle: number,
  localX: number,
  local: Vec3,
  out: Vec3,
): Vec3 {
  const cr = Math.cos(rollAngle);
  const sr = Math.sin(rollAngle);
  local.x = localX * cr;
  local.y = geom.centerLocalY - geom.suspensionRestLength + rideY + localX * sr;
  local.z = geom.centerLocalZ;
  rotateVecByQuatInto(local, bodyRotation, out);
  out.x += bodyPosition.x;
  out.y += bodyPosition.y;
  out.z += bodyPosition.z;
  return out;
}

/** @hotloop */
function axleBeamRotationInto(
  chassis: { x: number; y: number; z: number; w: number },
  rollAngle: number,
  out: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
  const half = rollAngle * 0.5;
  const z = Math.sin(half);
  const w = Math.cos(half);
  const cx = chassis.x; const cy = chassis.y; const cz = chassis.z; const cw = chassis.w;
  out.x = cx * w + cy * z;
  out.y = cy * w - cx * z;
  out.z = cz * w + cw * z;
  out.w = cw * w - cz * z;
  return out;
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
/** @hotloop */
function findTerrainSidewallContactInto(
  world: World,
  center: Vec3,
  axle: Vec3,
  radius: number,
  halfWidth: number,
  prediction: number,
  out: SteepWheelContact,
): SteepWheelContact | null {
  const h = 0.08;
  const height = sampleHeightBilinear(world.terrain, center.x, center.z);
  const dx = (sampleHeightBilinear(world.terrain, center.x + h, center.z)
    - sampleHeightBilinear(world.terrain, center.x - h, center.z)) / (2 * h);
  const dz = (sampleHeightBilinear(world.terrain, center.x, center.z + h)
    - sampleHeightBilinear(world.terrain, center.x, center.z - h)) / (2 * h);
  const inv = 1 / (Math.hypot(dx, 1, dz) || 1);
  const normalX = -dx * inv; const normalY = inv; const normalZ = -dz * inv;
  const axial = normalX * axle.x + normalY * axle.y + normalZ * axle.z;
  const semantics = classifyTireContactInto(axial, _sidewallSemantics);
  if (semantics.zone !== 'sidewall') return null;
  const extent = halfWidth * Math.abs(axial)
    + radius * Math.sqrt(Math.max(0, 1 - axial * axial));
  const distance = (center.y - height) * normalY - extent;
  if (distance > prediction) return null;
  out.point.x = center.x - normalX * extent;
  out.point.y = center.y - normalY * extent;
  out.point.z = center.z - normalZ * extent;
  out.normal.x = normalX;
  out.normal.y = normalY;
  out.normal.z = normalZ;
  out.climbDirection = null;
  out.climbTopY = null;
  out.distance = distance;
  out.penetration = Math.max(0, -distance);
  out.friction = world.terrainCollider.friction();
  out.timeOfImpact = 0;
  return out;
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

function addPatchSurface(
  out: ContactPatchSample,
  terrain: TerrainData,
  x: number,
  z: number,
  weight: number,
  geom: VehicleGeom,
): void {
  const surface = sampleSurface(terrain, x, z);
  const traction = surfaceInfo(surface).traction;
  out.grip += surfaceGrip(surface, geom) * weight;
  out.traction.peakSlip += traction.peakSlip * weight;
  out.traction.slidingToPeak += traction.slidingToPeak * weight;
  out.traction.relaxationLength += traction.relaxationLength * weight;
  out.traction.lateralPeakAngle += traction.lateralPeakAngle * weight;
  out.traction.loadSensitivityExponent += traction.loadSensitivityExponent * weight;
}

/** Centre plus four footprint samples, weighted 0.40 + 4×0.15. */
function sampleContactPatch(
  terrain: TerrainData,
  point: Vec3,
  longitudinal: Vec3,
  lateral: Vec3,
  geom: VehicleGeom,
  out: ContactPatchSample,
): void {
  out.grip = 0;
  out.traction.peakSlip = 0;
  out.traction.slidingToPeak = 0;
  out.traction.relaxationLength = 0;
  out.traction.lateralPeakAngle = 0;
  out.traction.loadSensitivityExponent = 0;
  out.traction.soil = surfaceInfo(sampleSurface(terrain, point.x, point.z)).traction.soil;
  const longitudinalOffset = geom.wheelRadius * 0.45;
  const lateralOffset = geom.wheelWidth * 0.35;
  addPatchSurface(out, terrain, point.x, point.z, 0.40, geom);
  addPatchSurface(out, terrain,
    point.x + longitudinal.x * longitudinalOffset,
    point.z + longitudinal.z * longitudinalOffset, 0.15, geom);
  addPatchSurface(out, terrain,
    point.x - longitudinal.x * longitudinalOffset,
    point.z - longitudinal.z * longitudinalOffset, 0.15, geom);
  addPatchSurface(out, terrain,
    point.x + lateral.x * lateralOffset,
    point.z + lateral.z * lateralOffset, 0.15, geom);
  addPatchSurface(out, terrain,
    point.x - lateral.x * lateralOffset,
    point.z - lateral.z * lateralOffset, 0.15, geom);
}

function setSingleSurfacePatch(
  out: ContactPatchSample,
  surface: number,
  geom: VehicleGeom,
  grip = surfaceGrip(surface, geom),
): void {
  const traction = surfaceInfo(surface).traction;
  out.grip = grip;
  out.traction.peakSlip = traction.peakSlip;
  out.traction.slidingToPeak = traction.slidingToPeak;
  out.traction.relaxationLength = traction.relaxationLength;
  out.traction.lateralPeakAngle = traction.lateralPeakAngle;
  out.traction.loadSensitivityExponent = traction.loadSensitivityExponent;
  out.traction.soil = traction.soil;
}
