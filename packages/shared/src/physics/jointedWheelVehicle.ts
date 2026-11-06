// PROTOTYPE: a vehicle whose wheels are real rigid bodies.
//
// SolidAxleVehicle keeps one rigid body (the chassis) and reconstructs every
// wheel contact itself: ray and shape casts, ledge classification, witness
// reconstruction, impulse budgets, and post-solve velocity overrides in low
// range. Each new obstacle shape has needed a new special case, and the
// six-log crawl (logCrawl.test.ts) is still red.
//
// This model hands contact to Rapier instead. Wheels are dynamic bodies with
// round-cylinder colliders, hung from solid axle beams by motorised joints:
//
//   chassis --prismatic(Y, spring+damper motor)--> carrier
//   carrier --revolute(Z, roll spring motor, articulation limit)--> axle
//   front:  axle --revolute(Y, steering motor)--> knuckle --prismatic(Y, carcass)--> hub --revolute(X)--> wheel
//   rear:   axle --prismatic(Y, carcass)--> hub --revolute(X)--> wheel
//
// A log, a step, a rock and the ground are then all the same thing: solver
// contacts on a cylinder. There is no ledge path, no witness, no governor.
// What it gives up is the hand-built tyre model: grip is Rapier's isotropic
// Coulomb friction, scaled per wheel by the surface under it, with no slip
// curve, relaxation, soil or carcass. Engine, gearbox and drive selection are
// the shipped ones (engine.ts), and the build's geometry, spring rates,
// masses and articulation come from the same resolved spec.
//
// Not wired for: water, damage, winch-rated loads beyond the external point
// loads, tyre pressure, soil. It exists to answer one question — does
// solver-native wheel contact make the obstacle problems go away — and is
// selected with WorldOptions.vehicleModel = 'jointed' (client: ?rig=jointed).

import RAPIER from '@dimforge/rapier3d-compat';
import {
  BUTTON_FRONT_LOCKER,
  BUTTON_RANGE,
  BUTTON_REAR_LOCKER,
  EMPTY_INPUT,
  type CarKind,
  type DrivetrainState,
  type PlayerInput,
  type TransferCaseMode,
  type VehicleBuild,
  type VehicleDamageState,
  type VehicleState,
} from '../types.js';
import { normalizeVehicleBuild, createStockBuild } from '../vehicleBuild.js';
import {
  ENGINE,
  JOINTED_VEHICLE,
  SURFACE_FRICTION,
  TIRE_LONG_FRICTION,
  VEHICLE,
} from '../constants.js';
import { TUNING } from '../tuning.js';
import { COLLISION_GROUP_OWNED_VEHICLE } from './collisionGroups.js';
import { createDamageState, repairDamage } from './damage.js';
import { createEngineState, stepEngine, type EngineOutput } from './engine.js';
import { steeringLimitForSpeed } from './solidAxleVehicle.js';
import { sampleSurface, surfaceInfo } from './terrain.js';
import { geomFor, spawnYAboveGround, type AxleGeom, type VehicleGeom } from './vehicleGeom.js';
import type { ExternalPointLoad, VehicleLike, VehicleSpawn } from './vehicleTypes.js';
import type { World } from './world.js';

type Vec3 = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };

interface AxleParts {
  geom: AxleGeom;
  carrier: RAPIER.RigidBody;
  axle: RAPIER.RigidBody;
  /** Prismatic position at static load: the spring's sag. */
  staticSag: number;
  /** Chassis-local Y of the carrier anchor at the spring's free length. */
  freeY: number;
}

interface WheelParts {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** The body the wheel's spin joint hangs off: its sprung hub. */
  parent: RAPIER.RigidBody;
  steer: RAPIER.RevoluteImpulseJoint | null;
  spin: number;
  /** Spin rate relative to the parent, positive rolling forward (rad/s). */
  angVel: number;
  contact: boolean;
  lastSurfaceFriction: number;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
/** Cylinder axis is local Y; wheels spin about chassis-local X. */
const WHEEL_COLLIDER_ROTATION: Quat = { x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 };

function rotate(q: Quat, v: Vec3): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function conj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function mul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function yawQuat(yaw: number): Quat {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

const TRANSFER_CYCLE: Record<TransferCaseMode, TransferCaseMode> = { '2h': '4h', '4h': '4l', '4l': '2h' };

export class JointedWheelVehicle implements VehicleLike {
  readonly id: string;
  readonly build: VehicleBuild;
  readonly geom: VehicleGeom;
  readonly body: RAPIER.RigidBody;
  readonly chassis: RAPIER.Collider;
  private readonly world: World;
  private readonly axles: [AxleParts, AxleParts];
  private readonly wheels: [WheelParts, WheelParts, WheelParts, WheelParts];
  private readonly bodies: RAPIER.RigidBody[] = [];
  private readonly wheelMass: number;
  private readonly wheelInertia: number;
  private input: PlayerInput = { ...EMPTY_INPUT };
  private lastButtons = 0;
  private currentSteer = 0;
  private readonly engine = createEngineState();
  private readonly engineOut: EngineOutput = { totalDrivelineTorque: 0, rpm: 0, gear: 0 };
  private lastRpm: number = ENGINE.idleRpm;
  private lastGear = 0;
  private readonly drivetrain: DrivetrainState = { transferCase: '4h', frontLocked: false, rearLocked: false };
  private readonly damage: VehicleDamageState = createDamageState();
  private readonly externalPointLoads: ExternalPointLoad[] = [];
  private notice: string | null = null;

  constructor(
    world: World,
    id: string,
    spawn: VehicleSpawn,
    value: VehicleBuild | CarKind = createStockBuild(),
  ) {
    this.world = world;
    this.id = id;
    this.build = typeof value === 'string' ? createStockBuild(value as never) : normalizeVehicleBuild(value);
    this.geom = geomFor(this.build);
    const spec = this.geom.spec;
    if (spec.drivetrain === 'fixed-rwd') this.drivetrain.transferCase = '2h';

    const half = this.geom.chassisHalfExtents;
    const rot = yawQuat(spawn.yaw ?? 0);
    const origin = spawn.position;
    const at = (local: Vec3): Vec3 => add(origin, rotate(rot, local));

    this.wheelMass = Math.max(15, spec.wheelAssemblyMassKg);
    this.wheelInertia = Math.max(0.5, spec.wheelInertiaKgM2);
    const unsprung = 4 * this.wheelMass + this.geom.front.axleMass + this.geom.rear.axleMass
      + 2 * JOINTED_VEHICLE.carrierMassKg + 2 * JOINTED_VEHICLE.knuckleMassKg;
    const sprung = Math.max(spec.massKg * 0.5, spec.massKg - unsprung);

    // Chassis: the cuboid collider carries no density; mass and inertia come
    // from the build so the CoG is the one the workshop resolved.
    const ix = sprung / 3 * (half.y * half.y + half.z * half.z) * spec.inertiaMult;
    const iy = sprung / 3 * (half.x * half.x + half.z * half.z) * spec.inertiaMult;
    const iz = sprung / 3 * (half.x * half.x + half.y * half.y) * spec.inertiaMult;
    this.body = world.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(origin.x, origin.y, origin.z)
        .setRotation(rot)
        .setAdditionalMassProperties(sprung, spec.centerOfMass, { x: ix, y: iy, z: iz }, IDENTITY)
        .setCanSleep(false),
    );
    this.chassis = world.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setDensity(0)
        .setFriction(0.5)
        .setCollisionGroups(COLLISION_GROUP_OWNED_VEHICLE),
      this.body,
    );
    this.bodies.push(this.body);

    const staticLoadPerAxle = [
      spec.massKg * 0.52 * Math.abs(world.world.gravity.y),
      spec.massKg * 0.48 * Math.abs(world.world.gravity.y),
    ];
    const axleGeoms = [this.geom.front, this.geom.rear] as const;
    const axles: AxleParts[] = [];
    const wheels: WheelParts[] = [];
    for (let a = 0; a < 2; a++) {
      const ag = axleGeoms[a]!;
      const sag = Math.min(ag.suspensionRestLength * 0.8, staticLoadPerAxle[a]! / ag.rideStiffness);
      const freeY = ag.centerLocalY - ag.suspensionRestLength;
      const axleLocal = { x: 0, y: freeY + sag, z: ag.centerLocalZ };
      const axlePos = at(axleLocal);

      const carrier = this.createPart(axlePos, rot, JOINTED_VEHICLE.carrierMassKg, { x: 0.5, y: 0.5, z: 0.5 });
      const prismatic = world.world.createImpulseJoint(
        RAPIER.JointData.prismatic({ x: 0, y: freeY, z: ag.centerLocalZ }, ZERO, { x: 0, y: 1, z: 0 }),
        this.body, carrier, true,
      ) as RAPIER.PrismaticImpulseJoint;
      prismatic.setLimits(Math.min(0, sag - ag.droopMax), sag + ag.bumpMax);
      prismatic.configureMotorModel(RAPIER.MotorModel.ForceBased);
      prismatic.configureMotorPosition(0, ag.rideStiffness, ag.rideDamping * JOINTED_VEHICLE.rideDampingMult);

      const beamInertia = ag.axleMass * ag.trackHalf * ag.trackHalf / 3;
      const axle = this.createPart(axlePos, rot, ag.axleMass, {
        x: beamInertia, y: beamInertia, z: Math.max(ag.axleRollInertia, 1),
      });
      // Axle tube: what strikes a rock between the wheels.
      world.world.createCollider(
        RAPIER.ColliderDesc.capsule(Math.max(0.05, ag.trackHalf - this.geom.wheelWidth * 0.5 - 0.08), ag.probe.tubeRadius)
          .setRotation(WHEEL_COLLIDER_ROTATION)
          .setTranslation(0, ag.probe.verticalOffset, 0)
          .setDensity(0)
          .setFriction(ag.probe.friction)
          .setCollisionGroups(COLLISION_GROUP_OWNED_VEHICLE),
        axle,
      );
      const roll = world.world.createImpulseJoint(
        RAPIER.JointData.revolute(ZERO, ZERO, { x: 0, y: 0, z: 1 }),
        carrier, axle, true,
      ) as RAPIER.RevoluteImpulseJoint;
      const springRoll = ag.rideStiffness * ag.trackHalf * ag.trackHalf;
      const dampRoll = ag.rideDamping * ag.trackHalf * ag.trackHalf;
      roll.setLimits(-ag.maxArticulation, ag.maxArticulation);
      roll.configureMotorModel(RAPIER.MotorModel.ForceBased);
      roll.configureMotorPosition(
        0,
        springRoll + ag.rollStiffness * JOINTED_VEHICLE.antiRollMult,
        dampRoll + ag.rollDamping,
      );
      axles.push({ geom: ag, carrier, axle, staticSag: sag, freeY });

      for (let side = 0; side < 2; side++) {
        const x = side === 0 ? -ag.trackHalf : ag.trackHalf;
        const hubLocal = { x, y: axleLocal.y, z: ag.centerLocalZ };
        const hubPos = at(hubLocal);
        let parent = axle;
        let steer: RAPIER.RevoluteImpulseJoint | null = null;
        if (ag.hasSteering) {
          const knuckle = this.createPart(hubPos, rot, JOINTED_VEHICLE.knuckleMassKg, { x: 0.3, y: 0.3, z: 0.3 });
          steer = world.world.createImpulseJoint(
            RAPIER.JointData.revolute({ x, y: 0, z: 0 }, ZERO, { x: 0, y: 1, z: 0 }),
            axle, knuckle, true,
          ) as RAPIER.RevoluteImpulseJoint;
          steer.configureMotorModel(RAPIER.MotorModel.ForceBased);
          steer.configureMotorPosition(0, JOINTED_VEHICLE.steerStiffness, JOINTED_VEHICLE.steerDamping);
          parent = knuckle;
        }
        const r = this.geom.wheelRadius;
        const halfWidth = this.geom.wheelWidth * 0.5;
        const cornerLoad = spec.massKg * Math.abs(world.world.gravity.y) * 0.25;
        const tyreRate = cornerLoad / Math.max(0.005, spec.tireCarcass.staticDeflectionRatio * r);
        const tyreDamping = 2 * spec.tireCarcass.radialDampingRatio
          * Math.sqrt(tyreRate * (this.wheelMass + ag.axleMass * 0.5));
        const border = Math.min(JOINTED_VEHICLE.tyreBorderRadius, halfWidth * 0.8, r * 0.3);
        const wheelBody = this.createPart(hubPos, rot, this.wheelMass, {
          x: this.wheelInertia,
          y: this.wheelInertia * 0.55,
          z: this.wheelInertia * 0.55,
        });
        wheelBody.enableCcd(true);
        const collider = world.world.createCollider(
          RAPIER.ColliderDesc.roundCylinder(halfWidth - border, r - border, border)
            .setRotation(WHEEL_COLLIDER_ROTATION)
            .setDensity(0)
            .setFriction(TIRE_LONG_FRICTION)
            .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
            .setCollisionGroups(COLLISION_GROUP_OWNED_VEHICLE),
          wheelBody,
        );
        // Radial carcass compliance: the wheel spins on a hub that slides
        // along the parent's up axis against the tyre's own spring. Without it
        // a rigid cylinder meeting a hub-height log pops straight onto the
        // crest and throws the chassis up with it.
        const hub = this.createPart(hubPos, rot, JOINTED_VEHICLE.hubMassKg, { x: 0.2, y: 0.2, z: 0.2 });
        const radial = world.world.createImpulseJoint(
          RAPIER.JointData.prismatic(ag.hasSteering ? ZERO : { x, y: 0, z: 0 }, ZERO, { x: 0, y: 1, z: 0 }),
          parent, hub, true,
        ) as RAPIER.PrismaticImpulseJoint;
        radial.setLimits(-0.01, r * JOINTED_VEHICLE.maxCarcassDeflectionRatio);
        radial.configureMotorModel(RAPIER.MotorModel.ForceBased);
        radial.configureMotorPosition(0, tyreRate, tyreDamping);
        world.world.createImpulseJoint(
          RAPIER.JointData.revolute(ZERO, ZERO, { x: 1, y: 0, z: 0 }),
          hub, wheelBody, true,
        );
        wheels.push({
          body: wheelBody, collider, parent: hub, steer, spin: 0, angVel: 0, contact: false,
          lastSurfaceFriction: -1,
        });
      }
    }
    this.axles = axles as [AxleParts, AxleParts];
    this.wheels = wheels as [WheelParts, WheelParts, WheelParts, WheelParts];
  }

  private createPart(position: Vec3, rotation: Quat, mass: number, inertia: Vec3): RAPIER.RigidBody {
    const body = this.world.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(rotation)
        .setAdditionalMassProperties(mass, ZERO, inertia, IDENTITY)
        .setCanSleep(false),
    );
    this.bodies.push(body);
    return body;
  }

  setInput(input: PlayerInput): void {
    this.input = input;
  }

  queueExternalPointLoad(load: ExternalPointLoad): void {
    this.externalPointLoads.push({ point: { ...load.point }, force: { ...load.force } });
  }

  /** Spin axis of a wheel in world space (its parent's local +X). */
  private wheelAxis(w: WheelParts): Vec3 {
    return rotate(w.body.rotation(), { x: 1, y: 0, z: 0 });
  }

  private relativeSpin(w: WheelParts, axis: Vec3): number {
    const a = w.body.angvel();
    const p = w.parent.angvel();
    // Rolling forward (+Z) is positive rotation about +X: the contact patch
    // has to move rearward relative to the hub.
    return (a.x - p.x) * axis.x + (a.y - p.y) * axis.y + (a.z - p.z) * axis.z;
  }

  /** Torque about the spin axis, positive driving forward, reacted by the
   *  parent so it is internal to the vehicle (axle wrap, not a free moment). */
  private applyWheelTorque(w: WheelParts, axis: Vec3, torque: number): void {
    if (torque === 0) return;
    const t = torque;
    w.body.addTorque({ x: axis.x * t, y: axis.y * t, z: axis.z * t }, true);
    w.parent.addTorque({ x: -axis.x * t, y: -axis.y * t, z: -axis.z * t }, true);
  }

  preStep(): void {
    const dt = this.world.substepDt;
    for (const b of this.bodies) {
      b.resetForces(false);
      b.resetTorques(false);
    }
    for (const load of this.externalPointLoads) this.body.addForceAtPoint(load.force, load.point, true);
    if (this.world.lastSubstep) this.externalPointLoads.length = 0;

    const q = this.body.rotation();
    const lv = this.body.linvel();
    const fwd = rotate(q, { x: 0, y: 0, z: 1 });
    const longSpeed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const groundSpeed = Math.hypot(lv.x, lv.z);
    if (this.world.substepIndex === 0) this.updateDrivetrainControls(groundSpeed);

    // Steering: the shipped rate limit, then a position motor on each knuckle.
    const steerLimit = steeringLimitForSpeed(
      TUNING.maxSteer * this.geom.spec.maxSteerMult, this.geom.spec.wheelbase, groundSpeed,
    );
    const target = clamp(this.input.steer * steerLimit, -steerLimit, steerLimit);
    const maxStep = TUNING.steerSpeed * this.geom.spec.steeringResponse * dt;
    this.currentSteer += clamp(target - this.currentSteer, -maxStep, maxStep);
    for (const w of this.wheels) {
      // Positive steer turns right (toward +X ahead), a negative yaw about +Y.
      w.steer?.configureMotorPosition(-this.currentSteer, JOINTED_VEHICLE.steerStiffness, JOINTED_VEHICLE.steerDamping);
    }

    // Surface grip, sampled under each wheel: friction is the whole tyre model.
    const terrain = this.world.terrain;
    for (const w of this.wheels) {
      const p = w.body.translation();
      const key = surfaceInfo(sampleSurface(terrain, p.x, p.z)).friction;
      const mu = TIRE_LONG_FRICTION * SURFACE_FRICTION[key] * TUNING.tireLongGripMult;
      if (mu !== w.lastSurfaceFriction) {
        w.collider.setFriction(mu);
        w.lastSurfaceFriction = mu;
      }
    }

    const axes = this.wheels.map((w) => this.wheelAxis(w));
    for (let i = 0; i < 4; i++) this.wheels[i]!.angVel = this.relativeSpin(this.wheels[i]!, axes[i]!);
    const frontCarrier = (this.wheels[0].angVel + this.wheels[1].angVel) * 0.5;
    const rearCarrier = (this.wheels[2].angVel + this.wheels[3].angVel) * 0.5;
    const fourWd = this.drivetrain.transferCase !== '2h';
    const drivenCarrier = fourWd ? (frontCarrier + rearCarrier) * 0.5 : rearCarrier;

    const throttle = this.input.manualGear === null ? this.input.throttle : Math.max(0, this.input.throttle);
    const lowRange = this.drivetrain.transferCase === '4l';
    const out = stepEngine(
      this.engine,
      drivenCarrier,
      Math.abs(longSpeed) / this.geom.wheelRadius,
      throttle,
      dt,
      this.input.manualGear,
      ENGINE.finalDrive * this.geom.spec.finalDriveMult * (lowRange ? this.geom.spec.lowRangeRatio : 1),
      this.engineOut,
      this.world.substeps,
    );
    this.lastRpm = out.rpm;
    this.lastGear = out.gear;
    const total = out.totalDrivelineTorque * this.geom.powerMult;
    const frontShare = fourWd && this.geom.front.hasDrive ? 0.5 : 0;
    const axleTorque = [total * frontShare, total * (1 - frontShare)];

    // Open differentials split torque equally; a locker and a part-time
    // transfer case add the coupling torque that equalises the two sides
    // within one substep, bounded so a gripping tyre is never wound backward
    // by a free one.
    const torques = [axleTorque[0]! * 0.5, axleTorque[0]! * 0.5, axleTorque[1]! * 0.5, axleTorque[1]! * 0.5];
    const couple = (a: number, b: number, inertia: number): number =>
      clamp((a - b) * inertia / (2 * dt), -JOINTED_VEHICLE.lockerMaxTorque, JOINTED_VEHICLE.lockerMaxTorque);
    if (this.drivetrain.frontLocked) {
      const c = couple(this.wheels[0].angVel, this.wheels[1].angVel, this.wheelInertia);
      torques[0]! -= c; torques[1]! += c;
    }
    if (this.drivetrain.rearLocked || this.geom.spec.drivetrain === 'fixed-rwd') {
      const c = couple(this.wheels[2].angVel, this.wheels[3].angVel, this.wheelInertia);
      torques[2]! -= c; torques[3]! += c;
    }
    if (fourWd) {
      const c = couple(frontCarrier, rearCarrier, this.wheelInertia * 2) * 0.5;
      torques[0]! -= c; torques[1]! -= c; torques[2]! += c; torques[3]! += c;
    }

    // Brakes stop a wheel's spin relative to its hub; they never reverse it.
    const brake = Math.max(0, this.input.brake);
    const handbrake = this.input.handbrake ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i]!;
      const maxBrake = brake * VEHICLE.brakeForce * this.geom.wheelRadius
        + (i >= 2 ? handbrake * VEHICLE.handbrakeForce * this.geom.wheelRadius : 0);
      let t = torques[i]!;
      if (maxBrake > 0) t -= Math.sign(w.angVel) * Math.min(maxBrake, Math.abs(w.angVel) * this.wheelInertia / dt);
      t -= w.angVel * JOINTED_VEHICLE.hubDrag;
      this.applyWheelTorque(w, axes[i]!, t);
    }
  }

  postStep(): void {
    const dt = this.world.substepDt;
    for (const w of this.wheels) w.spin += w.angVel * dt;
    if (!this.world.lastSubstep) return;
    for (const w of this.wheels) {
      let touching = false;
      this.world.world.contactPairsWith(w.collider, (other) => {
        if (touching) return;
        this.world.world.contactPair(w.collider, other, (manifold) => {
          if (manifold.numContacts() > 0) touching = true;
        });
      });
      w.contact = touching;
    }
  }

  private updateDrivetrainControls(speed: number): void {
    const rising = this.input.buttons & ~this.lastButtons;
    this.lastButtons = this.input.buttons;
    if (this.geom.spec.drivetrain === 'fixed-rwd') return;
    const canShift = speed <= 5.6 && Math.abs(this.input.throttle) < 0.18;
    const requested = this.input.transferCase
      ?? ((rising & BUTTON_RANGE) !== 0 ? TRANSFER_CYCLE[this.drivetrain.transferCase] : null);
    if (requested !== null && requested !== this.drivetrain.transferCase) {
      if (canShift) this.drivetrain.transferCase = requested;
      else this.notice = 'Slow down and release the throttle to move the transfer case.';
    }
    if ((rising & BUTTON_REAR_LOCKER) !== 0 && this.build.rearLocker) this.drivetrain.rearLocked = !this.drivetrain.rearLocked;
    if ((rising & BUTTON_FRONT_LOCKER) !== 0 && this.build.frontLocker) this.drivetrain.frontLocked = !this.drivetrain.frontLocked;
  }

  /** Axle pose relative to the chassis, in the units the renderer reads:
   *  rideY is compression from the spring's free length, rollAngle the beam's
   *  rotation about chassis-forward. */
  private axleSnap(a: AxleParts): { rideY: number; rollAngle: number } {
    const cq = this.body.rotation();
    const ct = this.body.translation();
    const at = a.axle.translation();
    const inv = conj(cq);
    const local = rotate(inv, { x: at.x - ct.x, y: at.y - ct.y, z: at.z - ct.z });
    const rel = mul(inv, a.axle.rotation());
    return { rideY: local.y - a.freeY, rollAngle: 2 * Math.atan2(rel.z, rel.w) };
  }

  /** Per-wheel ground contact as of the last completed tick. */
  wheelContacts(): [boolean, boolean, boolean, boolean] {
    return [this.wheels[0].contact, this.wheels[1].contact, this.wheels[2].contact, this.wheels[3].contact];
  }

  getState(): VehicleState {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const front = this.axleSnap(this.axles[0]);
    const rear = this.axleSnap(this.axles[1]);
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
      wheels: this.wheels.map((w, i) => {
        const ax = i < 2 ? this.axles[0] : this.axles[1];
        const ride = i < 2 ? front.rideY : rear.rideY;
        return {
          steer: i < 2 ? this.currentSteer : 0,
          spin: w.spin,
          contact: w.contact,
          suspensionLength: Math.max(0, ax.geom.suspensionRestLength - ride),
          angVel: w.angVel,
          tireDeflection: 0,
          tireContactNormal: { x: 0, y: 1, z: 0 },
        };
      }),
      axles: [front, rear],
    };
  }

  drivetrainStatus(): DrivetrainState {
    return { ...this.drivetrain };
  }

  damageStatus(): VehicleDamageState {
    return { ...this.damage };
  }

  repair(): void {
    repairDamage(this.damage);
  }

  consumeDrivetrainNotice(): string | null {
    const n = this.notice;
    this.notice = null;
    return n;
  }

  resetTo(spawn: VehicleSpawn): void {
    const rot = yawQuat(spawn.yaw ?? 0);
    const prev = this.body.translation();
    const prevRot = this.body.rotation();
    const inv = conj(prevRot);
    const y = Math.max(spawn.position.y, spawnYAboveGround(this.build));
    const origin = { x: spawn.position.x, y, z: spawn.position.z };
    for (const b of this.bodies) {
      const p = b.translation();
      const local = rotate(inv, { x: p.x - prev.x, y: p.y - prev.y, z: p.z - prev.z });
      const pos = add(origin, rotate(rot, local));
      b.setTranslation(pos, true);
      b.setRotation(mul(rot, mul(inv, b.rotation())), true);
      b.setLinvel(ZERO, true);
      b.setAngvel(ZERO, true);
    }
    Object.assign(this.engine, createEngineState());
    this.currentSteer = 0;
    this.externalPointLoads.length = 0;
  }

  dispose(): void {
    for (const b of this.bodies) this.world.world.removeRigidBody(b);
    this.bodies.length = 0;
  }
}
