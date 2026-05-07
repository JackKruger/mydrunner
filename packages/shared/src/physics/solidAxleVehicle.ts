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
//   3. Cast wheel rays along chassis-local -Y (rotated to world), not
//      world-down. On a rolled chassis world-down rays from chassis-local
//      origins miss the actual wheel position.
//   4. Diff-lock equalise BEFORE slip computation, so the slip uses the
//      locked angVel.

import RAPIER from '@dimforge/rapier3d-compat';
import {
  FIXED_DT,
  GRAVITY_Y,
  TIRE_LATERAL,
  TIRE_LONG_FRICTION,
  VEHICLE,
  WHEEL,
} from '../constants.js';
import { TUNING } from '../tuning.js';
import {
  EMPTY_INPUT,
  type CarKind,
  type PlayerInput,
  type Quat,
  type VehicleState,
  type WheelState,
} from '../types.js';
import { Surface, sampleSurface } from './terrain.js';
import { createEngineState, stepEngine, type EngineState } from './engine.js';
// slipRatio / gripFromSlip kept in tire.ts for tests; not used here since
// the impulse-clamped integrator below replaced the Pacejka groundTq path.
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
// when the chassis needs it. The sway bar fills the gap. Tuned soft
// enough that cornering produces visible body lean (the player
// feedback "needs a little more body roll") while still preventing
// the unbounded-roll failure mode the per-wheel-end ride forces alone
// can't catch when the inside is in the air. Damping at ~critical for
// the new stiffness so roll oscillation still settles in one cycle:
//   c_crit = 2*sqrt(k*I) ~ 2*sqrt(70000*900) ~ 15900 N*m*s/rad.
const ANTI_ROLL_STIFFNESS = 70_000;
const ANTI_ROLL_DAMPING = 16_000;

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

  // Reused scratch vectors so the per-tick force/torque loop doesn't
  // allocate. Contents are valid only for the duration of the call site
  // that wrote them; never store references to these.
  private readonly _scratchFwd: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly _scratchRight: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly _scratchForce: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(world: World, id: string, spawn: VehicleSpawn, kind: CarKind = 'patrol') {
    this.world = world;
    this.id = id;
    this.geom = geomFor(kind);

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
    const kindMass = VEHICLE.mass * this.geom.massMult;
    const colDesc = RAPIER.ColliderDesc.roundCuboid(ext.x - r, colHalfH - r, ext.z - r, r)
      .setTranslation(0, colOffsetY, 0)
      .setDensity(kindMass / (8 * ext.x * ext.y * ext.z))
      .setFriction(0.1);
    this.chassis = world.world.createCollider(colDesc, this.body);
    // Same low CoM trick the legacy Vehicle uses: pull principal moments
    // toward a low centre so the chassis feels bottom-heavy and resists
    // rollovers despite the tall visual cabin.
    this.body.setAdditionalMassProperties(
      0,
      { x: 0, y: -ext.y * 0.6, z: 0 },
      { x: kindMass * 0.6, y: kindMass * 0.5, z: kindMass * 0.6 },
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
    // until reset. Without this, last tick's spring force compounds with
    // this tick's, producing a runaway upward force. Reset every tick.
    this.body.resetForces(false);
    this.body.resetTorques(false);

    // Capture chassis pose ONCE (determinism rule 1).
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const fwd = rotateVecByQuat({ x: 0, y: 0, z: 1 }, r);
    const right = rotateVecByQuat({ x: 1, y: 0, z: 0 }, r);
    const up = rotateVecByQuat({ x: 0, y: 1, z: 0 }, r);

    this.smoothSteering(dt);

    // Per-axle suspension: ray-cast wheel ends, integrate axle DOFs,
    // apply per-wheel-end ride forces and any axle-saturation roll
    // torque dump.
    for (let aIdx = 0; aIdx < 2; aIdx++) {
      this.stepAxleSuspension(aIdx, t, r, fwd, dt);
    }

    this.applyAntiRollBar(fwd, right, av);

    const drive = this.stepEngineAndIncline(lv, fwd, dt);
    this.applyDiffLocks();

    for (let wIdx = 0; wIdx < 4; wIdx++) {
      this.applyWheelTireForces(wIdx, t, lv, av, fwd, right, up, drive, dt);
    }
  }

  /** Smoothly ramp `currentSteer` toward the player's target deflection
   *  at TUNING.steerSpeed. Decoupled from input rate so a pulse on the
   *  steering keys doesn't slam the wheels lock-to-lock in one tick. */
  private smoothSteering(dt: number): void {
    const targetSteer = this.input.steer * TUNING.maxSteer;
    const steerDelta = targetSteer - this.currentSteer;
    const maxStep = TUNING.steerSpeed * dt;
    this.currentSteer +=
      Math.abs(steerDelta) < maxStep ? steerDelta : Math.sign(steerDelta) * maxStep;
  }

  /** Single axle: cast both wheel rays, run the kinematic axle update
   *  for visuals/snapshots, and apply per-wheel-end ride forces along
   *  the contact normal. Raycast origins are chassis-fixed (NOT
   *  axle-articulated) — letting the axle's roll feed back into the
   *  rays produces a `roll → ray → target roll → roll` oscillation. */
  private stepAxleSuspension(aIdx: number, t: Vec3, r: Quat, fwd: Vec3, dt: number): void {
    const axle = this.axles[aIdx]!;
    const ag = axle.geom;

    const wIdxL = aIdx * 2;
    const wIdxR = aIdx * 2 + 1;
    const wL = this.wheels[wIdxL]!;
    const wR = this.wheels[wIdxR]!;

    // Lift ray origins by 0.5 m so they don't start inside terrain when
    // the chassis is belly-out or wheels are deep in a hole.
    const rayLift = 0.5;
    const leftLocal = { x: -ag.trackHalf, y: ag.centerLocalY + rayLift, z: ag.centerLocalZ };
    const rightLocal = { x: +ag.trackHalf, y: ag.centerLocalY + rayLift, z: ag.centerLocalZ };
    const leftWorld = addVec(t, rotateVecByQuat(leftLocal, r));
    const rightWorld = addVec(t, rotateVecByQuat(rightLocal, r));

    // Ray along chassis-local -Y (the suspension axis). World-down
    // works on level ground but on a rolled chassis the world-down ray
    // from a chassis-local origin no longer passes through where the
    // wheel actually is, so the ray finds the wrong ground point.
    const rayDir = rotateVecByQuat({ x: 0, y: -1, z: 0 }, r);
    const maxToi = rayLift + ag.suspensionRestLength + ag.droopMax + this.geom.wheelRadius;
    const restPlusLift = ag.suspensionRestLength + rayLift;
    castWheelRay(this.world, this.body, leftWorld, rayDir, maxToi, restPlusLift, this.geom.wheelRadius, wL);
    castWheelRay(this.world, this.body, rightWorld, rayDir, maxToi, restPlusLift, this.geom.wheelRadius, wR);

    wL.surface = sampleSurface(this.world.terrain, wL.contactPoint.x, wL.contactPoint.z);
    wR.surface = sampleSurface(this.world.terrain, wR.contactPoint.x, wR.contactPoint.z);

    // stepAxle is kept for the kinematic axle bookkeeping that feeds
    // visuals + snapshots, but we IGNORE its chassisRideForce. A single
    // ride force at the axle CENTER (chassis-local x=0) provides no
    // roll-restoring torque when the chassis tips - both wheels' shares
    // sum at x=0 and just push straight up regardless of tilt, so any
    // small roll perturbation grows unchecked. Splitting the ride force
    // into per-wheel-end components at +/- trackHalf naturally creates
    // the righting moment that solid-axle vehicles get from their
    // leaf-spring/coilover mounts being attached at the axle ends, not
    // the diff.
    const result = stepAxle(axle, {
      leftDepth: wL.contactDepth,
      rightDepth: wR.contactDepth,
      leftContact: wL.contact,
      rightContact: wR.contact,
      chassisVertVelAtAnchor: 0, // unused now; per-wheel damping below
      dt,
    });

    this.applyWheelEndRideForce(wL, leftWorld, ag, dt);
    this.applyWheelEndRideForce(wR, rightWorld, ag, dt);

    // Roll torque dump when terrain demands more articulation than the
    // axle can absorb. Below the cap the per-wheel-end forces above
    // already provide the correct chassis-axle coupling; past the cap
    // the axle has bottomed against its mechanical stop and the surplus
    // has to lever the chassis itself - that's the body-lean-over-a-rock
    // behaviour.
    if (Math.abs(result.chassisRollTorque) > 1e-6) {
      const tq = result.chassisRollTorque;
      const sf = this._scratchForce;
      sf.x = fwd.x * tq; sf.y = fwd.y * tq; sf.z = fwd.z * tq;
      this.body.addTorque(sf, true);
    }
  }

  private applyWheelEndRideForce(w: WheelKinematic, worldOrigin: Vec3, ag: AxleState['geom'], dt: number): void {
    w.lastForce = 0;
    if (!w.contact) {
      w.prevContactDepth = -1;
      return;
    }
    // Spring is linear in compression, capped at restLength to bound
    // the force on degenerate ray reads (e.g. wheel-ray hitting a
    // vertical wall). NO bumpMax saturation: capping at bumpMax was the
    // original cause of the wheel-phasing bug — on a rising slope the
    // ray reports comp >> bumpMax and a saturated spring can't lift the
    // chassis fast enough, the wheel mesh visibly buries before the
    // chassis catches up. Letting the spring stay linear past bumpMax
    // just makes it a stiffer-than-equilibrium response that drives the
    // chassis off the slope quickly.
    const comp = Math.min(ag.suspensionRestLength, Math.max(0, w.contactDepth));
    if (comp <= 0) {
      w.prevContactDepth = -1;
      return;
    }
    // Compression-rate damping. The earlier formulation damped chassis
    // vertical velocity at the wheel-end (vpY). On a rising slope the
    // chassis MUST lift to follow; vertVel damping then applies a
    // *downward* force during the lift, fighting the spring and wedging
    // the chassis into the slope until friction grinds it back out.
    //
    // Compression rate captures the *suspension* velocity (rate at
    // which the spring is compressing) independent of chassis motion.
    // On a rising slope the wheel is pushed up faster than the chassis
    // lifts → comp increases → compRate > 0 → damping adds force in
    // the same direction as the spring (helps lift). On flat ground at
    // rest, compRate ≈ -vpY (ground stationary), so settling/rollover
    // stability matches the old formulation.
    if (w.prevContactDepth < 0) w.prevContactDepth = comp;
    const rawRate = (comp - w.prevContactDepth) / dt;
    // Clamp: per-tick rate spikes (e.g. ray jumping over a sharp edge)
    // would otherwise produce damping forces exceeding the spring
    // saturation force and destabilise the integrator.
    const compRate = clamp(rawRate, -3, 3);
    // Engagement ramps from 0→1 as compression reaches ~0.05 m. The
    // earlier `comp / restLength` curve only reached 16 % engagement at
    // equilibrium (~87 mm under chassis weight), leaving the chassis
    // vertical mode at ~12 % critical — visible 1.7 Hz body bob. This
    // saturates earlier so equilibrium is at full damping (~critical)
    // without hardening the first-contact response.
    const engagement = Math.min(1, comp / 0.05);
    // Per-wheel-end stiffness is HALF the axle's total.
    const F = 0.5 * ag.rideStiffness * comp
            + 0.5 * ag.rideDamping * engagement * compRate;
    w.lastForce = F;
    // Apply force along the CONTACT NORMAL (the direction the ground
    // actually pushes), not chassis-up or world-up:
    //   - Flat ground: normal = world-up, so no horizontal component
    //     at any chassis pitch. Earlier chassis-up version creeped
    //     ~0.9 m/4 s under tan(pitch)*F at any settled pitch.
    //   - Cross-slope: normals on both sides point up-and-uphill;
    //     asymmetric compression produces a chassis roll moment so the
    //     body tilts WITH the slope (fixes "stays flat" complaint).
    //   - Up a hill: forward chassis tilt is matched by a slope-normal
    //     force with a backward component opposing gravity's downhill
    //     pull — same as a real wheel.
    const n = w.contactNormal;
    const sf = this._scratchForce;
    sf.x = n.x * F; sf.y = n.y * F; sf.z = n.z * F;
    this.body.addForceAtPoint(sf, worldOrigin, true);
    w.prevContactDepth = comp;
  }

  /** Anti-roll bar: chassis-frame torque about the chassis-forward axis,
   *  proportional to world-roll angle plus a velocity damping term. The
   *  per-wheel-end ride forces give static roll stability, but in hard
   *  cornering the inside wheels unload (or lift) so their share of the
   *  restoring torque vanishes when you need it most. The sway bar fills
   *  that gap.
   *
   *  Roll proxy is `right.y` (chassis-right's vertical world component):
   *  zero upright, sin(alpha) when rolled. The previous `up.dot(right)`
   *  formula was identically zero — chassis basis vectors stay
   *  orthogonal under any rigid rotation — so the spring term never
   *  fired and only the damper worked. */
  private applyAntiRollBar(fwd: Vec3, right: Vec3, av: Vec3): void {
    const rollSin = right.y;
    const rollVel = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
    const tq = -ANTI_ROLL_STIFFNESS * rollSin - ANTI_ROLL_DAMPING * rollVel;
    const sf = this._scratchForce;
    sf.x = fwd.x * tq; sf.y = fwd.y * tq; sf.z = fwd.z * tq;
    this.body.addTorque(sf, true);
  }

  /** Step the engine + gearbox model and compute the per-wheel torque +
   *  incline-assist multiplier the tire loop will use. */
  private stepEngineAndIncline(lv: Vec3, fwd: Vec3, dt: number): { drivePerWheelTorque: number; inclineMult: number } {
    const avgAngVel = (this.wheels[0]!.angVel + this.wheels[1]!.angVel + this.wheels[2]!.angVel + this.wheels[3]!.angVel) / 4;
    const longSpeed = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    const signedAvg = Math.sign(longSpeed || avgAngVel) * Math.abs(avgAngVel);
    // vehicleAngVel is chassis speed expressed as equivalent wheel
    // rad/s. Passed separately so the engine uses it for shift decisions
    // without being confused by wheel slip (see engine.ts).
    const vehicleAngVel = Math.abs(longSpeed) / this.geom.wheelRadius;
    const engineOut = stepEngine(this.engine, signedAvg, vehicleAngVel, this.input.throttle, dt);
    this.lastRpm = engineOut.rpm;
    this.lastGear = engineOut.gear;
    const drivePerWheelTorque = engineOut.wheelForce * this.geom.powerMult;

    const climb = Math.min(0.5, Math.max(0, fwd.y));
    const inclineMult = 1 + (climb / 0.5) * TUNING.inclineAssistMax;
    return { drivePerWheelTorque, inclineMult };
  }

  /** Equalise wheel angular velocities across each diff-locked axle.
   *  MUST run before slip computation (determinism rule 4) so slip uses
   *  the locked angVel rather than the per-wheel one. */
  private applyDiffLocks(): void {
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
  }

  /** Per-wheel: compute steered axes, drive/brake torques, contact-patch
   *  velocities, friction-circle-clamped tire forces; apply the force
   *  to the chassis and integrate the wheel's angular velocity. */
  private applyWheelTireForces(
    wIdx: number,
    t: Vec3, lv: Vec3, av: Vec3,
    fwd: Vec3, right: Vec3, up: Vec3,
    drive: { drivePerWheelTorque: number; inclineMult: number },
    dt: number,
  ): void {
    const w = this.wheels[wIdx]!;
    const isFront = wIdx < 2;
    const axle = isFront ? this.axles[0]! : this.axles[1]!;
    const ag = axle.geom;

    // Steered wheel axes. Rotation about chassis-up by -currentSteer:
    // positive player intent (D / right) yaws the chassis right via a
    // force pointing into chassis-right.
    let wheelFwd: Vec3 = fwd;
    let wheelRight: Vec3 = right;
    if (ag.hasSteering && Math.abs(this.currentSteer) > 1e-6) {
      const ang = -this.currentSteer;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const upDotFwd = up.x * fwd.x + up.y * fwd.y + up.z * fwd.z;
      const crossX = up.y * fwd.z - up.z * fwd.y;
      const crossY = up.z * fwd.x - up.x * fwd.z;
      const crossZ = up.x * fwd.y - up.y * fwd.x;
      const wf = this._scratchFwd;
      wf.x = fwd.x * c + crossX * s + up.x * upDotFwd * (1 - c);
      wf.y = fwd.y * c + crossY * s + up.y * upDotFwd * (1 - c);
      wf.z = fwd.z * c + crossZ * s + up.z * upDotFwd * (1 - c);
      wheelFwd = wf;
      const wr = this._scratchRight;
      wr.x = up.y * wf.z - up.z * wf.y;
      wr.y = up.z * wf.x - up.x * wf.z;
      wr.z = up.x * wf.y - up.y * wf.x;
      wheelRight = wr;
    }

    const driveShare = (isFront ? VEHICLE.driveSplit.front : VEHICLE.driveSplit.rear) * 0.5;
    const driveTq = ag.hasDrive ? drive.drivePerWheelTorque * driveShare : 0;
    const brakeForceN =
      this.input.brake * TUNING.brakeForce
      + (isFront ? 0 : this.input.handbrake * TUNING.brakeForce * 1.5);
    const brakeTq = brakeForceN * this.geom.wheelRadius;

    if (!w.contact) {
      // No ground reaction on a free wheel - drive/brake/rolling only.
      integrateWheelSpin(w, driveTq, brakeTq, 0, dt);
      return;
    }

    // Surface-dependent rolling resistance.
    let rollingMult = 1.0;
    if (w.surface === Surface.Mud) rollingMult = 4.0;
    else if (w.surface === Surface.DeepMud) rollingMult = 12.0;
    const rollingResistance = WHEEL.rollingResistance * rollingMult;

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

    const surfMult = surfaceGrip(w.surface);
    const axleGripMult = isFront ? TUNING.frontGripMult : TUNING.rearGripMult;
    // Normal load: actual vertical force the tire is pushing with.
    // Floor at 500 N to avoid zero-grip singularities while still
    // letting the car slide when unweighted.
    const normalLoad = Math.max(500, w.lastForce ?? 0);
    const longGripCap =
      TIRE_LONG_FRICTION * surfMult * axleGripMult * drive.inclineMult * normalLoad;

    // Friction circle (elliptical) coupling. Compute the forces needed
    // for zero longitudinal slip + zero lateral velocity, then clamp
    // the combined vector to the available friction limit. Spinning
    // the wheels (high long force) reduces lateral grip → power-slide.
    const groundAngVel = longV / this.geom.wheelRadius;
    const neededTq = (groundAngVel - w.angVel) * WHEEL.inertia / dt;
    const rawLongForce = -neededTq / this.geom.wheelRadius;
    const rawLatForce = -TUNING.tireLatStiffness * latV;

    let finalLongForce = 0;
    let finalLatForce = 0;
    if (longGripCap > 1e-6) {
      const longMax = longGripCap;
      const latMax = longGripCap * TIRE_LATERAL.longRatio;
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

    // Wheel spin uses the force actually transmitted through the
    // contact patch (impulse-clamped integration).
    const finalGroundTq = -finalLongForce * this.geom.wheelRadius;
    integrateWheelSpin(w, driveTq, brakeTq, finalGroundTq, dt, rollingResistance);

    // Apply combined tire force at the contact point.
    const f = this._scratchForce;
    f.x = wheelFwd.x * finalLongForce + wheelRight.x * finalLatForce;
    f.y = wheelFwd.y * finalLongForce + wheelRight.y * finalLatForce;
    f.z = wheelFwd.z * finalLongForce + wheelRight.z * finalLatForce;
    this.body.addForceAtPoint(f, cp, true);
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
    // Visual axle pose (rideY/rollAngle) is left at the value preStep
    // computed from the pre-integration body pose. The previous
    // implementation re-cast 4 rays per vehicle here so the axle visual
    // matched the post-integration chassis pose; that cost ~480 raycasts
    // per second per player and was the dominant server tick overrun
    // when load was high. Trade-off: at 60 Hz the wheels visually trail
    // the chassis by one tick (~4-5 mm at typical spring frequencies) -
    // not noticeable on a moving chassis, dwarfed by camera motion.
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
        angVel: w.angVel,
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
    // Depth can be negative when the ground is below restLength (droop).
    out.contactDepth = restLength - (toi - wheelRadius);
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
