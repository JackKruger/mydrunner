// Vehicle uses Rapier's DynamicRayCastVehicleController - a Bullet-style
// raycast vehicle. Fast, robust, and gives us per-wheel suspension and
// friction we can later modulate by surface (mud, deep mud).
//
// This is intentionally simple for the MVP. The "feel" knobs all live in
// constants.VEHICLE so we can tune without touching code.

import RAPIER from '@dimforge/rapier3d-compat';
import { VEHICLE } from '../constants.js';
import { EMPTY_INPUT, type PlayerInput, type VehicleState, type WheelState } from '../types.js';
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

    // Rear-wheel drive. Throttle in [-1,1].
    const drive = this.input.throttle * VEHICLE.engineForce;
    this.controller.setWheelEngineForce(2, drive);
    this.controller.setWheelEngineForce(3, drive);

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
      wheels,
    };
  }

  dispose(): void {
    this.world.world.removeVehicleController(this.controller);
    this.world.world.removeRigidBody(this.body);
  }
}
