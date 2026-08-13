import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUTTON_FRONT_LOCKER, BUTTON_RANGE, BUTTON_REAR_LOCKER, EMPTY_INPUT } from '../types.js';
import { createStockBuild } from '../vehicleBuild.js';
import {
  COLLISION_GROUP_WORLD,
  COLLISION_GROUP_WHEEL_RAY,
} from '../physics/collisionGroups.js';
import { SolidAxleVehicle } from '../physics/solidAxleVehicle.js';
import { pressureEdgeWrapScale } from '../physics/tireCarcass.js';
import {
  Surface,
  mountainFor,
  petrolStationPadFor,
  type TerrainData,
  dryWater,
} from '../physics/terrain.js';
import {
  cylinderRotation,
  findHeightfieldLedgeContact,
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
  it('validates the upper surface of a coarse heightfield for a large tyre', () => {
    const resolution = 9;
    const size = 4;
    const heights = new Float32Array(resolution * resolution);
    for (let row = 0; row < resolution; row++) {
      const height = row >= 4 ? 0.6 : 0;
      for (let column = 0; column < resolution; column++) {
        heights[row * resolution + column] = height;
      }
    }
    const terrain: TerrainData = {
      size,
      resolution,
      heights,
      surfaces: new Uint8Array(resolution * resolution).fill(Surface.Dirt),
      seed: 0,
      mountain: mountainFor(size),
      petrolStation: petrolStationPadFor(size),
      ...dryWater(resolution),
      bogs: [],
      roads: [],
    };
    const rapierHeights = new Float32Array(heights.length);
    for (let column = 0; column < resolution; column++) {
      for (let row = 0; row < resolution; row++) {
        rapierHeights[column * resolution + row] = heights[row * resolution + column]!;
      }
    }
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = world.createCollider(
      RAPIER.ColliderDesc.heightfield(
        resolution - 1,
        resolution - 1,
        rapierHeights,
        { x: size, y: 1, z: size },
      ).setFriction(1).setCollisionGroups(COLLISION_GROUP_WORLD),
      body,
    );
    world.step();

    const wheelRadius = 0.508;
    const wheelHalfWidth = 0.22;
    const wheelCenter = { x: 0, y: wheelRadius, z: -0.65 };
    const castOrigin = { x: wheelCenter.x, y: wheelCenter.y + 0.5, z: wheelCenter.z };
    const wheelAxle = { x: 1, y: 0, z: 0 };
    const rotation = cylinderRotation(wheelAxle);
    const shape = new RAPIER.Cylinder(wheelHalfWidth, wheelRadius);
    const cast = collider.castShape(
      { x: 0, y: 0, z: 0 },
      shape,
      castOrigin,
      rotation,
      { x: 0, y: -1, z: 0 },
      0,
      1.5,
      true,
    );
    expect(cast).not.toBeNull();
    // This is the Rapier 0.14 failure mode Stage 1 must not depend on.
    expect(collider.contactShape(shape, wheelCenter, rotation, 0.015)).toBeNull();

    const normal = cast!.normal1;
    const hitCenter = {
      x: castOrigin.x,
      y: castOrigin.y - cast!.time_of_impact,
      z: castOrigin.z,
    };
    const axial = normal.x * wheelAxle.x + normal.y * wheelAxle.y + normal.z * wheelAxle.z;
    const radialLength = Math.hypot(
      normal.x - wheelAxle.x * axial,
      normal.y - wheelAxle.y * axial,
      normal.z - wheelAxle.z * axial,
    );
    const radialScale = wheelRadius / radialLength;
    const capScale = Math.sign(axial) * wheelHalfWidth;
    const facePoint = {
      x: hitCenter.x - (normal.x - wheelAxle.x * axial) * radialScale - wheelAxle.x * capScale,
      y: hitCenter.y - (normal.y - wheelAxle.y * axial) * radialScale - wheelAxle.y * capScale,
      z: hitCenter.z - (normal.z - wheelAxle.z * axial) * radialScale - wheelAxle.z * capScale,
    };
    const hitAtPressure = (pressurePsi: number) => findHeightfieldLedgeContact(
      terrain,
      wheelCenter,
      facePoint,
      normal,
      { x: 0, y: 0, z: 1 },
      wheelAxle,
      wheelRadius,
      wheelHalfWidth,
      0.015,
      0.65,
      0.9,
      0.08 * pressureEdgeWrapScale(pressurePsi, 18),
      1,
    );
    const low = hitAtPressure(6);
    const hit = hitAtPressure(18);
    const high = hitAtPressure(28);

    expect(low).not.toBeNull();
    expect(hit).not.toBeNull();
    expect(high).not.toBeNull();
    expect(hit!.normal.y).toBeLessThan(0.65);
    expect(hit!.climbTopY).toBeCloseTo(0.6, 6);
    expect(hit!.point.y).toBeCloseTo(0.6, 4);
    expect(hit!.climbDirection).not.toBeNull();
    expect(hit!.climbDirection!.y).toBeGreaterThan(0.5);
    expect(hit!.climbDirection!.z).toBeGreaterThan(0.5);
    expect(low!.climbDirection!.z).toBeGreaterThan(hit!.climbDirection!.z);
    expect(hit!.climbDirection!.z).toBeGreaterThan(high!.climbDirection!.z);
    world.free();
  });

  it('finds the leading face and a reachable upper edge before the hub crosses it', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addStep(world, 0.35, 0.35);

    const hitAtPressure = (pressurePsi: number) => findSteepWheelContact(
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
      0.08 * pressureEdgeWrapScale(pressurePsi, 18),
      { x: 0, y: 0, z: 1 },
      COLLISION_GROUP_WHEEL_RAY,
    );
    const low = hitAtPressure(6);
    const hit = hitAtPressure(18);
    const high = hitAtPressure(28);

    expect(low).not.toBeNull();
    expect(hit).not.toBeNull();
    expect(high).not.toBeNull();
    expect(hit!.normal.z).toBeLessThan(-0.95);
    expect(hit!.climbTopY).toBeCloseTo(0.7, 3);
    expect(hit!.climbDirection!.y).toBeGreaterThan(0.7);
    expect(hit!.climbDirection!.z).toBeGreaterThan(0.4);
    expect(low!.climbDirection!.z).toBeGreaterThan(hit!.climbDirection!.z);
    expect(hit!.climbDirection!.z).toBeGreaterThan(high!.climbDirection!.z);
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
