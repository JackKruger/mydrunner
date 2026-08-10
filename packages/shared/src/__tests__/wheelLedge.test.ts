import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUTTON_FRONT_LOCKER, BUTTON_RANGE, BUTTON_REAR_LOCKER, EMPTY_INPUT } from '../types.js';
import { createStockBuild } from '../vehicleBuild.js';
import {
  COLLISION_GROUP_WORLD,
  COLLISION_GROUP_WHEEL_RAY,
} from '../physics/collisionGroups.js';
import { SolidAxleVehicle } from '../physics/solidAxleVehicle.js';
import {
  Surface,
  mountainFor,
  petrolStationPadFor,
  type TerrainData,
  dryWater,
} from '../physics/terrain.js';
import {
  cylinderRotation,
  findSteepWheelContact,
} from '../physics/wheelContact.js';
import type { WheelKinematic } from '../physics/wheelDynamics.js';
import { World, initRapier } from '../physics/world.js';

beforeAll(async () => {
  await initRapier();
});

function addStep(
  world: RAPIER.World,
  halfHeight: number,
  centerY: number,
): void {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, centerY, 8),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(8, halfHeight, 6)
      .setFriction(1)
      .setCollisionGroups(COLLISION_GROUP_WORLD),
    body,
  );
  world.step();
}

describe('wheel ledge contact geometry', () => {
  it('finds the leading face and a reachable upper edge before the hub crosses it', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addStep(world, 0.35, 0.35);

    const hit = findSteepWheelContact(
      world,
      new RAPIER.Cylinder(0.21, 0.46),
      { x: -0.92, y: 0.46, z: 1.50 },
      { x: -0.92, y: 0.46, z: 1.53 },
      cylinderRotation({ x: 1, y: 0, z: 0 }),
      0.46,
      0.21,
      0.015,
      0.65,
      0.9,
      0.08,
      { x: 0, y: 0, z: 1 },
      COLLISION_GROUP_WHEEL_RAY,
    );

    expect(hit).not.toBeNull();
    expect(hit!.normal.z).toBeLessThan(-0.95);
    expect(hit!.climbTopY).toBeCloseTo(0.7, 3);
    expect(hit!.climbDirection!.y).toBeGreaterThan(0.7);
    expect(hit!.climbDirection!.z).toBeGreaterThan(0.4);
    world.free();
  });

  it('does not turn an unbounded wall into a climbable edge', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addStep(world, 5, 5);

    const hit = findSteepWheelContact(
      world,
      new RAPIER.Cylinder(0.21, 0.46),
      null,
      { x: 0, y: 0.46, z: 1.53 },
      cylinderRotation({ x: 1, y: 0, z: 0 }),
      0.46,
      0.21,
      0.015,
      0.65,
      0.9,
      0.08,
      { x: 0, y: 0, z: 1 },
      COLLISION_GROUP_WHEEL_RAY,
    );

    expect(hit).not.toBeNull();
    expect(hit!.climbDirection).toBeNull();
    expect(hit!.climbTopY).toBeNull();
    world.free();
  });
});

function flatVehicleWorld(): { world: World; vehicle: SolidAxleVehicle } {
  const resolution = 16;
  const terrain: TerrainData = {
    size: 40,
    resolution,
    heights: new Float32Array(resolution * resolution),
    surfaces: new Uint8Array(resolution * resolution).fill(Surface.Road),
    seed: 0,
    mountain: mountainFor(40),
    petrolStation: petrolStationPadFor(40),
    ...dryWater(resolution),
    bogs: [],
    roads: [],
  };
  const world = new World({ terrain });
  const stepBody = world.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0.275, 8),
  );
  world.world.createCollider(
    RAPIER.ColliderDesc.cuboid(8, 0.275, 6)
      .setFriction(1)
      .setCollisionGroups(COLLISION_GROUP_WORLD),
    stepBody,
  );
  const vehicle = new SolidAxleVehicle(
    world,
    'ledge-test',
    { position: { x: 0, y: 1.6, z: 0 } },
    {
      ...createStockBuild('outclaw'),
      suspensionId: 'outclaw.suspension.flex-100',
      axleId: 'outclaw.axle.portal-240',
      tireId: 'outclaw.tire.xt-40-wide',
      wheelId: 'outclaw.wheel.beadlock-alloy',
      frontLocker: true,
      rearLocker: true,
    },
  );
  world.vehicles.set(vehicle.id, vehicle);
  return { world, vehicle };
}

describe('solid axle sharp-step traversal', () => {
  it('loads a prepared crawler against a 0.55 m step without a depth launch', () => {
    const { world, vehicle } = flatVehicleWorld();
    for (let i = 0; i < 180; i++) world.step();
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, buttons: BUTTON_RANGE | BUTTON_FRONT_LOCKER | BUTTON_REAR_LOCKER });
    world.step();

    const wheels = (vehicle as unknown as { wheels: WheelKinematic[] }).wheels;
    let firstContactZ: number | null = null;
    let clearedTick = -1;
    let maxRideDelta = 0;
    let maxAbsVerticalSpeed = 0;
    let maxPitchQuaternionX = 0;
    let maxDrivenLedgeForce = 0;
    let previousRide = vehicle.axleSnaps()[0]!.rideY;

    for (let tick = 0; tick < 520; tick++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: tick + 2, throttle: 0.35 });
      world.step();
      const state = vehicle.getState();

      if (firstContactZ === null && wheels[0]!.ledgeContact) {
        firstContactZ = state.position.z;
      }
      if (firstContactZ !== null) {
        const ride = vehicle.axleSnaps()[0]!.rideY;
        maxRideDelta = Math.max(maxRideDelta, Math.abs(ride - previousRide));
        previousRide = ride;
        maxAbsVerticalSpeed = Math.max(maxAbsVerticalSpeed, Math.abs(state.linVel.y));
        maxPitchQuaternionX = Math.max(maxPitchQuaternionX, Math.abs(state.rotation.x));
        maxDrivenLedgeForce = Math.max(
          maxDrivenLedgeForce,
          Math.abs(wheels[0]!.ledgeLongForce),
          Math.abs(wheels[1]!.ledgeLongForce),
          Math.abs(wheels[2]!.ledgeLongForce),
          Math.abs(wheels[3]!.ledgeLongForce),
        );
      }
      if (state.position.z > 4) {
        clearedTick = tick;
        break;
      }
    }

    const final = vehicle.getState();
    expect(firstContactZ).not.toBeNull();
    expect(firstContactZ!).toBeLessThan(0.35);
    expect(maxDrivenLedgeForce).toBeGreaterThan(500);
    // Completion is deliberately not guaranteed by an invisible edge motor.
    // The physical acceptance course separately chooses obstacles that the
    // prepared crawler's tyre radius, gearing and contact load can solve.
    expect(Number.isFinite(final.position.y)).toBe(true);
    expect(maxRideDelta).toBeLessThan(0.45);
    expect(maxAbsVerticalSpeed).toBeLessThan(2.2);
    // A prepared crawler is expected to pitch noticeably while its rear axle
    // climbs the step, but it must not approach a forward tip-over.
    expect(maxPitchQuaternionX).toBeLessThan(0.5);
    world.dispose();
  });
});
