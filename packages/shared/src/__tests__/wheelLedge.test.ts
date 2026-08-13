import RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUTTON_FRONT_LOCKER, BUTTON_RANGE, BUTTON_REAR_LOCKER, EMPTY_INPUT } from '../types.js';
import { createStockBuild } from '../vehicleBuild.js';
import type { VehicleBuild } from '../types.js';
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
  createSteepWheelContactResult,
  cylinderRotation,
  findHeightfieldLedgeContact,
  findSteepWheelContact,
  findSteepWheelContactsInto,
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

function addRock(world: RAPIER.World, radius: number, z: number, x = 0): void {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(x, radius * 0.6, z),
  );
  world.createCollider(
    RAPIER.ColliderDesc.ball(radius)
      .setFriction(1)
      .setCollisionGroups(COLLISION_GROUP_WORLD),
    body,
  );
  world.step();
}

function addAxialLog(world: RAPIER.World, radius: number, z: number): void {
  const halfSqrt = Math.SQRT1_2;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(2, radius)
      .setTranslation(0, radius, z)
      .setRotation({ x: 0, y: 0, z: -halfSqrt, w: halfSqrt })
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

  it.each([
    ['spherical rock', (world: RAPIER.World) => addRock(world, 0.35, 2), 1.225],
    ['cylindrical log', (world: RAPIER.World) => addAxialLog(world, 0.35, 2), 1.195],
  ])('finds an ahead climb target on a %s at first practical contact', (_name, add, centerZ) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    add(world);
    const wheelCenter = { x: 0, y: 0.46, z: centerZ };
    const hit = findSteepWheelContact(
      world,
      new RAPIER.Cylinder(0.21, 0.46),
      null,
      wheelCenter,
      cylinderRotation({ x: 1, y: 0, z: 0 }),
      0.46,
      0.21,
      0.015,
      0.65,
      0.9,
      0.08,
      { x: 0, y: 0, z: 1 },
      COLLISION_GROUP_WHEEL_RAY,
      { x: 1, y: 0, z: 0 },
    );

    expect(hit).not.toBeNull();
    expect(hit!.climbDirection).not.toBeNull();
    expect(hit!.climbDirection!.y).toBeGreaterThan(0);
    expect(hit!.climbDirection!.z).toBeGreaterThan(0);
    world.free();
  });

  it('retains opposing log constraints and selects only the forward face for drive', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    addAxialLog(world, 0.25, -0.55);
    addAxialLog(world, 0.25, 0.55);
    const result = createSteepWheelContactResult();
    const wheelShape = new RAPIER.Cylinder(0.21, 0.46);
    for (const centerZ of [-0.002, 0, 0.002]) {
      findSteepWheelContactsInto(
        world,
        wheelShape,
        null,
        { x: 0, y: 0.46, z: centerZ },
        cylinderRotation({ x: 1, y: 0, z: 0 }),
        0.46,
        0.21,
        0.015,
        0.65,
        0.9,
        0.08,
        { x: 0, y: 0, z: 1 },
        COLLISION_GROUP_WHEEL_RAY,
        result,
        { x: 1, y: 0, z: 0 },
      );

      expect(result.count).toBe(2);
      expect(result.contacts[0]!.normal.z * result.contacts[1]!.normal.z).toBeLessThan(0);
      expect(result.driveContactIndex).toBeGreaterThanOrEqual(0);
      const driven = result.contacts[result.driveContactIndex]!;
      expect(driven.normal.z).toBeLessThan(0);
      expect(driven.climbDirection!.z).toBeGreaterThan(0);
      const other = result.contacts[result.driveContactIndex === 0 ? 1 : 0]!;
      expect(other.climbDirection).toBeNull();
    }
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

  function obstacleVehicleWorld(
    build: VehicleBuild,
    obstacle: 'rocks' | 'log' | 'boulder',
    radius: number,
  ): { world: World; vehicle: SolidAxleVehicle } {
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
    const trackHalf = build.baseId === 'outclaw' ? 1.07 : 0.89;
    if (obstacle === 'log') addAxialLog(world.world, radius, 5);
    else {
      addRock(world.world, radius, 5, -trackHalf);
      addRock(world.world, radius, 5, trackHalf);
    }
    const vehicle = new SolidAxleVehicle(
      world,
      `round-${obstacle}-${build.baseId}`,
      { position: { x: 0, y: 1.6, z: 0 } },
      build,
    );
    world.vehicles.set(vehicle.id, vehicle);
    return { world, vehicle };
  }

  function runRoundObstacle(
    build: VehicleBuild,
    obstacle: 'rocks' | 'log' | 'boulder',
    radius: number,
    ticks: number,
    throttle = 0.30,
  ): {
    clearedTick: number;
    maxPitch: number;
    maxVerticalSpeed: number;
    maxDrivenLedgeForce: number;
    maxContactCount: number;
    finalZ: number;
    finite: boolean;
  } {
    const { world, vehicle } = obstacleVehicleWorld(build, obstacle, radius);
    for (let i = 0; i < 180; i++) world.step();
    vehicle.setInput({
      ...EMPTY_INPUT,
      seq: 1,
      buttons: BUTTON_RANGE | BUTTON_FRONT_LOCKER | BUTTON_REAR_LOCKER,
    });
    world.step();
    const wheels = (vehicle as unknown as { wheels: WheelKinematic[] }).wheels;
    let clearedTick = -1;
    let maxPitch = 0;
    let maxVerticalSpeed = 0;
    let maxDrivenLedgeForce = 0;
    let maxContactCount = 0;
    let finite = true;
    for (let tick = 0; tick < ticks; tick++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: tick + 2, throttle });
      world.step();
      const state = vehicle.getState();
      maxPitch = Math.max(maxPitch, Math.abs(state.rotation.x));
      maxVerticalSpeed = Math.max(maxVerticalSpeed, Math.abs(state.linVel.y));
      finite &&= Number.isFinite(state.position.x + state.position.y + state.position.z)
        && Number.isFinite(state.rotation.x + state.rotation.y + state.rotation.z + state.rotation.w);
      for (const wheel of wheels) {
        maxDrivenLedgeForce = Math.max(maxDrivenLedgeForce, Math.abs(wheel.ledgeLongForce));
        maxContactCount = Math.max(maxContactCount, wheel.ledgeContactCount);
      }
      if (state.position.z > 7.5) {
        clearedTick = tick;
        break;
      }
    }
    const finalZ = vehicle.getState().position.z;
    world.dispose();
    return {
      clearedTick, maxPitch, maxVerticalSpeed, maxDrivenLedgeForce,
      maxContactCount, finalZ, finite,
    };
  }

  it.each(['rocks', 'log'] as const)(
    'clears prepared-crawler 0.35 m %s without launch or excessive pitch',
    (obstacle) => {
      const prepared: VehicleBuild = {
        ...createStockBuild('outclaw'),
        suspensionId: 'outclaw.suspension.flex-100',
        axleId: 'outclaw.axle.portal-240',
        tireId: 'outclaw.tire.xt-40-wide',
        wheelId: 'outclaw.wheel.beadlock-alloy',
        frontLocker: true,
        rearLocker: true,
      };
      const run = runRoundObstacle(prepared, obstacle, 0.35, 760);
      expect(run.finite).toBe(true);
      expect(run.clearedTick, JSON.stringify(run)).toBeGreaterThanOrEqual(0);
      expect(run.maxContactCount).toBeGreaterThan(0);
      expect(run.maxDrivenLedgeForce).toBeGreaterThan(250);
      expect(run.maxPitch).toBeLessThan(0.55);
      expect(run.maxVerticalSpeed).toBeLessThan(2.5);
    },
    10_000,
  );

  // A single traversal is a coin flip, so this asserts a RATE.
  //
  // This was `clear 0.25 m %s safely` — one run per obstacle, asserting it
  // got over. That run sits on a bifurcation and cannot distinguish a real
  // regression from noise. Measured, with the combined-slip term switched
  // off entirely: raising the unrelated `tireLongGripMult` by 5% makes the
  // same truck fail the same rock, and the clear tick jitters 201 / 237 /
  // 218 / 207 / never across +-5%. MORE grip failing is the tell — it was
  // never measuring grip margin.
  //
  // Across the crawl regime the picture is stable where the single cell is
  // not: 11/24 traversals cleared with the term off against 12/24 with it
  // on. So the capability is asserted over the grid, and every run must
  // still stay finite and upright.
  it('lets a stock Ridgeback in 4L clear round obstacles across the crawl regime', () => {
    const THROTTLES = [0.25, 0.30, 0.40, 0.50];
    const RADII = [0.20, 0.25, 0.30];
    let cleared = 0;
    let attempts = 0;
    let worstVerticalSpeed = 0;
    const failures: string[] = [];

    for (const obstacle of ['rocks', 'log'] as const) {
      for (const radius of RADII) {
        for (const throttle of THROTTLES) {
          const run = runRoundObstacle(
            createStockBuild('ridgeback'), obstacle, radius, 760, throttle,
          );
          attempts++;
          if (run.clearedTick >= 0) cleared++;
          worstVerticalSpeed = Math.max(worstVerticalSpeed, run.maxVerticalSpeed);
          expect(run.finite, `${obstacle} r=${radius} throttle=${throttle}`).toBe(true);
          if (run.maxPitch >= 0.85) {
            failures.push(`${obstacle} r=${radius} thr=${throttle} pitch ${run.maxPitch.toFixed(2)}`);
          }
        }
      }
    }

    expect(failures, failures.join('; ')).toHaveLength(0);
    expect(
      cleared,
      `only ${cleared}/${attempts} round-obstacle traversals cleared; measured 11/24 with the combined-slip term off and 12/24 with it on`,
    ).toBeGreaterThanOrEqual(9);

    // KNOWN DEFECT, pre-existing and not asserted away: somewhere in this
    // grid the contact solver ejects the truck vertically at 28.5 m/s with
    // the combined-slip term off (rocks r=0.25 throttle 0.40) and 39.5 m/s
    // with it on (log r=0.25 throttle 0.50) — ~100-140 km/h upward from
    // crawling into a 25 cm obstacle at part throttle. Which cell blows up
    // moves with any tyre parameter, which is most of why single-run
    // traversal assertions here are unreliable. This bound is deliberately
    // far above the physical ~2.5 m/s a crawl should produce: it is a
    // tripwire against the instability getting worse, NOT a claim that 40
    // m/s is acceptable. Fixing it belongs with the obstacle-contact work.
    expect(
      worstVerticalSpeed,
      `vertical ejection grew to ${worstVerticalSpeed.toFixed(1)} m/s`,
    ).toBeLessThan(50);
  }, 30_000);

  it('stalls stably at paired 0.70 m boulders without driven ledge lift', () => {
    const prepared: VehicleBuild = {
      ...createStockBuild('outclaw'),
      suspensionId: 'outclaw.suspension.flex-100',
      axleId: 'outclaw.axle.portal-240',
      tireId: 'outclaw.tire.xt-40-wide',
      wheelId: 'outclaw.wheel.beadlock-alloy',
      frontLocker: true,
      rearLocker: true,
    };
    const run = runRoundObstacle(prepared, 'boulder', 0.70, 620);
    expect(run.finite).toBe(true);
    expect(run.clearedTick).toBe(-1);
    expect(run.finalZ).toBeLessThan(5);
    expect(run.maxDrivenLedgeForce).toBe(0);
    expect(run.maxPitch).toBeLessThan(0.45);
    expect(run.maxVerticalSpeed).toBeLessThan(1.8);
  }, 10_000);
});
