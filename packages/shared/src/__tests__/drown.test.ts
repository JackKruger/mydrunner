// Engine drowning and the manual restart.
//
// The per-kind assertion is the load-bearing one: if a Patrol and a bike
// drown at the same depth, airIntakeY is not being read and the snorkel
// on the Patrol mesh is decoration.

import { beforeAll, describe, expect, it } from 'vitest';
import { BUTTON_STARTER, EMPTY_INPUT, type CarKind, type VehicleBuild } from '../types.js';
import { createStockBuild } from '../vehicleBuild.js';
import { ENGINE, WATER } from '../constants.js';
import {
  createEngineState, stepEngine, stepEngineFlooding,
} from '../physics/engine.js';
import { SolidAxleVehicle } from '../physics/solidAxleVehicle.js';
import {
  Surface, dryWater, mountainFor, petrolStationPadFor, type TerrainData,
} from '../physics/terrain.js';
import { geomFor } from '../physics/vehicleGeom.js';
import { World, initRapier } from '../physics/world.js';

beforeAll(async () => {
  await initRapier();
});

const SIZE = 200;
const RES = 32;

function floodedWorld(level: number): World {
  const terrain: TerrainData = {
    size: SIZE,
    resolution: RES,
    heights: new Float32Array(RES * RES),
    surfaces: new Uint8Array(RES * RES).fill(Surface.Dirt),
    seed: 0,
    mountain: mountainFor(SIZE),
    petrolStation: petrolStationPadFor(SIZE),
    ...dryWater(RES),
    bogs: [],
    roads: [],
  };
  terrain.waterLevel.fill(level);
  return new World({ terrain });
}

function run(world: World, kind: CarKind | VehicleBuild, ticks: number, buttons = 0): SolidAxleVehicle {
  const v = new SolidAxleVehicle(world, 'p', { position: { x: 0, y: 1.0, z: 0 } }, kind);
  world.vehicles.set(v.id, v);
  for (let i = 0; i < ticks; i++) {
    v.setInput({ ...EMPTY_INPUT, seq: i + 1, buttons });
    world.step();
  }
  return v;
}

/** World-space Y of a kind's air intake with the truck parked on flat
 *  dry ground.
 *
 *  Measured rather than assumed: airIntakeY is chassis-local, so the
 *  water level that floods it is the resting chassis height plus the
 *  offset. Hardcoding a level from the offset alone tests nothing —
 *  every kind's intake would sit half a metre higher than the number
 *  used, and nothing would ever drown. */
function intakeWorldY(kind: CarKind | VehicleBuild): number {
  const world = floodedWorld(-1e9);
  const v = run(world, kind, 180);
  const y = v.getState().position.y + geomFor(kind).airIntakeY;
  world.dispose();
  return y;
}

describe('the air intake decides who drowns', () => {
  it('orders the five factory intakes by vehicle role', () => {
    // The data that makes the rest of this file mean anything.
    expect(geomFor('longreach').airIntakeY).toBeGreaterThan(geomFor('overlander').airIntakeY);
    expect(geomFor('overlander').airIntakeY).toBeGreaterThan(geomFor('ridgeback').airIntakeY);
    expect(geomFor('ridgeback').airIntakeY).toBeGreaterThan(geomFor('stockman-dual').airIntakeY);
    expect(geomFor('stockman-dual').airIntakeY).toBeGreaterThan(geomFor('stockman-single').airIntakeY);
  });

  it('makes a fitted snorkel raise the real flooding point', () => {
    const factory = createStockBuild('ridgeback');
    const snorkelled = { ...factory, snorkelId: 'ridgeback.snorkel.fitted' };
    const level = (intakeWorldY(factory) + intakeWorldY(snorkelled)) / 2;

    const wet = floodedWorld(level);
    expect(run(wet, factory, WATER.drownTicks + 40).waterStatus().drowned).toBe(true);
    wet.dispose();

    const wet2 = floodedWorld(level);
    expect(run(wet2, snorkelled, WATER.drownTicks + 40).waterStatus().drowned).toBe(false);
    wet2.dispose();
  });

  it('lets the expedition Longreach survive water that drowns the work ute', () => {
    const level = (intakeWorldY('longreach') + intakeWorldY('stockman-single')) / 2;

    const a = floodedWorld(level);
    expect(run(a, 'stockman-single', WATER.drownTicks + 40).waterStatus().drowned).toBe(true);
    a.dispose();

    const b = floodedWorld(level);
    expect(run(b, 'longreach', WATER.drownTicks + 40).waterStatus().drowned).toBe(false);
    b.dispose();
  });

  it('survives a brief dip shorter than drownTicks', () => {
    // A splash cresting the bonnet must not kill the engine.
    const world = floodedWorld(3);
    const v = run(world, 'patrol', WATER.drownTicks - 5);
    expect(v.waterStatus().drowned).toBe(false);
    world.dispose();
  });

  it('makes no torque once drowned', () => {
    const world = floodedWorld(3);
    const v = run(world, 'patrol', WATER.drownTicks + 20);
    expect(v.waterStatus().drowned).toBe(true);
    // Full throttle from a standstill, deep under.
    const before = v.getState().position.z;
    for (let i = 0; i < 120; i++) {
      v.setInput({ ...EMPTY_INPUT, seq: 500 + i, throttle: 1 });
      world.step();
    }
    expect(Math.abs(v.getState().position.z - before)).toBeLessThan(1.5);
    expect(v.getState().rpm).toBeLessThan(50);
    expect(v.getState().gear).toBe(0);
    world.dispose();
  });
});

describe('the starter', () => {
  // Unit-level, against the state machine directly: the depth geometry
  // is covered above, and this is about who is allowed to crank.
  it('does nothing while the intake is still under', () => {
    const e = createEngineState();
    stepEngineFlooding(e, true, true, false);
    expect(e.drowned).toBe(true);
    for (let i = 0; i < WATER.crankTicks * 3; i++) {
      stepEngineFlooding(e, true, false, true);
    }
    expect(e.drowned).toBe(true);
    expect(e.crankTicks).toBe(0);
  });

  it('catches after crankTicks of holding with the intake clear', () => {
    const e = createEngineState();
    stepEngineFlooding(e, true, true, false);
    for (let i = 0; i < WATER.crankTicks - 1; i++) {
      stepEngineFlooding(e, false, false, true);
    }
    expect(e.drowned).toBe(true);
    stepEngineFlooding(e, false, false, true);
    expect(e.drowned).toBe(false);
    expect(e.rpm).toBe(ENGINE.idleRpm);
  });

  it('resets the crank if the player lets go', () => {
    const e = createEngineState();
    stepEngineFlooding(e, true, true, false);
    for (let i = 0; i < WATER.crankTicks - 1; i++) {
      stepEngineFlooding(e, false, false, true);
    }
    stepEngineFlooding(e, false, false, false);
    expect(e.crankTicks).toBe(0);
    expect(e.drowned).toBe(true);
  });

  it('does not fire while the engine is healthy', () => {
    const e = createEngineState();
    stepEngineFlooding(e, false, false, true);
    expect(e.drowned).toBe(false);
    expect(e.crankTicks).toBe(0);
  });
});

describe('recovery end to end', () => {
  it('restarts once the truck is out of the water and the starter is held', () => {
    const world = floodedWorld(3);
    const v = run(world, 'patrol', WATER.drownTicks + 20);
    expect(v.waterStatus().drowned).toBe(true);

    // Drain the river out from under it, then crank.
    world.terrain.waterLevel.fill(-1e9);
    for (let i = 0; i < WATER.crankTicks + 20; i++) {
      v.setInput({ ...EMPTY_INPUT, seq: 900 + i, buttons: BUTTON_STARTER });
      world.step();
    }
    expect(v.waterStatus().drowned).toBe(false);

    // And it drives again.
    const before = v.getState().position.z;
    for (let i = 0; i < 120; i++) {
      v.setInput({ ...EMPTY_INPUT, seq: 1200 + i, throttle: 1 });
      world.step();
    }
    expect(v.getState().position.z).toBeGreaterThan(before + 2);
    world.dispose();
  });

  it('stays dead if the player never cranks', () => {
    const world = floodedWorld(3);
    const v = run(world, 'patrol', WATER.drownTicks + 20);
    world.terrain.waterLevel.fill(-1e9);
    for (let i = 0; i < 300; i++) {
      v.setInput({ ...EMPTY_INPUT, seq: 900 + i, throttle: 1 });
      world.step();
    }
    expect(v.waterStatus().drowned).toBe(true);
    world.dispose();
  });

  it('is cleared by a reset', () => {
    const world = floodedWorld(3);
    const v = run(world, 'patrol', WATER.drownTicks + 20);
    expect(v.waterStatus().drowned).toBe(true);
    v.resetTo({ position: { x: 0, y: 30, z: 0 } });
    expect(v.waterStatus().drowned).toBe(false);
    world.dispose();
  });
});

describe('a healthy engine is untouched', () => {
  it('still makes torque with no water anywhere', () => {
    const e = createEngineState();
    const out = stepEngine(e, 10, 10, 1, 1 / 60);
    expect(out.wheelForce).toBeGreaterThan(0);
    expect(out.rpm).toBeGreaterThanOrEqual(ENGINE.idleRpm);
  });
});
