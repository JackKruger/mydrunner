// Vehicle uses Rapier's DynamicRayCastVehicleController - a Bullet-style
// raycast vehicle. Per-wheel friction is modulated each tick based on the
// terrain surface beneath the wheel, giving us the mud feel.

import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLE, SURFACE_FRICTION } from '../constants.js';
import { EMPTY_INPUT, type PlayerInput, type VehicleState, type WheelState } from '../types.js';
import { Surface, sampleSurface } from './terrain.js';
import { createEngineState, stepEngine, type EngineState } from './engine.js';
import type { World } from './world.js';

export interface VehicleSpawn {
  position: { x: number; y: number; z: number };
  yaw?: number;
}

export class Vehicle {
  private readonly world: World;
  readonly id: string;
  readonly body: RAPIER.RigidBody;
  readonly chassis: RAPIER.Collider;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  private input: PlayerInput = { ...EMPTY_INPUT };
  private currentSteer = 0;
  private wheelSpin: number[] = [0, 0, 0, 0];
  private wheelSurface: Surface[] = [Surface.Dirt, Surface.Dirt, Surface.Dirt, Surface.Dirt];
  private engine: EngineState = createEngineState();
  private lastRpm = 0;
  private lastGear = 0;

  constructor(world: World, id: string, spawn: VehicleSpawn) {
    this.world = world;
    this.id = id;

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

    const ext = VEHICLE.chassisHalfExtents;
    const colDesc = RAPIER.ColliderDesc.cuboid(ext.x, ext.y, ext.z)
      .setDensity(VEHICLE.mass / (8 * ext.x * ext.y * ext.z))
      .setFriction(0.3);
    this.chassis = world.world.createCollider(colDesc, this.body);
    // Pull the principal moments toward a low CoM so the chassis feels
    // bottom-heavy and resists rollovers even with a tall visual cabin.
    // Mass is preserved; we just override the inertia tensor to be more
    // resistant to roll.
    this.body.setAdditionalMassProperties(
      0,
      { x: 0, y: -ext.y * 0.6, z: 0 },
      { x: VEHICLE.mass * 0.6, y: VEHICLE.mass * 0.5, z: VEHICLE.mass * 0.6 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.controller = world.world.createVehicleController(this.body);
    const suspDir = { x: 0, y: -1, z: 0 };
    for (const wp of VEHICLE.wheelPositions) {
      this.controller.addWheel(
        wp,
        suspDir,
        { x: 1, y: 0, z: 0 }, // axle (local +X)
        VEHICLE.suspensionRestLength,
        VEHICLE.wheelRadius,
      );
    }
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelSuspensionStiffness(i, VEHICLE.suspensionStiffness);
      this.controller.setWheelSuspensionCompression(i, VEHICLE.suspensionCompression);
      this.controller.setWheelSuspensionRelaxation(i, VEHICLE.suspensionDamping);
      this.controller.setWheelMaxSuspensionForce(i, VEHICLE.maxSuspensionForce);
      this.controller.setWheelMaxSuspensionTravel(i, VEHICLE.maxSuspensionTravel);
      this.controller.setWheelFrictionSlip(i, 2.0);
    }
  }

  setInput(input: PlayerInput): void {
    this.input = input;
  }

  /** Return world-space position of wheel i (chassis pos + rotated local pos).
   *  Used for surface lookup. */
  private wheelWorldPos(i: number): { x: number; y: number; z: number } {
    const wp = VEHICLE.wheelPositions[i]!;
    const t = this.body.translation();
    const r = this.body.rotation();
    // Rotate local point by quaternion: q * v * q^-1.
    const x = wp.x, y = wp.y, z = wp.z;
    const qx = r.x, qy = r.y, qz = r.z, qw = r.w;
    const ix = qw * x + qy * z - qz * y;
    const iy = qw * y + qz * x - qx * z;
    const iz = qw * z + qx * y - qy * x;
    const iw = -qx * x - qy * y - qz * z;
    return {
      x: t.x + ix * qw + iw * -qx + iy * -qz - iz * -qy,
      y: t.y + iy * qw + iw * -qy + iz * -qx - ix * -qz,
      z: t.z + iz * qw + iw * -qz + ix * -qy - iy * -qx,
    };
  }

  /** Apply input to wheels - called before world.step(). */
  preStep(): void {
    const dt = 1 / 60;
    // Smooth steering toward target so input doesn't snap the wheels.
    const targetSteer = this.input.steer * VEHICLE.maxSteer;
    const steerDelta = targetSteer - this.currentSteer;
    const maxStep = VEHICLE.steerSpeed * dt;
    this.currentSteer +=
      Math.abs(steerDelta) < maxStep ? steerDelta : Math.sign(steerDelta) * maxStep;

    // Front wheels steer (indices 0, 1).
    this.controller.setWheelSteering(0, this.currentSteer);
    this.controller.setWheelSteering(1, this.currentSteer);

    // Per-wheel surface lookup. Front wheels intentionally have less grip
    // (frontGripMult) so the car understeers and slides under hard turns
    // rather than pivoting fast enough to roll over.
    for (let i = 0; i < 4; i++) {
      const wp = this.wheelWorldPos(i);
      const surf = sampleSurface(this.world.terrain, wp.x, wp.z);
      this.wheelSurface[i] = surf;
      const grip = surfaceGrip(surf);
      const axleMult = i < 2 ? VEHICLE.frontGripMult : VEHICLE.rearGripMult;
      this.controller.setWheelFrictionSlip(i, 2.0 * grip * axleMult);
    }

    // Engine + gearbox: average wheel angular velocity (signed, with sign
    // taken from the chassis longitudinal velocity so a wheel-spin in
    // mud doesn't lie about which gear we want).
    const wheelAngVels = [0, 1, 2, 3].map((i) => this.controller.wheelRotation(i) ?? 0);
    const avgDriveAng = (wheelAngVels[0]! + wheelAngVels[1]! + wheelAngVels[2]! + wheelAngVels[3]!) / 4;
    const fwd = this.body.linvel();
    const yaw = this.body.rotation();
    const forwardX = 2 * (yaw.x * yaw.z + yaw.w * yaw.y);
    const forwardZ = 1 - 2 * (yaw.x * yaw.x + yaw.y * yaw.y);
    const longitudinal = fwd.x * forwardX + fwd.z * forwardZ;
    const signedAngVel = Math.sign(longitudinal || avgDriveAng) * Math.abs(avgDriveAng);

    const out = stepEngine(this.engine, signedAngVel, this.input.throttle, dt);
    this.lastRpm = out.rpm;
    this.lastGear = out.gear;

    // Distribute torque across axles. Per-wheel grip gates how much
    // torque the surface can absorb (mud transmits less than road).
    //
    // Slip-curve modulation on top of this is *also* implemented in
    // tire.ts but not yet wired here - applying it to engine force
    // directly creates a chicken-and-egg at standstill (zero slip ->
    // zero force -> no movement -> still zero slip). The right place
    // is on Rapier's wheelFrictionSlip per step; left for a follow-up.
    const frontShare = VEHICLE.driveSplit.front;
    const rearShare = VEHICLE.driveSplit.rear;
    for (let i = 0; i < 4; i++) {
      const isFront = i < 2;
      const share = isFront ? frontShare / 2 : rearShare / 2;
      const surfaceMult = surfaceGrip(this.wheelSurface[i] ?? Surface.Dirt);
      this.controller.setWheelEngineForce(i, out.wheelForce * share * surfaceMult);
    }
    void wheelAngVels; // wired to setWheelFrictionSlip in a future pass

    // Brakes on all four. Handbrake locks rears for slides.
    const brake = this.input.brake * VEHICLE.brakeForce;
    const hand = this.input.handbrake * VEHICLE.brakeForce * 1.5;
    this.controller.setWheelBrake(0, brake);
    this.controller.setWheelBrake(1, brake);
    this.controller.setWheelBrake(2, brake + hand);
    this.controller.setWheelBrake(3, brake + hand);

    this.controller.updateVehicle(dt);
  }

  postStep(): void {
    // Accumulate wheel spin for visual rotation.
    for (let i = 0; i < 4; i++) {
      const angVel = this.controller.wheelRotation(i) ?? 0;
      this.wheelSpin[i] = (this.wheelSpin[i] ?? 0) + angVel;
    }
  }

  /** Per-wheel snapshot for rut accumulation. We model erosion as
   *  proportional to the energy the wheel is dumping into the ground -
   *  approximated by max(|throttle|, |brake|) when the wheel is in contact.
   *  Cruising over mud still carves ruts (a wheel with weight on it
   *  compresses the surface); spinning under throttle carves more. */
  wheelSamples(): {
    x: number; z: number; contact: boolean; slip: number;
  }[] {
    const out: { x: number; z: number; contact: boolean; slip: number }[] = [];
    const throttle = Math.abs(this.input.throttle);
    const brake = this.input.brake + this.input.handbrake;
    // Even passive rolling carves a small rut from chassis weight.
    const passive = 0.15;
    const slip = Math.min(1, Math.max(passive, throttle, brake));
    for (let i = 0; i < 4; i++) {
      const wp = this.wheelWorldPos(i);
      const contact = this.controller.wheelIsInContact(i) ?? false;
      out.push({ x: wp.x, z: wp.z, contact, slip });
    }
    return out;
  }

  /** Reset to a spawn pose. Called when player presses R (or hits map edge). */
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
  }

  getState(): VehicleState {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const wheels: WheelState[] = [];
    for (let i = 0; i < 4; i++) {
      wheels.push({
        steer: i < 2 ? this.currentSteer : 0,
        spin: this.wheelSpin[i] ?? 0,
        contact: this.controller.wheelIsInContact(i) ?? false,
        suspensionLength:
          this.controller.wheelSuspensionLength(i) ?? VEHICLE.suspensionRestLength,
      });
    }
    return {
      position: { x: t.x, y: t.y, z: t.z },
      rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
      linVel: { x: lv.x, y: lv.y, z: lv.z },
      angVel: { x: av.x, y: av.y, z: av.z },
      rpm: this.lastRpm,
      gear: this.lastGear,
      throttle: this.input.throttle,
      wheels,
    };
  }

  dispose(): void {
    this.world.world.removeVehicleController(this.controller);
    this.world.world.removeRigidBody(this.body);
  }
}

function surfaceGrip(s: Surface): number {
  switch (s) {
    case Surface.Road: return SURFACE_FRICTION.road;
    case Surface.Dirt: return SURFACE_FRICTION.dirt;
    case Surface.Mud: return SURFACE_FRICTION.mud;
    case Surface.DeepMud: return SURFACE_FRICTION.deepMud;
  }
}
