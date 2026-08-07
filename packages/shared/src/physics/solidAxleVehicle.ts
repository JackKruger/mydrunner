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
  FIXED_DT,
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
  EMPTY_INPUT,
  type CarKind,
  type PlayerInput,
  type VehicleState,
  type WheelState,
} from '../types.js';
import { Surface, sampleSurface, surfaceInfo } from './terrain.js';
import {
  computeWaterLoad, createWaterLoad, createWaterState, hasWater,
  resetWaterState, sampleWaterDepth, wetGripMult, wheelSubmersion,
  type WaterLoad, type WaterState,
} from './water.js';
import { createEngineState, stepEngine, type EngineState } from './engine.js';
// slipRatio / gripFromSlip kept in tire.ts for tests; not used here since
// the impulse-clamped integrator below replaced the Pacejka groundTq path.
// slipAngle / lateralGripFromSlipAngle ARE used to shape the lateral
// force so the tyre breaks loose past its slip-angle peak.
import { rotateVecByQuat } from './util.js';
import { slipAngle, lateralGripFromSlipAngle } from './tire.js';
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
import type { VehicleLike, VehicleSpawn } from './vehicleTypes.js';
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

type Vec3 = { x: number; y: number; z: number };

export class SolidAxleVehicle implements VehicleLike {
  private readonly world: World;
  readonly id: string;
  readonly body: RAPIER.RigidBody;
  readonly chassis: RAPIER.Collider;
  readonly geom: VehicleGeom;
  private readonly wheelShape: RAPIER.Cylinder;

  private input: PlayerInput = { ...EMPTY_INPUT };
  private currentSteer = 0;

  private readonly axles: [AxleState, AxleState];
  private readonly wheels: [WheelKinematic, WheelKinematic, WheelKinematic, WheelKinematic];

  private engine: EngineState = createEngineState();
  private lastRpm = 0;
  private lastGear = 0;
  private ledgeCrawlTicks = 0;

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

  constructor(world: World, id: string, spawn: VehicleSpawn, kind: CarKind = 'patrol') {
    this.world = world;
    this.id = id;
    this.geom = geomFor(kind);
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
      .setFriction(0.1)
      .setCollisionGroups(COLLISION_GROUP_OWNED_VEHICLE);
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
    this.worldHasWater = hasWater(world.terrain);
  }

  setInput(input: PlayerInput): void {
    this.input = input;
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
    this.ledgeCrawlTicks = 0;
    resetWaterState(this.water);
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
    const wheelBases: Array<WheelBasis | null> = [null, null, null, null];
    const ledgeContacts: Array<SteepWheelContact | null> = [null, null, null, null];
    const ledgeLoads = [0, 0, 0, 0];

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
      // Max range includes the lift, full rest length, droop, and wheel radius.
      const maxToi = rayLift + ag.suspensionRestLength + ag.droopMax + this.geom.wheelRadius;

      castWheelRay(this.world, this.body, leftWorld, rayDir, maxToi, ag.suspensionRestLength + rayLift, this.geom.wheelRadius, wL);
      castWheelRay(this.world, this.body, rightWorld, rayDir, maxToi, ag.suspensionRestLength + rayLift, this.geom.wheelRadius, wR);

      wL.surface = sampleSurface(this.world.terrain, wL.contactPoint.x, wL.contactPoint.z);
      wR.surface = sampleSurface(this.world.terrain, wR.contactPoint.x, wR.contactPoint.z);
      wL.supportGrip = wL.supportIsTerrain ? surfaceGrip(wL.surface) : wL.supportColliderFriction;
      wR.supportGrip = wR.supportIsTerrain ? surfaceGrip(wR.surface) : wR.supportColliderFriction;

      // Water between the tread and the bed, on top of whatever the bed
      // itself grips at. Keeping the bed surface is the reason water is
      // its own grid rather than a Surface: a gravel ford and a
      // mud-bottom crossing should not feel the same.
      if (this.worldHasWater) {
        wL.waterDepth = sampleWaterDepth(this.world.terrain, wL.contactPoint.x, wL.contactPoint.z);
        wR.waterDepth = sampleWaterDepth(this.world.terrain, wR.contactPoint.x, wR.contactPoint.z);
        wL.supportGrip *= wetGripMult(wL.waterDepth, this.geom.wheelRadius);
        wR.supportGrip *= wetGripMult(wR.waterDepth, this.geom.wheelRadius);
      }

      // A second, volumetric query catches faces the suspension-axis ray
      // cannot see. It is based on the previous axle pose so the tyre starts
      // touching a ledge when its circumference reaches it, not when the
      // wheel centre has already crossed the face.
      const basis = wheelBasis(
        fwd,
        right,
        up,
        axle.rollAngle,
        ag.hasSteering ? -this.currentSteer : 0,
      );
      wheelBases[wIdxL] = basis;
      wheelBases[wIdxR] = basis;
      const volumeSides: Array<{ index: number; wheel: WheelKinematic; localX: number }> = [
        { index: wIdxL, wheel: wL, localX: -ag.trackHalf },
        { index: wIdxR, wheel: wR, localX: +ag.trackHalf },
      ];
      for (const volumeSide of volumeSides) {
        const w = volumeSide.wheel;
        const center = wheelCenterWorld(t, r, axle, volumeSide.localX);
        const ledge = findSteepWheelContact(
          this.world.world,
          this.wheelShape,
          w.hasPreviousCenter ? w.previousCenter : null,
          center,
          cylinderRotation(basis.axle),
          this.geom.wheelRadius,
          this.geom.wheelWidth / 2,
          LEDGE_CONTACT.prediction,
          LEDGE_CONTACT.maxSupportNormalY,
          LEDGE_CONTACT.maxClimbHeight,
          LEDGE_CONTACT.edgeAdvance,
          basis.forward,
          COLLISION_GROUP_WHEEL_RAY,
        );
        ledgeContacts[volumeSide.index] = ledge;
        w.ledgeContact = ledge !== null;
        w.ledgeNormalForce = 0;
        w.ledgeLongForce = 0;
        w.previousCenter.x = center.x;
        w.previousCenter.y = center.y;
        w.previousCenter.z = center.z;
        w.hasPreviousCenter = true;

        resolveSuspensionDepth(
          w,
          ledge,
          ag.suspensionRestLength,
          this.geom.wheelRadius,
          center.y,
          dt,
        );
        if (ledge) {
          const normalSpeed = pointVelocityDot(lv, av, t, ledge.point, ledge.normal);
          const correctionSpeed = Math.min(
            LEDGE_CONTACT.maxNormalCorrectionSpeed,
            ledge.penetration * LEDGE_CONTACT.normalCorrectionRate,
          );
          const normalForce = clamp(
            (correctionSpeed - normalSpeed)
              * (VEHICLE.mass * this.geom.massMult)
              * LEDGE_CONTACT.normalMassFraction
              / dt,
            0,
            LEDGE_CONTACT.maxForce,
          );
          ledgeLoads[volumeSide.index] = normalForce;
          w.ledgeNormalForce = normalForce;
          if (normalForce > 0) {
            const sf = this._scratchForce;
            sf.x = ledge.normal.x * normalForce * dt;
            sf.y = ledge.normal.y * normalForce * dt;
            sf.z = ledge.normal.z * normalForce * dt;
            // Central impulse makes this a pure no-penetration constraint.
            // The unsprung wheel/suspension moment is modelled separately by
            // the tread and ride forces below.
            this.body.applyImpulse(sf, true);
          }
        }
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
        leftContact: hasSuspensionSupport(wL, ledgeContacts[wIdxL] ?? null),
        rightContact: hasSuspensionSupport(wR, ledgeContacts[wIdxR] ?? null),
        chassisVertVelAtAnchor: 0, // unused now; per-wheel damping below
        dt,
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
      const sides: Array<{ wheel: WheelKinematic; localX: number; world: Vec3 }> = [
        { wheel: wL, localX: -ag.trackHalf, world: leftWorld },
        { wheel: wR, localX: +ag.trackHalf, world: rightWorld },
      ];
      for (const side of sides) {
        const w = side.wheel;
        w.lastForce = 0;
        const virtualLedgeSupport = !w.contact
          && w.ledgeHandoff
          && w.ledgeHandoffGrace > 0
          && w.resolvedDepth > 0;
        if (!w.contact && !virtualLedgeSupport) {
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
        // Engagement ramps from 0→1 as compression reaches the engage
        // depth. Suspension only exerts force while compressed (comp > 0).
        const engagement = Math.min(1, comp / SUSPENSION.dampingEngageComp);
        // Per-wheel-end stiffness is HALF the axle's total.
        let F = 0.5 * ag.rideStiffness * at.rideStiffnessMult * comp
              + 0.5 * ag.rideDamping * at.rideDampingMult * engagement * compRate;
        if (w.ledgeContact || w.ledgeHandoff) {
          F = Math.min(F, LEDGE_CONTACT.maxClimbSuspensionForce);
        }
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
        const rideForcePoint = w.ledgeContact || w.ledgeHandoff
          ? scaledMomentPoint(t, side.world, LEDGE_CONTACT.chassisMomentArmScale)
          : side.world;
        this.body.addForceAtPoint(sf, rideForcePoint, true);
        w.prevContactDepth = comp;
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
      const tq = -ANTI_ROLL.stiffness * rollSin - ANTI_ROLL.damping * rollVel;
      const sf = this._scratchForce;
      sf.x = fwd.x * tq; sf.y = fwd.y * tq; sf.z = fwd.z * tq;
      this.body.addTorque(sf, true);
    }

    // 3c. Water: buoyancy, drag and current.
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
        this.body.addForce(wl.drag, true);
        this.body.addTorque(wl.dragTorque, true);
      }
    } else {
      this.waterLoad.submergedFrac = 0;
      this.waterLoad.intakeSubmerged = false;
      this.waterLoad.drowned = false;
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
    const drivePerWheelTorque = engineOut.wheelForce * this.geom.powerMult; // engine.ts returns torque-shaped values

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
    // A transfer-case low range changes the ratio for the whole driveline,
    // not just the tyre that happens to be touching the ledge. Boosting only
    // the front contact produced a large upward force with too little rear
    // push: the wall reaction sent the truck backwards and the nose kicked
    // up. Keeping all driven wheels in the same crawl ratio lets the rear
    // axle push the front hubs over the edge while the front tread climbs it.
    if (ledgeContacts.some((contact) => contact !== null)) {
      this.ledgeCrawlTicks = LEDGE_CONTACT.crawlHoldTicks;
    } else if (this.ledgeCrawlTicks > 0) {
      this.ledgeCrawlTicks--;
    }
    const crawlActive = this.ledgeCrawlTicks > 0;
    const crawlRatio = crawlActive ? LEDGE_CONTACT.crawlTorqueMultiplier : 1;
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

    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const w = this.wheels[wIdx]!;
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
      if (w.surface === Surface.Mud) rollingMult = WHEEL.rollingMultMud;
      else if (w.surface === Surface.DeepMud) rollingMult = WHEEL.rollingMultDeepMud;
      // Wading is heavy. Additive on top of the bed's own resistance, so
      // a submerged mud bog is worse than either alone.
      if (w.waterDepth > 0) {
        rollingMult += (WATER.wheelDragMult - 1) * wheelSubmersion(w.waterDepth, this.geom.wheelRadius);
      }
      const rollingResistance = WHEEL.rollingResistance * rollingMult;

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
      const ledge = ledgeContacts[wIdx];
      const ledgeFrame = ledge
        ? contactFrame(ledge.normal, basis.axle, basis.forward)
        : null;
      if (ledge && ledgeFrame) {
        cp = ledge.point;
        tireLong = ledge.climbDirection ?? ledgeFrame.longitudinal;
        tireLat = ledgeFrame.lateral;
        surfMult = clamp(ledge.friction, 0, 2) * LEDGE_CONTACT.tractionMultiplier;
        normalLoad = Math.max(LEDGE_CONTACT.minHookNormalLoad, ledgeLoads[wIdx]!);
        // Incline assist compensates suspension load loss on long slopes. A
        // wall contact has its own constraint load and must not receive it.
        contactInclineMult = 1;
      } else if (w.contact) {
        const supportFrame = contactFrame(w.contactNormal, basis.axle, basis.forward);
        cp = w.contactPoint;
        tireLong = supportFrame?.longitudinal ?? basis.forward;
        tireLat = supportFrame?.lateral ?? basis.axle;
        surfMult = w.supportGrip;
        normalLoad = Math.max(WHEEL.minNormalLoad, w.lastForce ?? 0);
        contactInclineMult = inclineMult;
      } else {
        // No torque-transmitting patch on a free wheel.
        integrateWheelSpin(w, appliedDriveTq, brakeTq, 0, dt);
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
        TIRE_LONG_FRICTION * surfMult * axleGripMult * contactInclineMult * normalLoad;

      // Friction circle (elliptical) coupling. We compute the forces
      // needed for zero longitudinal slip and zero lateral velocity,
      // then clamp the combined vector to the available friction limit.
      // This ensures that spinning the wheels (high longitudinal force)
      // reduces the available lateral grip, making the car slide — the
      // essential "drifting in mud" or "power-sliding" feel.
      const groundAngVel = longV / this.geom.wheelRadius;
      const neededTq = (groundAngVel - w.angVel) * WHEEL.inertia / dt;
      const rawLongForce = -neededTq / this.geom.wheelRadius;
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
      const rawLatForce = -TUNING.tireLatStiffness * latV * latGripMult;

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

      if (ledge?.climbDirection && ledgeFrame) {
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

      // Update wheel angular velocity using the force actually transmitted
      // through the contact patch (impulse-clamped integration).
      const finalGroundTq = -finalLongForce * this.geom.wheelRadius;
      integrateWheelSpin(w, appliedDriveTq, brakeTq, finalGroundTq, dt, rollingResistance);
      if (ledge && ledgeFrame) {
        w.ledgeLongForce = finalLongForce;
      }

      // Apply combined tire force to chassis at contact point.
      const f = this._scratchForce;
      f.x = tireLong.x * finalLongForce + tireLat.x * finalLatForce;
      f.y = tireLong.y * finalLongForce + tireLat.y * finalLatForce;
      f.z = tireLong.z * finalLongForce + tireLat.z * finalLatForce;
      const forcePoint = ledge && ledgeFrame
        ? scaledMomentPoint(t, cp, LEDGE_CONTACT.chassisMomentArmScale)
        : cp;
      this.body.addForceAtPoint(f, forcePoint, true);
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
        contact: w.contact || w.ledgeContact,
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

  /** Water state as of the last preStep, for the HUD and the renderer.
   *
   *  Deliberately not on VehicleState and not on the wire: a drowned
   *  engine already reads as rpm 0 / gear 0 through the existing tuple,
   *  and a remote truck's spray can be derived from its transmitted
   *  position against the water height both ends compute from the same
   *  map document. Adding a field would have cost a SNAPSHOT_SCHEMA bump
   *  for information both sides already have. */
  waterStatus(): {
    submerged: number;
    wheelDepths: [number, number, number, number];
    intakeSubmerged: boolean;
    drowned: boolean;
    flood: number;
  } {
    return {
      submerged: this.waterLoad.submergedFrac,
      wheelDepths: [
        this.wheels[0]!.waterDepth, this.wheels[1]!.waterDepth,
        this.wheels[2]!.waterDepth, this.wheels[3]!.waterDepth,
      ],
      intakeSubmerged: this.waterLoad.intakeSubmerged,
      drowned: this.waterLoad.drowned,
      flood: this.water.floodFrac,
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
  const cr = Math.cos(axle.rollAngle);
  const sr = Math.sin(axle.rollAngle);
  const local = {
    x: localX * cr,
    y: axle.geom.centerLocalY - axle.geom.suspensionRestLength
      + axle.rideY + localX * sr,
    z: axle.geom.centerLocalZ,
  };
  return addVec(bodyPosition, rotateVecByQuat(local, bodyRotation));
}

function resolveSuspensionDepth(
  wheel: WheelKinematic,
  ledge: SteepWheelContact | null,
  suspensionRestLength: number,
  wheelRadius: number,
  wheelCenterY: number,
  dt: number,
): void {
  const raw = wheel.contact ? wheel.contactDepth : 0;
  if (!wheel.resolvedDepthInitialized) {
    wheel.resolvedDepth = raw;
    wheel.resolvedDepthInitialized = true;
  }

  const maxDelta = LEDGE_CONTACT.depthCatchupRate * dt;
  if (ledge) {
    wheel.ledgeHandoff = true;
    wheel.ledgeHandoffGrace = LEDGE_CONTACT.handoffGraceTicks;
    // A reachable upper edge feeds the suspension in at tread speed instead
    // of waiting for the hub to cross the face and then accepting a one-tick
    // ray-depth jump. That makes wheel rotation visibly load and lift the
    // axle. The global rate cap bounds spring/damper force even while the
    // tyre is spinning much faster than crawling speed.
    if (ledge.climbTopY !== null) {
      const hubDeficit = Math.max(
        0,
        ledge.climbTopY + wheelRadius - wheelCenterY,
      );
      const climbTarget = Math.min(
        suspensionRestLength,
        wheel.resolvedDepth + hubDeficit,
      );
      const treadSpeed = Math.max(0, wheel.angVel) * wheelRadius;
      const climbDelta = Math.min(LEDGE_CONTACT.climbCompressionRate, treadSpeed) * dt;
      if (climbTarget > wheel.resolvedDepth && climbDelta > 0) {
        wheel.resolvedDepth = moveToward(wheel.resolvedDepth, climbTarget, climbDelta);
      } else if (climbTarget < wheel.resolvedDepth) {
        wheel.resolvedDepth = moveToward(wheel.resolvedDepth, climbTarget, maxDelta);
      }
    } else if (raw < wheel.resolvedDepth) {
      // Always permit unloading; only upward compression is synthesized.
      wheel.resolvedDepth = moveToward(wheel.resolvedDepth, raw, maxDelta);
    }
  } else if (wheel.ledgeHandoff) {
    if (wheel.contact) {
      wheel.resolvedDepth = moveToward(wheel.resolvedDepth, raw, maxDelta);
      if (Math.abs(wheel.resolvedDepth - raw) < 1e-6) {
        wheel.ledgeHandoff = false;
        wheel.ledgeHandoffGrace = 0;
      }
    } else if (wheel.ledgeHandoffGrace > 0) {
      wheel.ledgeHandoffGrace--;
    } else {
      wheel.resolvedDepth = moveToward(wheel.resolvedDepth, 0, maxDelta);
      if (wheel.resolvedDepth <= 1e-6) wheel.ledgeHandoff = false;
    }
  } else {
    wheel.resolvedDepth = raw;
  }
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
  ledge: SteepWheelContact | null,
): boolean {
  return wheel.contact
    || ledge !== null
    || (wheel.ledgeHandoff && wheel.ledgeHandoffGrace > 0 && wheel.resolvedDepth > 0);
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

function surfaceGrip(s: number): number {
  // TUNING rather than SURFACE_FRICTION: the debug panel mutates the
  // former in place, and this is the reader that makes those sliders do
  // something.
  return TUNING.surfaceFriction[surfaceInfo(s).friction];
}
