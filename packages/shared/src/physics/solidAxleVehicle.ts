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
//
// See the matching Phase 1 plan in CLAUDE.md / the suspension overhaul plan.

import RAPIER from '@dimforge/rapier3d-compat';
import {
  FIXED_DT,
  GRAVITY_Y,
  TIRE_LATERAL,
  TIRE_LONG_FRICTION,
  VEHICLE,
} from '../constants.js';
import { TUNING } from '../tuning.js';
import {
  EMPTY_INPUT,
  type CarKind,
  type PlayerInput,
  type VehicleState,
  type WheelState,
} from '../types.js';
import { Surface, sampleSurface } from './terrain.js';
import { createEngineState, stepEngine, type EngineState } from './engine.js';
import { slipRatio, gripFromSlip } from './tire.js';
import { rotateVecByQuat } from './util.js';
import { geomFor, type VehicleGeom } from './vehicleGeom.js';
import {
  applyAxleSnap,
  axleSnap,
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
  VehicleLike,
  VehicleSpawn,
  WheelSample,
} from './vehicleTypes.js';
import type { World } from './world.js';

// Anti-roll bar: chassis-frame torque proportional to world-roll about
// the chassis-forward axis. The per-wheel-end ride forces already give
// static roll stability, but cornering hard unloads (or lifts) the
// inside wheels and that loses much of the restoring torque exactly
// when the chassis needs it. The sway bar fills the gap. Damping
// targets just past critical so cornering body roll settles in a
// single half-cycle instead of oscillating - the previous 67% critical
// rate left a ~1.8 Hz body-roll bounce that read as "body stutter while
// the wheels stay smooth" because it only fires when wheels are
// loading the chassis.
//   c_crit = 2*sqrt(k*I) ~ 2*sqrt(120000*900) ~ 20800 N*m*s/rad.
const ANTI_ROLL_STIFFNESS = 120_000;
const ANTI_ROLL_DAMPING = 22_000;

type Vec3 = { x: number; y: number; z: number };

export class SolidAxleVehicle implements VehicleLike {
  private readonly world: World;
  readonly id: string;
  readonly body: RAPIER.RigidBody;
  readonly chassis: RAPIER.Collider;
  readonly geom: VehicleGeom;

  private input: PlayerInput = { ...EMPTY_INPUT };
  private currentSteer = 0;

  private readonly axles: [AxleState, AxleState];
  private readonly wheels: [WheelKinematic, WheelKinematic, WheelKinematic, WheelKinematic];

  private engine: EngineState = createEngineState();
  private lastRpm = 0;
  private lastGear = 0;

  constructor(world: World, id: string, spawn: VehicleSpawn, kind: CarKind = 'patrol') {
    this.world = world;
    this.id = id;
    this.geom = geomFor(kind);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
      .setLinearDamping(0.1)
      .setAngularDamping(0.5)
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
    const colHalfH = (VEHICLE.cabinRoofY + ext.y) / 2;
    const colOffsetY = -ext.y + colHalfH; // center between chassis-bottom and roof
    const colDesc = RAPIER.ColliderDesc.roundCuboid(ext.x - r, colHalfH - r, ext.z - r, r)
      .setTranslation(0, colOffsetY, 0)
      .setDensity(VEHICLE.mass / (8 * ext.x * ext.y * ext.z))
      .setFriction(0.3);
    this.chassis = world.world.createCollider(colDesc, this.body);
    // Same low CoM trick the legacy Vehicle uses: pull principal moments
    // toward a low centre so the chassis feels bottom-heavy and resists
    // rollovers despite the tall visual cabin.
    this.body.setAdditionalMassProperties(
      0,
      { x: 0, y: -ext.y * 0.6, z: 0 },
      { x: VEHICLE.mass * 0.6, y: VEHICLE.mass * 0.5, z: VEHICLE.mass * 0.6 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

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
  }

  setInput(input: PlayerInput): void {
    this.input = input;
  }

  setSteerAngle(angle: number): void {
    this.currentSteer = angle;
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
    this.input = { ...EMPTY_INPUT };
    for (const a of this.axles) resetAxleState(a);
    for (const w of this.wheels) resetWheelKinematic(w);
    this.engine = createEngineState();
    this.lastRpm = 0;
    this.lastGear = 0;
  }

  preStep(): void {
    const dt = FIXED_DT;

    // CRITICAL: Rapier accumulates external forces across step() calls
    // until reset. Without these calls, last tick's spring force would
    // add to this tick's, causing a runaway upward force after a few
    // ticks of contact. Reset here so each tick's force is fresh.
    this.body.resetForces(false);
    this.body.resetTorques(false);

    // 1. Capture chassis pose ONCE (determinism rule).
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const fwd = rotateVecByQuat({ x: 0, y: 0, z: 1 }, r);
    const right = rotateVecByQuat({ x: 1, y: 0, z: 0 }, r);
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, r);

    // 2. Smooth steering.
    const targetSteer = this.input.steer * TUNING.maxSteer;
    const steerDelta = targetSteer - this.currentSteer;
    const maxStep = TUNING.steerSpeed * dt;
    this.currentSteer +=
      Math.abs(steerDelta) < maxStep ? steerDelta : Math.sign(steerDelta) * maxStep;

    // 3. Per axle: raycast wheel-ends, integrate axle DOFs, apply chassis
    //    reaction forces. Raycast origins are FIXED in chassis-local space
    //    (do NOT include axle articulation) - this avoids a feedback loop
    //    where the axle's roll changes the rays which changes the target
    //    roll which changes the rays again.
    for (let aIdx = 0; aIdx < 2; aIdx++) {
      const axle = this.axles[aIdx]!;
      const ag = axle.geom;

      const wIdxL = aIdx * 2;
      const wIdxR = aIdx * 2 + 1;
      const wL = this.wheels[wIdxL]!;
      const wR = this.wheels[wIdxR]!;

      const leftLocal = { x: -ag.trackHalf, y: ag.centerLocalY, z: ag.centerLocalZ };
      const rightLocal = { x: +ag.trackHalf, y: ag.centerLocalY, z: ag.centerLocalZ };
      const leftWorld = addVec(t, rotateVecByQuat(leftLocal, r));
      const rightWorld = addVec(t, rotateVecByQuat(rightLocal, r));

      const rayDir: Vec3 = { x: 0, y: -1, z: 0 };
      const maxToi = ag.suspensionRestLength + this.geom.wheelRadius + 0.10;

      castWheelRay(this.world, this.body, leftWorld, rayDir, maxToi, ag.suspensionRestLength, this.geom.wheelRadius, wL);
      castWheelRay(this.world, this.body, rightWorld, rayDir, maxToi, ag.suspensionRestLength, this.geom.wheelRadius, wR);

      wL.surface = sampleSurface(this.world.terrain, wL.contactPoint.x, wL.contactPoint.z);
      wR.surface = sampleSurface(this.world.terrain, wR.contactPoint.x, wR.contactPoint.z);

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
        leftDepth: wL.contactDepth,
        rightDepth: wR.contactDepth,
        leftContact: wL.contact,
        rightContact: wR.contact,
        chassisVertVelAtAnchor: 0, // unused now; per-wheel damping below
        dt,
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
      const sides: Array<{ wheel: WheelKinematic; localX: number; world: Vec3 }> = [
        { wheel: wL, localX: -ag.trackHalf, world: leftWorld },
        { wheel: wR, localX: +ag.trackHalf, world: rightWorld },
      ];
      for (const side of sides) {
        const w = side.wheel;
        if (!w.contact) continue;
        const comp = Math.min(ag.bumpMax, Math.max(0, w.contactDepth));
        if (comp <= 0) continue;
        // Chassis vertical velocity AT this wheel-end (world frame).
        const armX = side.world.x - t.x;
        const armY = side.world.y - t.y;
        const armZ = side.world.z - t.z;
        const vpX = lv.x + av.y * armZ - av.z * armY;
        const vpY = lv.y + av.z * armX - av.x * armZ;
        const vpZ = lv.z + av.x * armY - av.y * armX;
        const vertVel = vpX * up.x + vpY * up.y + vpZ * up.z;
        // Engagement ramps from 0→1 as compression reaches ~0.05m
        // (typical equilibrium). Was comp*12 which only reached 0.55 at
        // equilibrium, leaving the chassis underdamped and oscillatory.
        const engagement = Math.min(1, comp / 0.05);
        // Per-wheel-end stiffness is HALF the axle's total because both
        // wheels share the load (parallel springs sum to k_total).
        const F = 0.5 * ag.rideStiffness * comp
                - 0.5 * ag.rideDamping * engagement * vertVel;
        this.body.addForceAtPoint(
          { x: up.x * F, y: up.y * F, z: up.z * F },
          side.world,
          true,
        );
      }

      // Roll torque dump when terrain demands more articulation than the
      // axle can absorb. Below the cap the per-wheel-end forces above
      // already provide the correct chassis-axle coupling; past the cap
      // the axle has bottomed against its mechanical stop and the
      // surplus has to lever the chassis itself - that's the body-lean-
      // over-a-rock behaviour.
      if (Math.abs(result.chassisRollTorque) > 1e-6) {
        const tq = result.chassisRollTorque;
        this.body.addTorque(
          { x: fwd.x * tq, y: fwd.y * tq, z: fwd.z * tq },
          true,
        );
      }
    }

    // 3b. Anti-roll bar. The per-wheel-end ride forces give static roll
    //     stability, but in hard cornering the inside wheels unload
    //     (or lift) so their share of the restoring torque vanishes
    //     just when you need it most. A real off-roader fits a sway bar
    //     to keep some roll resistance even when the inside is in the
    //     air. Modelled here as a chassis-frame torque proportional to
    //     the chassis's world-roll angle about its forward axis, plus a
    //     velocity damping term.
    //
    //     Roll proxy: chassis-right's vertical (world-y) component.
    //     With chassis upright that's zero; rolled right by alpha (right
    //     side up) it's sin(alpha); independent of yaw and pitch. The
    //     OLD formula was up.dot(right), which is identically zero for
    //     any rotation - up and right are chassis-frame basis vectors
    //     and stay orthogonal under any rigid rotation - so the spring
    //     term was always zero and only the damper was firing. Body
    //     roll under cornering had no restoring force, only velocity
    //     decay, which read as the body being unable to settle while
    //     wheels were loading the chassis.
    {
      const rollSin = right.y;
      const rollVel = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
      const tq = -ANTI_ROLL_STIFFNESS * rollSin - ANTI_ROLL_DAMPING * rollVel;
      this.body.addTorque(
        { x: fwd.x * tq, y: fwd.y * tq, z: fwd.z * tq },
        true,
      );
    }

    // 4. Engine + gearbox.
    const avgAngVel = (this.wheels[0]!.angVel + this.wheels[1]!.angVel + this.wheels[2]!.angVel + this.wheels[3]!.angVel) / 4;
    const longSpeed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const signedAvg = Math.sign(longSpeed || avgAngVel) * Math.abs(avgAngVel);
    // vehicleAngVel is chassis speed expressed as equivalent wheel rad/s.
    // Passed separately so the engine uses it for shift decisions without
    // being confused by wheel slip (see engine.ts for the full rationale).
    const vehicleAngVel = Math.abs(longSpeed) / this.geom.wheelRadius;
    const engineOut = stepEngine(this.engine, signedAvg, vehicleAngVel, this.input.throttle, dt);
    this.lastRpm = engineOut.rpm;
    this.lastGear = engineOut.gear;
    const drivePerWheelTorque = engineOut.wheelForce; // engine.ts returns torque-shaped values

    // Incline assist (matches legacy semantics).
    const climb = Math.min(0.5, Math.max(0, fwd.y));
    const inclineMult = 1 + (climb / 0.5) * TUNING.inclineAssistMax;

    // 5. Diff lock equalisation (per axle, before slip).
    if (TUNING.diffLockFront) {
      const a = this.wheels[0]!, b = this.wheels[1]!;
      const avg = 0.5 * (a.angVel + b.angVel);
      a.angVel = avg; b.angVel = avg;
    }
    if (TUNING.diffLockRear) {
      const a = this.wheels[2]!, b = this.wheels[3]!;
      const avg = 0.5 * (a.angVel + b.angVel);
      a.angVel = avg; b.angVel = avg;
    }

    // 6. Per wheel tire forces + spin integration.
    const frontShare = VEHICLE.driveSplit.front;
    const rearShare = VEHICLE.driveSplit.rear;

    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const w = this.wheels[wIdx]!;
      const isFront = wIdx < 2;
      const axle = isFront ? this.axles[0]! : this.axles[1]!;
      const ag = axle.geom;

      // Wheel forward direction (steered for front wheels). Steering
      // rotates fwd about chassis-up by -currentSteer. The sign matches
      // what the legacy renderer applies to the wheel mesh and what
      // Rapier's vehicle controller does internally given the (-1,0,0)
      // axle convention - positive player intent (D / right arrow) yaws
      // the chassis right via a force pointing into chassis-right.
      let wheelFwd = fwd;
      let wheelRight = right;
      if (ag.hasSteering && Math.abs(this.currentSteer) > 1e-6) {
        const ang = -this.currentSteer;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const upDotFwd = up.x * fwd.x + up.y * fwd.y + up.z * fwd.z;
        const cross = {
          x: up.y * fwd.z - up.z * fwd.y,
          y: up.z * fwd.x - up.x * fwd.z,
          z: up.x * fwd.y - up.y * fwd.x,
        };
        wheelFwd = {
          x: fwd.x * c + cross.x * s + up.x * upDotFwd * (1 - c),
          y: fwd.y * c + cross.y * s + up.y * upDotFwd * (1 - c),
          z: fwd.z * c + cross.z * s + up.z * upDotFwd * (1 - c),
        };
        wheelRight = {
          x: up.y * wheelFwd.z - up.z * wheelFwd.y,
          y: up.z * wheelFwd.x - up.x * wheelFwd.z,
          z: up.x * wheelFwd.y - up.y * wheelFwd.x,
        };
      }

      const driveShare = (isFront ? frontShare : rearShare) * 0.5; // per wheel
      const driveTq = ag.hasDrive ? drivePerWheelTorque * driveShare : 0;
      const brakeForceN =
        this.input.brake * TUNING.brakeForce
        + (isFront ? 0 : this.input.handbrake * TUNING.brakeForce * 1.5);
      const brakeTq = brakeForceN * this.geom.wheelRadius;

      if (!w.contact) {
        // No ground reaction on a free wheel - drive/brake/rolling only.
        integrateWheelSpin(w, driveTq, brakeTq, 0, dt);
        continue;
      }

      // Velocity of the chassis at the contact point.
      const cp = w.contactPoint;
      const armX = cp.x - t.x;
      const armY = cp.y - t.y;
      const armZ = cp.z - t.z;
      const cvX = lv.x + av.y * armZ - av.z * armY;
      const cvY = lv.y + av.z * armX - av.x * armZ;
      const cvZ = lv.z + av.x * armY - av.y * armX;
      const longV = cvX * wheelFwd.x + cvY * wheelFwd.y + cvZ * wheelFwd.z;
      const latV = cvX * wheelRight.x + cvY * wheelRight.y + cvZ * wheelRight.z;

      // Slip ratio + grip multiplier.
      const slip = slipRatio(w.angVel, this.geom.wheelRadius, longV);
      const surfMult = surfaceGrip(w.surface);
      const slipMult = gripFromSlip(slip);
      const axleGripMult = isFront ? TUNING.frontGripMult : TUNING.rearGripMult;
      // Normal load estimate: even chassis-weight share + extra from
      // spring compression at this wheel-end. The compression term gives
      // higher grip on the wheel that's actually pressed into the ground
      // (load transfer through the axle).
      const baseLoad = VEHICLE.mass * Math.abs(GRAVITY_Y) / 4;
      const loadFromSpring = ag.rideStiffness * Math.max(0, w.contactDepth) * 0.25;
      const normalLoad = baseLoad + loadFromSpring;

      const longGripCap =
        TIRE_LONG_FRICTION * surfMult * axleGripMult * inclineMult * normalLoad;
      const longForceMag = slipMult * longGripCap;
      const longForceSigned = Math.sign(slip) * longForceMag;

      // Ground torque on the wheel = -F_long * R (decelerates a driving
      // wheel; spins up a locked wheel).
      const groundTq = -longForceSigned * this.geom.wheelRadius;
      integrateWheelSpin(w, driveTq, brakeTq, groundTq, dt);

      // Longitudinal force on the chassis at the contact point.
      this.body.addForceAtPoint(
        {
          x: wheelFwd.x * longForceSigned,
          y: wheelFwd.y * longForceSigned,
          z: wheelFwd.z * longForceSigned,
        },
        cp,
        true,
      );

      // Lateral force: linear in lateral velocity, clamped by friction
      // circle (longRatio of the longitudinal cap).
      const latStiff = TUNING.tireLatStiffness;
      const latMax = longGripCap * TIRE_LATERAL.longRatio;
      const latForceMag = clamp(-latStiff * latV, -latMax, latMax);
      this.body.addForceAtPoint(
        {
          x: wheelRight.x * latForceMag,
          y: wheelRight.y * latForceMag,
          z: wheelRight.z * latForceMag,
        },
        cp,
        true,
      );
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

    // Refresh axle state from POST-STEP body pose. preStep computes
    // rideY/rollAngle from the body BEFORE world.step() integrates it
    // forward, so without this refresh the axle pose returned by
    // getState() lags the chassis by one physics tick. At 60 Hz that's
    // a 4-5 mm wobble at typical ride-spring frequencies - visible as
    // wheels not staying planted to the ground while the chassis bobs.
    // Re-running the kinematic axle math here aligns visual axle state
    // with the chassis pose at the same instant. Cost: 4 raycasts per
    // vehicle per tick. Force calculations next tick still happen in
    // preStep with the pre-integration body pose - this refresh only
    // touches the kinematic axle DOFs.
    const t = this.body.translation();
    const r = this.body.rotation();
    for (let aIdx = 0; aIdx < 2; aIdx++) {
      const axle = this.axles[aIdx]!;
      const ag = axle.geom;
      const wL = this.wheels[aIdx * 2]!;
      const wR = this.wheels[aIdx * 2 + 1]!;
      const leftLocal = { x: -ag.trackHalf, y: ag.centerLocalY, z: ag.centerLocalZ };
      const rightLocal = { x: +ag.trackHalf, y: ag.centerLocalY, z: ag.centerLocalZ };
      const leftWorld = addVec(t, rotateVecByQuat(leftLocal, r));
      const rightWorld = addVec(t, rotateVecByQuat(rightLocal, r));
      const rayDir: Vec3 = { x: 0, y: -1, z: 0 };
      const maxToi = ag.suspensionRestLength + this.geom.wheelRadius + 0.10;
      castWheelRay(this.world, this.body, leftWorld, rayDir, maxToi, ag.suspensionRestLength, this.geom.wheelRadius, wL);
      castWheelRay(this.world, this.body, rightWorld, rayDir, maxToi, ag.suspensionRestLength, this.geom.wheelRadius, wR);
      stepAxle(axle, {
        leftDepth: wL.contactDepth,
        rightDepth: wR.contactDepth,
        leftContact: wL.contact,
        rightContact: wR.contact,
        chassisVertVelAtAnchor: 0,
        dt: FIXED_DT,
      });
    }
  }

  wheelSamples(): WheelSample[] {
    const t = this.body.translation();
    const r = this.body.rotation();
    const throttle = Math.abs(this.input.throttle);
    const brake = this.input.brake + this.input.handbrake;
    const passive = 0.15;
    const slip = Math.min(1, Math.max(passive, throttle, brake));
    const out: WheelSample[] = [];
    for (let aIdx = 0; aIdx < 2; aIdx++) {
      const ag = this.axles[aIdx]!.geom;
      for (let side = 0; side < 2; side++) {
        const wIdx = aIdx * 2 + side;
        const w = this.wheels[wIdx]!;
        const localX = side === 0 ? -ag.trackHalf : +ag.trackHalf;
        const local = { x: localX, y: ag.centerLocalY, z: ag.centerLocalZ };
        const wp = addVec(t, rotateVecByQuat(local, r));
        out.push({ x: wp.x, z: wp.z, contact: w.contact, slip });
      }
    }
    return out;
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
      const susp = Math.max(0, axle.geom.suspensionRestLength - w.contactDepth);
      wheels.push({
        steer: i < 2 ? this.currentSteer : 0,
        spin: w.spin,
        contact: w.contact,
        suspensionLength: susp,
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
      wheels,
      axles: [
        { rideY: aFront.rideY, rollAngle: aFront.rollAngle },
        { rideY: aRear.rideY, rollAngle: aRear.rollAngle },
      ],
    };
  }

  axleSnaps(): [AxleSnap, AxleSnap] {
    return [axleSnap(this.axles[0]!), axleSnap(this.axles[1]!)];
  }

  applyAxleSnaps(snaps: [AxleSnap, AxleSnap]): void {
    applyAxleSnap(this.axles[0]!, snaps[0]);
    applyAxleSnap(this.axles[1]!, snaps[1]);
  }

  dispose(): void {
    this.world.world.removeRigidBody(this.body);
  }
}

function castWheelRay(
  world: World,
  ownBody: RAPIER.RigidBody,
  origin: Vec3,
  dir: Vec3,
  maxToi: number,
  restLength: number,
  wheelRadius: number,
  out: WheelKinematic,
): void {
  const ray = new world.rapier.Ray(origin, dir);
  const hit = world.world.castRayAndGetNormal(
    ray,
    maxToi,
    true,
    undefined,
    undefined,
    undefined,
    ownBody,
  );
  if (hit) {
    const toi = hit.timeOfImpact;
    out.contact = true;
    out.contactDepth = Math.max(0, restLength - (toi - wheelRadius));
    out.contactPoint = {
      x: origin.x + dir.x * toi,
      y: origin.y + dir.y * toi,
      z: origin.z + dir.z * toi,
    };
    out.contactNormal = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
  } else {
    out.contact = false;
    out.contactDepth = 0;
    out.contactPoint = {
      x: origin.x + dir.x * maxToi,
      y: origin.y + dir.y * maxToi,
      z: origin.z + dir.z * maxToi,
    };
    out.contactNormal = { x: 0, y: 1, z: 0 };
  }
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function surfaceGrip(s: number): number {
  switch (s) {
    case Surface.Road: return TUNING.surfaceFriction.road;
    case Surface.Dirt: return TUNING.surfaceFriction.dirt;
    case Surface.Mud: return TUNING.surfaceFriction.mud;
    case Surface.DeepMud: return TUNING.surfaceFriction.deepMud;
    case Surface.Grass: return TUNING.surfaceFriction.grass;
    case Surface.Gravel: return TUNING.surfaceFriction.gravel;
    case Surface.Concrete: return TUNING.surfaceFriction.concrete;
    default: return TUNING.surfaceFriction.dirt;
  }
}
