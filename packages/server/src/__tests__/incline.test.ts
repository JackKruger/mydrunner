// Incline and hill-climb tests. Verifies that the vehicle makes meaningful
// forward progress on sloped terrain, and that steeper grades produce less
// progress than shallower ones (traction is correctly grade-dependent).

import { describe, it, expect, beforeAll } from 'vitest';
import {
  BUTTON_FRONT_LOCKER,
  BUTTON_REAR_LOCKER,
  Physics,
  EMPTY_INPUT,
  createStockBuild,
} from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

const FIXED_DT = 1 / 60;

function simSteps(world: Physics.World, steps: number): void {
  for (let i = 0; i < steps; i++) world.step();
}

/**
 * Build a world whose terrain is a linear slope in the +z direction.
 * height(x, z) = z * grade.  The vehicle spawns at z=0 where height=0,
 * then drives into increasing elevation by moving toward +z.
 *
 * @param grade  rise/run (0.15 = 15 % grade).
 * @param surface  Physics.Surface value to fill the terrain with.
 */
function makeSlopedWorld(grade: number, surface: number): Physics.World {
  const n = 32;
  const size = 100;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(surface);

  // height at row r corresponds to world z = (r/(n-1) - 0.5)*size.
  // We want height = z * grade, so:
  //   height[r] = ((r/(n-1)) - 0.5) * size * grade
  for (let r = 0; r < n; r++) {
    const z = (r / (n - 1) - 0.5) * size;
    const h = z * grade;
    for (let c = 0; c < n; c++) {
      heights[r * n + c] = h;
    }
  }

  return new Physics.World({
    terrain: {
      size,
      resolution: n,
      heights,
      surfaces,
      seed: 0,
      mountain: Physics.mountainFor(size),
      petrolStation: Physics.petrolStationPadFor(size),
      ...Physics.dryWater(n),
      bogs: [],
      roads: [],
    },
  });
}

describe('incline traction', () => {
  it('vehicle makes forward progress on a 15 % gravel slope', () => {
    const world = makeSlopedWorld(0.15, Physics.Surface.Gravel);
    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });

    simSteps(world, 60); // settle at z=0 (height=0)
    const z0 = v.getState().position.z;

    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    simSteps(world, 5 * 60); // 5 seconds

    const dz = v.getState().position.z - z0;
    expect(dz, `forward progress on 15% slope = ${dz.toFixed(2)} m`).toBeGreaterThan(5);
    world.dispose();
  });

  it('steeper grade produces less forward progress than a shallower grade', () => {
    const DRIVE_STEPS = 5 * 60;

    function progressOn(grade: number): number {
      const world = makeSlopedWorld(grade, Physics.Surface.Gravel);
      const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
      simSteps(world, 60);
      const z0 = v.getState().position.z;
      v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
      simSteps(world, DRIVE_STEPS);
      const dz = v.getState().position.z - z0;
      world.dispose();
      return dz;
    }

    // This compares two synthetic planes as a physical grade measurement;
    // the production mountain route is intentionally not an acceptance rig.
    const moderate = progressOn(0.20);
    const veryHard = progressOn(0.60);
    expect(veryHard, `moderate (0.20) > very-hard (0.60): ${moderate.toFixed(2)} vs ${veryHard.toFixed(2)}`)
      .toBeLessThan(moderate - 1);
  });

  it('vehicle gains elevation as it climbs a slope', () => {
    // Confirms the vehicle is actually going UP, not just sliding sideways.
    const world = makeSlopedWorld(0.15, Physics.Surface.Gravel);
    const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });

    simSteps(world, 60);
    const y0 = v.getState().position.y;

    v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
    simSteps(world, 5 * 60);

    const y1 = v.getState().position.y;
    // Vehicle moved forward on a rising slope, so its world-y should be higher.
    expect(y1, `elevation after climb: y0=${y0.toFixed(2)} y1=${y1.toFixed(2)}`).toBeGreaterThan(y0 + 0.5);
    world.dispose();
  });

  it('lets a prepared locked crawler climb a 60 % dirt grade under controlled throttle', () => {
    const world = makeSlopedWorld(0.60, Physics.Surface.Dirt);
    const build = {
      ...createStockBuild('outclaw'),
      suspensionId: 'outclaw.suspension.flex-100',
      axleId: 'outclaw.axle.portal-240',
      tireId: 'outclaw.tire.xt-40-wide',
      wheelId: 'outclaw.wheel.beadlock-alloy',
      frontLocker: true,
      rearLocker: true,
    };
    const vehicle = world.spawnVehicle(
      'crawler',
      { position: { x: 0, y: 1.8, z: 0 } },
      build,
    );
    const pitch = -Math.atan(0.60);
    vehicle.body.setRotation({ x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) }, true);
    vehicle.setInput({
      ...EMPTY_INPUT,
      seq: 1,
      transferCase: '4l',
      buttons: BUTTON_FRONT_LOCKER | BUTTON_REAR_LOCKER,
    });
    world.step();
    vehicle.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    simSteps(world, 120);
    expect(vehicle.drivetrainStatus?.()).toMatchObject({ transferCase: '4l', frontLocked: true, rearLocked: true });
    const start = vehicle.getState().position;
    vehicle.setInput({ ...EMPTY_INPUT, seq: 3, throttle: 0.35 });
    simSteps(world, 10 * 60);
    const end = vehicle.getState().position;
    expect(end.z - start.z).toBeGreaterThan(2);
    expect(end.y - start.y).toBeGreaterThan(1);
    world.dispose();
  });
});
