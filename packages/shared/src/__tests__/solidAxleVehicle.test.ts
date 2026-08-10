// Integration tests for SolidAxleVehicle against real Rapier. The class
// isn't reachable through World.spawnVehicle while VEHICLE_MODEL='raycast',
// so we construct it directly and step the same World as the legacy
// vehicle would. These tests verify the new model produces sensible
// physics: settles to a stable rest pose, drives forward under throttle,
// road-vs-mud grip difference, and is deterministic across two worlds.

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  BUTTON_FRONT_LOCKER,
  BUTTON_RANGE,
  BUTTON_REAR_LOCKER,
  Physics,
  EMPTY_INPUT,
  SUSPENSION,
  TUNING,
  VEHICLE,
  VEHICLE_BASE_IDS,
  createStockBuild,
  resolveVehicleSpec,
  type PlayerInput,
  type VehicleBuild,
} from '../index.js';
import { mountainFor, petrolStationPadFor,
  dryWater,
} from '../physics/terrain.js';
import { cylinderRotation, wheelBasis } from '../physics/wheelContact.js';

beforeAll(async () => {
  await Physics.initRapier();
});

function makeWorld(build: VehicleBuild = createStockBuild('ridgeback')) {
  // Flat all-zero heightfield: removes terrain noise and obstacles as
  // variables so the test isolates SolidAxleVehicle behaviour. Same
  // pattern heightfield-debug.test.ts uses for the legacy vehicle.
  const n = 64;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(Physics.Surface.Road);
  const terrainData: Physics.TerrainData = {
    size: 200, resolution: n, heights, surfaces, seed: 0,
    mountain: mountainFor(200),
    petrolStation: petrolStationPadFor(200),
    ...dryWater(n),
    bogs: [],
    roads: [],
  };
  const world = new Physics.World({ terrain: terrainData });
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'p',
    { position: { x: 0, y: 1.5, z: 0 } },
    build,
  );
  // World.spawnVehicle would register the vehicle through the factory;
  // we bypass it because VEHICLE_MODEL='raycast' would route us to the
  // legacy class. Register manually so World.step() drives our axle
  // vehicle's preStep/postStep.
  world.vehicles.set(vehicle.id, vehicle);
  return { world, vehicle };
}

function makeGradientBreakWorld(spawnZ = -1.5, oneSided = false) {
  // One-metre cells with a flat approach, a single 45-degree triangle strip,
  // then a one-metre-high plateau. Put the front hubs just before the break:
  // their centre rays still see the low approach, but their leading tread is
  // already over the rising triangle.
  const resolution = 33;
  const size = 32;
  const heights = new Float32Array(resolution * resolution);
  for (let row = 0; row < resolution; row++) {
    const z = -size / 2 + row * size / (resolution - 1);
    const height = z <= 0 ? 0 : Math.min(1, z);
    for (let col = 0; col < resolution; col++) {
      const x = -size / 2 + col * size / (resolution - 1);
      heights[row * resolution + col] = oneSided && x > 0 ? 0 : height;
    }
  }
  const surfaces = new Uint8Array(resolution * resolution);
  surfaces.fill(Physics.Surface.Road);
  const terrainData: Physics.TerrainData = {
    size, resolution, heights, surfaces, seed: 0,
    mountain: mountainFor(size),
    petrolStation: petrolStationPadFor(size),
    ...dryWater(resolution),
    bogs: [],
    roads: [],
  };
  const world = new Physics.World({ terrain: terrainData, obstacles: [] });
  const vehicle = new Physics.SolidAxleVehicle(
    world,
    'gradient-break',
    { position: { x: 0, y: 1.7, z: spawnZ } },
    createStockBuild('ridgeback'),
  );
  world.vehicles.set(vehicle.id, vehicle);
  return { world, vehicle };
}

function frontVisualTyreDistances(
  world: Physics.World,
  vehicle: Physics.SolidAxleVehicle,
): number[] {
  const position = vehicle.body.translation();
  const rotation = vehicle.body.rotation();
  const geom = vehicle.geom;
  const axle = vehicle.axleSnaps()[0];
  const forward = Physics.rotateVecByQuat({ x: 0, y: 0, z: 1 }, rotation);
  const right = Physics.rotateVecByQuat({ x: 1, y: 0, z: 0 }, rotation);
  const up = Physics.rotateVecByQuat({ x: 0, y: 1, z: 0 }, rotation);
  const basis = wheelBasis(forward, right, up, axle.rollAngle, 0);
  const wheelRotation = cylinderRotation(basis.axle);
  const wheelShape = new RAPIER.Cylinder(geom.wheelWidth / 2, geom.wheelRadius);
  const wheelStates = vehicle.getState().wheels;
  const cr = Math.cos(axle.rollAngle);
  const sr = Math.sin(axle.rollAngle);
  const rayDirection = Physics.rotateVecByQuat({ x: 0, y: -1, z: 0 }, rotation);

  return [-geom.front.trackHalf, geom.front.trackHalf].map((localX, index) => {
    const localCenter = {
      x: localX * cr,
      y: geom.front.centerLocalY - geom.front.suspensionRestLength
        + axle.rideY + localX * sr,
      z: geom.front.centerLocalZ,
    };
    const offset = Physics.rotateVecByQuat(localCenter, rotation);
    const center = {
      x: position.x + offset.x,
      y: position.y + offset.y,
      z: position.z + offset.z,
    };
    const localOrigin = {
      x: localX,
      y: geom.front.centerLocalY + SUSPENSION.rayLift,
      z: geom.front.centerLocalZ,
    };
    const originOffset = Physics.rotateVecByQuat(localOrigin, rotation);
    const origin = {
      x: position.x + originOffset.x,
      y: position.y + originOffset.y,
      z: position.z + originOffset.z,
    };
    const hit = world.world.castShape(
      origin,
      wheelRotation,
      rayDirection,
      wheelShape,
      0,
      SUSPENSION.rayLift
        + geom.front.suspensionRestLength
        + geom.front.droopMax,
      true,
      undefined,
      Physics.COLLISION_GROUP_WHEEL_RAY,
      undefined,
      vehicle.body,
    );
    if (!hit || hit.collider.handle !== world.terrainCollider.handle) {
      return Number.POSITIVE_INFINITY;
    }
    const visualTravel =
      (center.x - origin.x) * rayDirection.x
      + (center.y - origin.y) * rayDirection.y
      + (center.z - origin.z) * rayDirection.z;
    // The rendered carcass clamps its contact-facing vertices by this
    // replicated amount; a rigid nominal-radius cylinder intentionally
    // extends that far below the loaded tyre shape.
    return hit.time_of_impact - visualTravel + (wheelStates[index]?.tireDeflection ?? 0);
  });
}

function driveAcrossGradientBreak(oneSided = false) {
  const { world, vehicle } = makeGradientBreakWorld(-3.2, oneSided);
  vehicle.setInput({ ...EMPTY_INPUT, seq: 1, brake: 1 });
  settle(world, 180);
  vehicle.setInput({ ...EMPTY_INPUT, seq: 2, transferCase: '4l' });
  world.step();

  let minClearance = Number.POSITIVE_INFINITY;
  let crossed = false;
  for (let tick = 0; tick < 600; tick++) {
    vehicle.setInput({ ...EMPTY_INPUT, seq: tick + 3, throttle: 0.65 });
    world.step();
    const z = vehicle.getState().position.z;
    if (z > -2.2 && z < 1.5) {
      minClearance = Math.min(minClearance, ...frontVisualTyreDistances(world, vehicle));
    }
    if (z >= 1.5) {
      crossed = true;
      break;
    }
  }
  world.dispose();
  return { minClearance, crossed };
}

function fullThrottle(seq: number): PlayerInput {
  return { ...EMPTY_INPUT, seq, throttle: 1 };
}

function settle(world: Physics.World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

function rollTouchHeight(vehicle: Physics.SolidAxleVehicle, roll: number): number {
  const ext = vehicle.geom.chassisHalfExtents;
  const colHalfHeight = (VEHICLE.cabinRoofY + ext.y) / 2;
  const colCenterY = -ext.y + colHalfHeight;
  const lowestLocalY = colCenterY * Math.cos(roll)
    - colHalfHeight * Math.abs(Math.cos(roll))
    - ext.x * Math.abs(Math.sin(roll));
  return -lowestLocalY + 0.02;
}

function settleFromRoll(
  degrees: number,
  build = createStockBuild('ridgeback'),
  initialRollRate = 0,
  startHeight?: number,
) {
  const { world, vehicle } = makeWorld(build);
  const roll = degrees * Math.PI / 180;
  vehicle.body.setRotation({ x: 0, y: 0, z: Math.sin(roll / 2), w: Math.cos(roll / 2) }, true);
  vehicle.body.setTranslation({
    x: 0,
    y: startHeight ?? rollTouchHeight(vehicle, roll),
    z: 0,
  }, true);
  vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  vehicle.body.setAngvel({ x: 0, y: 0, z: initialRollRate }, true);
  let signedRollTravel = 0;
  for (let i = 0; i < 360; i++) {
    world.step();
    const state = vehicle.getState();
    const q = state.rotation;
    const forward = {
      x: 2 * (q.x * q.z + q.y * q.w),
      y: 2 * (q.y * q.z - q.x * q.w),
      z: 1 - 2 * (q.x * q.x + q.y * q.y),
    };
    signedRollTravel += (
      state.angVel.x * forward.x
      + state.angVel.y * forward.y
      + state.angVel.z * forward.z
    ) * (1 / 60);
  }
  const state = vehicle.getState();
  const upY = 1 - 2 * (state.rotation.x * state.rotation.x + state.rotation.z * state.rotation.z);
  world.dispose();
  return { upY, signedRollTravel };
}

function staticWheelTipAngle(build = createStockBuild('ridgeback')): number {
  const { world, vehicle } = makeWorld(build);
  settle(world, 480);
  const comHeight = vehicle.body.worldCom().y;
  const angle = Math.atan2(vehicle.geom.front.trackHalf, comHeight) * 180 / Math.PI;
  world.dispose();
  return angle;
}

describe('solid-axle vehicle: settling', () => {
  it('keeps the whole tyre above terrain at an abrupt gradient break', () => {
    const { world, vehicle } = makeGradientBreakWorld();
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, brake: 1 });
    settle(world, 600);

    const distances = frontVisualTyreDistances(world, vehicle);
    expect(distances.every(Number.isFinite)).toBe(true);
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(-0.02);
    world.dispose();
  });

  it('keeps the visible tyre above terrain while crossing an abrupt gradient break', () => {
    const { minClearance, crossed } = driveAcrossGradientBreak();
    expect(crossed).toBe(true);
    expect(minClearance).toBeGreaterThanOrEqual(-0.02);
  });

  it('keeps the loaded tyre above a one-sided gradient break while the axle articulates', () => {
    const { minClearance, crossed } = driveAcrossGradientBreak(true);
    expect(crossed).toBe(true);
    expect(minClearance).toBeGreaterThanOrEqual(-0.02);
  });

  it('uses each build exact mass and configured center of mass', () => {
    for (const baseId of VEHICLE_BASE_IDS) {
      const build = createStockBuild(baseId);
      const spec = resolveVehicleSpec(build);
      const { world, vehicle } = makeWorld(build);
      const localCom = vehicle.body.localCom();
      expect(vehicle.body.mass()).toBeCloseTo(spec.massKg, 3);
      expect(localCom.x).toBeCloseTo(spec.centerOfMass.x, 5);
      expect(localCom.y).toBeCloseTo(spec.centerOfMass.y, 5);
      expect(localCom.z).toBeCloseTo(spec.centerOfMass.z, 5);
      world.dispose();
    }
  });

  it('falls onto the ground and settles to a stable rest pose', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 480); // 8s - generous for the underdamped ride spring
    const s = vehicle.getState();
    // Below initial drop height.
    expect(s.position.y).toBeLessThan(1.5);
    // Above terrain (around y=0).
    expect(s.position.y).toBeGreaterThan(0);
    // Slow (the chassis still bobs at <50% of critical damping but the
    // peak velocity per cycle decays).
    expect(Math.hypot(s.linVel.x, s.linVel.y, s.linVel.z)).toBeLessThan(0.5);
    world.dispose();
  });

  it('does not slowly tip over on flat ground (rollover stability)', () => {
    // Regression test: previously, ride force was applied at the axle
    // CENTER (chassis x=0), which gave no roll-restoring torque when
    // the chassis tipped. Any small roll perturbation grew without
    // bound. The fix is to apply ride force at each wheel-end (+/-
    // trackHalf) so the loaded side produces a righting moment.
    const { world, vehicle } = makeWorld();
    settle(world, 480);
    // After 8s of just sitting on flat road, the chassis quaternion's
    // roll component (rotation about chassis-forward) should be tiny.
    const r = vehicle.getState().rotation;
    // Extract roll from quaternion (rotation about world Z when
    // chassis-forward maps to world +X via initial yaw=0).
    const roll = Math.atan2(2 * (r.w * r.x + r.y * r.z), 1 - 2 * (r.x * r.x + r.y * r.y));
    expect(Math.abs(roll)).toBeLessThan(0.1);
    // And angular velocity is small - chassis isn't actively tipping.
    const av = vehicle.getState().angVel;
    expect(Math.hypot(av.x, av.y, av.z)).toBeLessThan(0.2);
    world.dispose();
  });

  it('reports both axles touching ground after settling on flat-ish terrain', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 240);
    const snaps = vehicle.axleSnaps();
    // Both axles should be in contact (compression > 0).
    expect(snaps[0].rideY).toBeGreaterThanOrEqual(0);
    expect(snaps[1].rideY).toBeGreaterThanOrEqual(0);
    // Articulation should be small on flat-ish terrain.
    expect(Math.abs(snaps[0].rollAngle)).toBeLessThan(0.2);
    expect(Math.abs(snaps[1].rollAngle)).toBeLessThan(0.2);
    world.dispose();
  });

  it('keeps airborne roll momentum instead of correcting toward world-up', () => {
    const { world, vehicle } = makeWorld();
    vehicle.body.setTranslation({ x: 0, y: 20, z: 0 }, true);
    vehicle.body.setAngvel({ x: 0, y: 0, z: 2 }, true);
    settle(world, 60);
    expect(vehicle.getState().position.y).toBeGreaterThan(10);
    expect(vehicle.getState().angVel.z).toBeGreaterThan(1.7);
    world.dispose();
  });

  it('recovers below the balance point but does not self-right a committed rollover', () => {
    expect(settleFromRoll(35).upY).toBeGreaterThan(0.8);
    // A vehicle already past its side with downhill angular momentum must
    // finish the tumble instead of invoking an invisible upright motor.
    const committed = settleFromRoll(135, createStockBuild('ridgeback'), 1.5, 2.5);
    expect(committed.signedRollTravel).toBeGreaterThan(0.5);
    expect(committed.upY).toBeLessThan(0.5);
  });

  it.each([75, 85, 90])('keeps a %d° sidewall rest out of suspension and traction paths', (degrees) => {
    const { world, vehicle } = makeWorld();
    const roll = degrees * Math.PI / 180;
    vehicle.body.setRotation({ x: 0, y: 0, z: Math.sin(roll / 2), w: Math.cos(roll / 2) }, true);
    const axleAlignment = Math.abs(Math.sin(roll));
    const radialAlignment = Math.sqrt(Math.max(0, 1 - axleAlignment * axleAlignment));
    const centerRelativeY = -vehicle.geom.front.trackHalf * Math.sin(roll)
      + (vehicle.geom.front.centerLocalY - vehicle.geom.front.suspensionRestLength) * Math.cos(roll);
    const verticalExtent = vehicle.geom.wheelWidth * 0.5 * axleAlignment
      + vehicle.geom.wheelRadius * radialAlignment;
    vehicle.body.setTranslation({ x: 0, y: -centerRelativeY + verticalExtent + 0.005, z: 0 }, true);
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    let sidewallSamples = 0;
    let maxSidewallDeflection = 0;
    for (let tick = 0; tick < 240; tick++) {
      world.step();
      for (const wheel of vehicle.debugTelemetry().wheels) {
        if (wheel.contactZone !== 'sidewall') continue;
        sidewallSamples++;
        maxSidewallDeflection = Math.max(maxSidewallDeflection, wheel.carcassDeflection);
        expect(wheel.contact).toBe(false);
        expect(wheel.suspensionCompression).toBe(0);
        expect(wheel.suspensionForce).toBe(0);
        expect(wheel.driveTorque).toBe(0);
        expect(wheel.groundTorque).toBe(0);
      }
    }
    expect(sidewallSamples).toBeGreaterThan(0);
    expect(maxSidewallDeflection).toBeGreaterThan(0);
    const q = vehicle.getState().rotation;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    expect(Math.abs(upY)).toBeLessThan(0.5);
    world.dispose();
  });

  it('makes a lifted roof-loaded build less stable than stock', () => {
    const heavy = {
      ...createStockBuild('ridgeback'),
      suspensionId: 'ridgeback.suspension.flex-100',
      roofId: 'ridgeback.roof.platform-awning',
    };
    const stockAngle = staticWheelTipAngle();
    const heavyAngle = staticWheelTipAngle(heavy);
    expect(stockAngle).toBeGreaterThanOrEqual(39);
    expect(stockAngle).toBeLessThanOrEqual(44);
    expect(heavyAngle).toBeLessThanOrEqual(stockAngle - 2);
    expect(resolveVehicleSpec(heavy).centerOfMass.y)
      .toBeGreaterThan(resolveVehicleSpec(createStockBuild('ridgeback')).centerOfMass.y);
  }, 20_000);
});

describe('solid-axle vehicle: drivetrain', () => {
  it('drives only the rear axle in 2H and both axles in 4H/4L', () => {
    expect(Physics.transferCaseDriveSplit('2h')).toEqual({ front: 0, rear: 1 });
    expect(Physics.transferCaseDriveSplit('4h').front).toBeGreaterThan(0);
    expect(Physics.transferCaseDriveSplit('4l').front).toBeGreaterThan(0);
  });

  it('accepts direct 2H, 4H, and 4L transfer-case selections', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, transferCase: '2h' });
    world.step();
    expect(vehicle.drivetrainStatus().transferCase).toBe('2h');

    vehicle.setInput({ ...EMPTY_INPUT, seq: 2, transferCase: '4h' });
    world.step();
    expect(vehicle.drivetrainStatus().transferCase).toBe('4h');

    vehicle.setInput({ ...EMPTY_INPUT, seq: 3, transferCase: '4l' });
    world.step();
    expect(vehicle.drivetrainStatus().transferCase).toBe('4l');
    world.dispose();
  });

  it('keeps the Dustback rear-driven in fixed high through requests and reset', () => {
    const { world, vehicle } = makeWorld(createStockBuild('dustback-rs'));
    expect(vehicle.geom.front.hasDrive).toBe(false);
    expect(vehicle.geom.rear.hasDrive).toBe(true);
    expect(vehicle.drivetrainStatus()).toEqual({ transferCase: '2h', frontLocked: false, rearLocked: false });
    settle(world, 60);
    vehicle.setInput({
      ...EMPTY_INPUT,
      seq: 1,
      transferCase: '4l',
      buttons: BUTTON_RANGE | BUTTON_FRONT_LOCKER | BUTTON_REAR_LOCKER,
    });
    world.step();
    expect(vehicle.drivetrainStatus()).toEqual({ transferCase: '2h', frontLocked: false, rearLocked: false });
    vehicle.resetTo({ position: { x: 0, y: 1.5, z: 0 } });
    expect(vehicle.drivetrainStatus()).toEqual({ transferCase: '2h', frontLocked: false, rearLocked: false });
    world.dispose();
  });

  it('uses moderate rear-only LSD coupling without becoming a locker', () => {
    expect(resolveVehicleSpec({ ...createStockBuild('dustback-rs'), rearLocker: false }).rearDiffCoupling).toBe(0);
    const fitted = resolveVehicleSpec({ ...createStockBuild('dustback-rs'), rearLocker: true });
    expect(fitted.rearDiffCoupling).toBeGreaterThan(0);
    const [left, right] = Physics.coupleLimitedSlip(0, 10, fitted.rearDiffCoupling);
    expect(left).toBeGreaterThan(0);
    expect(right).toBeLessThan(10);
    expect(left).toBeLessThan(right);
  });

  it('ramps steering progressively instead of snapping to full lock', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);

    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, steer: 1 });
    world.step();
    const firstTick = vehicle.getState().wheels[0]!.steer;
    expect(firstTick).toBeGreaterThan(0);
    expect(firstTick).toBeLessThan(TUNING.maxSteer * 0.25);

    for (let i = 2; i <= 6; i++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: i, steer: 1 });
      world.step();
    }
    expect(vehicle.getState().wheels[0]!.steer).toBeLessThan(TUNING.maxSteer * 0.5);

    for (let i = 7; i <= 30; i++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: i, steer: 1 });
      world.step();
    }
    expect(vehicle.getState().wheels[0]!.steer).toBeCloseTo(TUNING.maxSteer, 6);
    world.dispose();
  });

  it('engages low range and installed lockers only at low speed and light throttle', () => {
    const build = { ...createStockBuild('ridgeback'), frontLocker: true, rearLocker: true };
    const { world, vehicle } = makeWorld(build);
    settle(world, 60);
    vehicle.setInput({
      ...EMPTY_INPUT,
      seq: 1,
      buttons: BUTTON_RANGE | BUTTON_FRONT_LOCKER | BUTTON_REAR_LOCKER,
    });
    world.step();
    expect(vehicle.drivetrainStatus()).toEqual({ transferCase: '4l', frontLocked: true, rearLocked: true });

    // Release the edge-triggered controls, then give the chassis road
    // speed. Both lockers must protect themselves without another input.
    vehicle.setInput({ ...EMPTY_INPUT, seq: 2 });
    vehicle.body.setLinvel({ x: 15, y: 0, z: 0 }, true);
    world.step();
    expect(vehicle.drivetrainStatus()).toEqual({ transferCase: '4l', frontLocked: false, rearLocked: false });
    expect(vehicle.consumeDrivetrainNotice()).toMatch(/safe speed/);
    world.dispose();
  });

  it('allows transfer-case and locker changes at up to 20 km/h', () => {
    const build = { ...createStockBuild('ridgeback'), frontLocker: true, rearLocker: true };
    const { world, vehicle } = makeWorld(build);
    settle(world, 60);
    vehicle.body.setLinvel({ x: 20 / 3.6, y: 0, z: 0 }, true);
    vehicle.setInput({
      ...EMPTY_INPUT,
      seq: 1,
      transferCase: '4l',
      buttons: BUTTON_FRONT_LOCKER | BUTTON_REAR_LOCKER,
    });
    world.step();
    expect(vehicle.drivetrainStatus()).toEqual({ transferCase: '4l', frontLocked: true, rearLocked: true });
    world.dispose();
  });

  it('explains unavailable lockers and rejects range changes while moving', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, buttons: BUTTON_REAR_LOCKER });
    world.step();
    expect(vehicle.drivetrainStatus().rearLocked).toBe(false);
    expect(vehicle.consumeDrivetrainNotice()).toMatch(/Fit a rear locker/);

    vehicle.setInput({ ...EMPTY_INPUT, seq: 2 });
    world.step();
    vehicle.body.setLinvel({ x: 21 / 3.6, y: 0, z: 0 }, true);
    vehicle.setInput({ ...EMPTY_INPUT, seq: 3, buttons: BUTTON_RANGE });
    world.step();
    expect(vehicle.drivetrainStatus().transferCase).toBe('4h');
    expect(vehicle.consumeDrivetrainNotice()).toMatch(/20 km\/h/);
    world.dispose();
  });

  it('drives forward when throttle is applied', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    const startZ = vehicle.getState().position.z;
    for (let i = 1; i <= 240; i++) {
      vehicle.setInput(fullThrottle(i));
      world.step();
    }
    const endZ = vehicle.getState().position.z;
    expect(endZ - startZ).toBeGreaterThan(2);
    world.dispose();
  });

  it('responds to steering with non-trivial yaw rotation', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    const startYaw = quatYaw(vehicle.getState().rotation);
    for (let i = 1; i <= 300; i++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1, steer: 1 });
      world.step();
    }
    const endYaw = quatYaw(vehicle.getState().rotation);
    expect(Math.abs(angleDiff(endYaw, startYaw))).toBeGreaterThan(0.05);
    world.dispose();
  });

  it('steers in the correct direction (positive input = right turn)', () => {
    // Regression test: a Rodrigues sign flip in solidAxleVehicle.preStep
    // would silently reverse steering. The yaw-magnitude test above
    // wouldn't catch it. Drive forward briefly with steady positive
    // steer; assert the chassis rotated the way that turns the chassis
    // nose toward chassis-right.
    //
    // This game uses chassis +Z as forward while the player's right from
    // that heading is world -X, so a right turn is negative world-Y yaw.
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    const startYaw = quatYaw(vehicle.getState().rotation);
    // Sample before the truck can complete more than half a circle: wrapped
    // start/end yaw alone cannot distinguish a long right turn from a short
    // left turn once total travel exceeds pi.
    for (let i = 1; i <= 120; i++) {
      vehicle.setInput({ ...EMPTY_INPUT, seq: i, throttle: 1, steer: 1 });
      world.step();
    }
    const endYaw = quatYaw(vehicle.getState().rotation);
    const dyaw = angleDiff(endYaw, startYaw);
    expect(dyaw).toBeLessThan(0);
    world.dispose();
  });
});

describe('solid-axle vehicle: determinism', () => {
  it('two worlds with same seed and inputs produce the same state', () => {
    const a = makeWorld();
    const b = makeWorld();
    settle(a.world, 60);
    settle(b.world, 60);
    for (let i = 1; i <= 200; i++) {
      const input: PlayerInput = {
        ...EMPTY_INPUT,
        seq: i,
        throttle: 1,
        steer: i > 60 ? 0.5 : 0,
      };
      a.vehicle.setInput(input);
      b.vehicle.setInput(input);
      a.world.step();
      b.world.step();
    }
    const sa = a.vehicle.getState();
    const sb = b.vehicle.getState();
    expect(sa.position.x).toBeCloseTo(sb.position.x, 3);
    expect(sa.position.y).toBeCloseTo(sb.position.y, 3);
    expect(sa.position.z).toBeCloseTo(sb.position.z, 3);
    a.world.dispose();
    b.world.dispose();
  });
});

describe('solid-axle vehicle: snapshot round-trip', () => {
  it('axleSnaps + applyAxleSnaps restores the axle pose', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 60);
    vehicle.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1, steer: 0.5 });
    for (let i = 0; i < 30; i++) world.step();
    const before = vehicle.axleSnaps();
    // Reset the axles to zero, then apply.
    vehicle.applyAxleSnaps([
      { rideY: 0, rollAngle: 0 },
      { rideY: 0, rollAngle: 0 },
    ]);
    expect(vehicle.axleSnaps()[0].rideY).toBe(0);
    vehicle.applyAxleSnaps(before);
    const after = vehicle.axleSnaps();
    expect(after[0].rideY).toBeCloseTo(before[0].rideY, 5);
    expect(after[0].rollAngle).toBeCloseTo(before[0].rollAngle, 5);
    expect(after[1].rideY).toBeCloseTo(before[1].rideY, 5);
    expect(after[1].rollAngle).toBeCloseTo(before[1].rollAngle, 5);
    world.dispose();
  });
});

// The debug panel's suspension sliders were writing to TUNING fields no
// physics code read, so dragging them did nothing at all. They are
// multipliers on the per-kind geom rates now; this proves the value
// actually reaches the chassis.
describe('SolidAxleVehicle: TUNING axle multipliers', () => {
  afterEach(() => {
    // TUNING is a process-wide singleton; leaking a mutation here would
    // silently skew every physics test that runs after this file.
    TUNING.axleFront.rideStiffnessMult = 1;
    TUNING.axleRear.rideStiffnessMult = 1;
  });

  /** Settle a fresh truck and report its resting chassis height. */
  function settledHeight(): number {
    const { world, vehicle } = makeWorld();
    for (let i = 0; i < 180; i++) world.step();
    const y = vehicle.getState().position.y;
    world.dispose();
    return y;
  }

  it('stiffer springs settle the chassis higher', () => {
    const baseline = settledHeight();

    TUNING.axleFront.rideStiffnessMult = 2;
    TUNING.axleRear.rideStiffnessMult = 2;
    const stiff = settledHeight();

    TUNING.axleFront.rideStiffnessMult = 0.5;
    TUNING.axleRear.rideStiffnessMult = 0.5;
    const soft = settledHeight();

    // Static compression is mg / k, so doubling k halves the sag.
    expect(stiff).toBeGreaterThan(baseline);
    expect(soft).toBeLessThan(baseline);
  });

  it('leaves the rest pose untouched at 1.0', () => {
    const a = settledHeight();
    TUNING.axleFront.rideStiffnessMult = 1;
    TUNING.axleRear.rideStiffnessMult = 1;
    expect(settledHeight()).toBeCloseTo(a, 6);
  });
});

describe('SolidAxleVehicle: live tire budget tuning', () => {
  it('scales the transmitted grip coefficient', () => {
    const saved = TUNING.tireLongGripMult;
    const coefficientAt = (mult: number): number => {
      TUNING.tireLongGripMult = mult;
      const { world, vehicle } = makeWorld();
      settle(world, 90);
      const wheel = vehicle.debugTelemetry().wheels.find((entry) => entry.contact);
      world.dispose();
      if (!wheel) throw new Error('settled vehicle had no tire contact');
      return wheel.gripCoefficient;
    };
    try {
      const baseline = coefficientAt(1);
      expect(coefficientAt(0.5)).toBeCloseTo(baseline * 0.5, 5);
    } finally {
      TUNING.tireLongGripMult = saved;
    }
  });

  it('changes the settled physical carcass deflection', () => {
    const saved = TUNING.tireCarcassComplianceMult;
    const deflectionAt = (mult: number): number => {
      TUNING.tireCarcassComplianceMult = mult;
      const { world, vehicle } = makeWorld();
      settle(world, 120);
      const loaded = vehicle.debugTelemetry().wheels.filter((wheel) => wheel.contact);
      world.dispose();
      if (loaded.length === 0) throw new Error('settled vehicle had no tire contact');
      return loaded.reduce((sum, wheel) => sum + wheel.carcassDeflection, 0) / loaded.length;
    };
    try {
      const firm = deflectionAt(0.5);
      const soft = deflectionAt(2);
      expect(soft).toBeGreaterThan(firm * 1.5);
    } finally {
      TUNING.tireCarcassComplianceMult = saved;
    }
  });
});

describe('SolidAxleVehicle: low-speed lateral settling', () => {
  it('damps a sideways creep without entering a full-grip force limit cycle', () => {
    const { world, vehicle } = makeWorld();
    settle(world, 90);
    vehicle.body.setLinvel({ x: 0.45, y: 0, z: 0.5 }, true);

    const tailLateralG: number[] = [];
    const tailGrip: number[] = [];
    for (let tick = 0; tick < 180; tick++) {
      world.step();
      if (tick < 60) continue;
      const debug = vehicle.debugTelemetry();
      tailLateralG.push(Math.abs(debug.lateralG));
      tailGrip.push(Math.max(...debug.wheels.map((wheel) => wheel.utilization)));
    }

    const peakTailG = Math.max(...tailLateralG);
    const saturatedTailTicks = tailGrip.filter((grip) => grip > 0.99).length;
    expect(peakTailG).toBeLessThan(0.15);
    expect(saturatedTailTicks).toBe(0);
    expect(Math.abs(vehicle.getState().linVel.x)).toBeLessThan(0.05);
    world.dispose();
  });
});

function quatYaw(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
