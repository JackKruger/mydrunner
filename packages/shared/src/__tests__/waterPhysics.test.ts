// Water forces against the real Rapier world, per the repo's "tests use
// real components" rule. A mocked physics world would happily confirm a
// buoyancy term with the wrong sign.

import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_INPUT } from '../types.js';
import { WATER } from '../constants.js';
import { TUNING } from '../tuning.js';
import { SolidAxleVehicle } from '../physics/solidAxleVehicle.js';
import {
  Surface, dryWater, mountainFor, petrolStationPadFor,
  type TerrainData,
} from '../physics/terrain.js';
import { World, initRapier } from '../physics/world.js';
import type { CarKind, VehicleBuild } from '../types.js';
import { createStockBuild } from '../vehicleBuild.js';
import { geomFor } from '../physics/vehicleGeom.js';
import { computeWaterLoad, createWaterLoad, createWaterState } from '../physics/water.js';

beforeAll(async () => {
  await initRapier();
});

const SIZE = 200;
const RES = 32;

interface PondOptions {
  /** Absolute water-surface Y. Omit for no water. */
  level?: number;
  /** Bed height. Default 0. */
  bed?: number;
  /** Flow velocity in m/s. */
  flowX?: number;
  flowZ?: number;
}

function pondWorld(opts: PondOptions = {}): World {
  const bed = opts.bed ?? 0;
  const terrain: TerrainData = {
    size: SIZE,
    resolution: RES,
    heights: new Float32Array(RES * RES).fill(bed),
    surfaces: new Uint8Array(RES * RES).fill(Surface.Dirt),
    seed: 0,
    mountain: mountainFor(SIZE),
    petrolStation: petrolStationPadFor(SIZE),
    ...dryWater(RES),
    bogs: [],
    roads: [],
  };
  if (opts.level !== undefined) {
    terrain.waterLevel.fill(opts.level);
    terrain.waterFlowX.fill(opts.flowX ?? 0);
    terrain.waterFlowZ.fill(opts.flowZ ?? 0);
  }
  return new World({ terrain });
}

function spawn(world: World, kind: CarKind | VehicleBuild = 'ridgeback', y = 1.2): SolidAxleVehicle {
  const v = new SolidAxleVehicle(world, 'p', { position: { x: 0, y, z: 0 } }, kind);
  world.vehicles.set(v.id, v);
  return v;
}

/** Advance with no player input. */
function coast(world: World, ticks: number, v?: SolidAxleVehicle): void {
  for (let i = 0; i < ticks; i++) {
    if (v) v.setInput({ ...EMPTY_INPUT, seq: i + 1 });
    world.step();
  }
}

describe('still water', () => {
  it('does not push a parked truck anywhere', () => {
    // The sign-error canary: a drag term taken against absolute velocity
    // rather than velocity-relative-to-water would turn every pond into
    // a conveyor belt, and a flipped sign would accelerate the truck.
    const world = pondWorld({ level: 0.5, bed: 0 });
    const v = spawn(world);
    coast(world, 300, v);
    const s = v.getState();
    expect(Math.hypot(s.position.x, s.position.z)).toBeLessThan(0.5);
    expect(Math.hypot(s.linVel.x, s.linVel.z)).toBeLessThan(0.3);
    world.dispose();
  });

  it('settles rather than bobbing', () => {
    // A buoyant box with no vertical damping oscillates forever. This is
    // the assertion that the damping terms are actually doing work.
    const world = pondWorld({ level: 0.8, bed: -1.5 });
    const v = spawn(world, 'patrol', 1.0);
    coast(world, 240, v);
    let peak = 0;
    for (let i = 0; i < 180; i++) {
      v.setInput({ ...EMPTY_INPUT, seq: 300 + i });
      world.step();
      peak = Math.max(peak, Math.abs(v.getState().linVel.y));
    }
    expect(peak).toBeLessThan(0.6);
    world.dispose();
  });
});

describe('buoyancy', () => {
  it('unloads the suspension when the hull is in the water', () => {
    // Grip loss in water is not applied to the springs by hand: the
    // suspension force IS the tyre normal load, so a chassis being
    // lifted loses grip automatically. This checks the lift is real.
    const dry = pondWorld();
    const dryV = spawn(dry);
    coast(dry, 180, dryV);
    const dryRide = dryV.axleSnaps()[0]!.rideY;
    dry.dispose();

    const wet = pondWorld({ level: 0.9, bed: 0 });
    const wetV = spawn(wet);
    coast(wet, 180, wetV);
    const wetRide = wetV.axleSnaps()[0]!.rideY;
    wet.dispose();

    // Less spring compression under water means a smaller compression DOF.
    expect(wetRide).toBeLessThan(dryRide);
  });

  it('lifts a fully submerged truck back toward the surface', () => {
    const world = pondWorld({ level: 2.5, bed: -6 });
    const v = spawn(world, 'patrol', -4);
    const startY = v.getState().position.y;
    coast(world, 240, v);
    expect(v.getState().position.y).toBeGreaterThan(startY + 1);
    world.dispose();
  });

  it('eventually swamps and settles instead of floating forever', () => {
    const world = pondWorld({ level: 2.5, bed: -6 });
    const ridgeback = createStockBuild('ridgeback');
    ridgeback.snorkelId = 'ridgeback.snorkel.fitted';
    const v = spawn(world, ridgeback, 0);
    coast(world, 120, v);
    const floating = v.getState().position.y;
    // Long enough for floodFrac to saturate (WATER.swampSeconds).
    coast(world, 60 * (WATER.swampSeconds + 4), v);
    const swamped = v.getState().position.y;
    expect(swamped).toBeLessThan(floating);
    expect(v.waterStatus().flood).toBeGreaterThan(0.9);
    world.dispose();
  });

  it('drains the flooding back out once clear of the water', () => {
    const world = pondWorld({ level: 2.5, bed: -6 });
    const v = spawn(world, 'patrol', 0);
    coast(world, 600, v);
    expect(v.waterStatus().flood).toBeGreaterThan(0.4);
    // Lift it clear and let it drain.
    v.body.setTranslation({ x: 0, y: 40, z: 0 }, true);
    world.terrain.waterLevel.fill(-1e9);
    coast(world, 60 * (WATER.drainSeconds + 2), v);
    expect(v.waterStatus().flood).toBe(0);
    world.dispose();
  });
});

describe('current', () => {
  it('carries a floating truck downstream', () => {
    const world = pondWorld({ level: 2.2, bed: -5, flowX: 2.5 });
    const v = spawn(world, 'patrol', 0.5);
    coast(world, 300, v);
    const s = v.getState();
    expect(s.position.x).toBeGreaterThan(3);
    expect(s.linVel.x).toBeGreaterThan(0.5);
    world.dispose();
  });

  it('converges toward the flow speed rather than past it', () => {
    // Drag against relative velocity has the flow speed as its fixed
    // point. An additive current force would keep accelerating instead.
    const flow = 2.0;
    const world = pondWorld({ level: 2.2, bed: -5, flowX: flow });
    const v = spawn(world, 'patrol', 0.5);
    coast(world, 900, v);
    expect(v.getState().linVel.x).toBeLessThan(flow + 0.5);
    world.dispose();
  });

  it('pushes sideways harder than it pushes lengthways', () => {
    // The lateral/longitudinal drag split is what makes angling upstream
    // a technique. Same flow speed, truck facing along +z either way:
    // a +x flow hits the flank, a +z flow hits the nose.
    const across = pondWorld({ level: 2.2, bed: -5, flowX: 2.5 });
    const av = spawn(across, 'patrol', 0.5);
    coast(across, 120, av);
    const lateralSpeed = Math.abs(av.getState().linVel.x);
    across.dispose();

    const along = pondWorld({ level: 2.2, bed: -5, flowZ: 2.5 });
    const lv = spawn(along, 'patrol', 0.5);
    coast(along, 120, lv);
    const longSpeed = Math.abs(lv.getState().linVel.z);
    along.dispose();

    expect(lateralSpeed).toBeGreaterThan(longSpeed);
  });

  it('leaves a truck on dry land alone', () => {
    const world = pondWorld({ level: -3, bed: 0, flowX: 4 });
    const v = spawn(world);
    coast(world, 240, v);
    expect(Math.abs(v.getState().position.x)).toBeLessThan(0.5);
    world.dispose();
  });
});

describe('wheel grip in water', () => {
  it('reports the depth over each wheel', () => {
    const world = pondWorld({ level: 0.35, bed: 0 });
    const v = spawn(world);
    coast(world, 120, v);
    for (const d of v.waterStatus().wheelDepths) {
      expect(d).toBeCloseTo(0.35, 2);
    }
    world.dispose();
  });

  it('is zero on a map with no water', () => {
    const world = pondWorld();
    const v = spawn(world);
    coast(world, 60, v);
    const st = v.waterStatus();
    expect(st.submerged).toBe(0);
    expect(st.drowned).toBe(false);
    expect(st.wheelDepths.every((d) => d === 0)).toBe(true);
    world.dispose();
  });

  it('accelerates worse through water than on the same dry bed', () => {
    const run = (level?: number): number => {
      const world = pondWorld(level === undefined ? {} : { level, bed: 0 });
      const v = spawn(world);
      coast(world, 60, v);
      v.body.setTranslation({ x: 0, y: v.getState().position.y, z: 0 }, true);
      for (let i = 0; i < 180; i++) {
        v.setInput({ ...EMPTY_INPUT, seq: 100 + i, throttle: 1 });
        world.step();
      }
      const z = v.getState().position.z;
      world.dispose();
      return z;
    };
    expect(run(0.5)).toBeLessThan(run());
  });
});

describe('swamping is driven by hull submersion, not the air intake', () => {
  it('barely floods the hull during an ordinary ford', () => {
    // The regression this pins: gating flooding on the intake made a
    // shallow crossing flood at exactly the same rate as a full
    // submersion (both zero, until the intake dipped). Scaling by hull
    // submersion is what makes a ford a ford.
    const world = pondWorld({ level: 0.4, bed: 0 });
    const v = spawn(world);
    coast(world, 60 * 8, v);
    const st = v.waterStatus();
    expect(st.intakeSubmerged).toBe(false);
    expect(st.flood).toBeLessThan(0.15);
    world.dispose();
  });

  it('floods a floating truck whose snorkel is still clear', () => {
    // A Patrol floats with its intake above the waterline - correctly,
    // that is what a snorkel is for - so intake-gated flooding meant it
    // drifted forever. Water still gets in through everything else.
    const world = pondWorld({ level: 2.5, bed: -6 });
    const ridgeback = createStockBuild('ridgeback');
    const snorkelled = { ...ridgeback, snorkelId: 'ridgeback.snorkel.fitted' };
    const v = spawn(world, snorkelled, 0);
    coast(world, 200, v);
    const st = v.waterStatus();
    expect(st.intakeSubmerged).toBe(false);
    expect(st.submerged).toBeGreaterThan(0.5);
    expect(st.flood).toBeGreaterThan(0.05);
    world.dispose();
  });
});

describe('TUNING multipliers are actually read', () => {
  // The repo has a standing failure mode of TUNING fields nothing reads
  // (see the note in solidAxleVehicle.test.ts). Each of these asserts
  // the reader responds, not merely that the field exists.
  const withTuning = <T>(patch: Partial<typeof TUNING>, fn: () => T): T => {
    const saved = { ...TUNING };
    Object.assign(TUNING, patch);
    try {
      return fn();
    } finally {
      Object.assign(TUNING, saved);
    }
  };

  it('waterBuoyancy scales the lift', () => {
    const floatY = (mult: number): number =>
      withTuning({ waterBuoyancy: mult }, () => {
        const world = pondWorld({ level: 2.5, bed: -6 });
        const v = spawn(world, 'patrol', 0);
        coast(world, 180, v);
        const y = v.getState().position.y;
        world.dispose();
        return y;
      });
    expect(floatY(1)).toBeGreaterThan(floatY(0) + 1);
  });

  it('waterFlowScale scales the current', () => {
    const drift = (mult: number): number =>
      withTuning({ waterFlowScale: mult }, () => {
        const world = pondWorld({ level: 2.2, bed: -5, flowX: 2.5 });
        const v = spawn(world, 'patrol', 0.5);
        coast(world, 240, v);
        const x = v.getState().position.x;
        world.dispose();
        return x;
      });
    expect(drift(1)).toBeGreaterThan(drift(0) + 2);
  });

  it('waterDrag scales the resistance', () => {
    const drift = (mult: number): number =>
      withTuning({ waterDrag: mult }, () => {
        const world = pondWorld({ level: 2.2, bed: -5, flowX: 2.5 });
        const v = spawn(world, 'patrol', 0.5);
        coast(world, 120, v);
        const x = v.getState().position.x;
        world.dispose();
        return x;
      });
    // More drag against the flow means the current grabs harder, so the
    // truck is carried further in the same time.
    expect(drift(2)).toBeGreaterThan(drift(0.25));
  });
});

describe('resetTo', () => {
  it('clears accumulated flooding', () => {
    const world = pondWorld({ level: 2.5, bed: -6 });
    const v = spawn(world, 'patrol', 0);
    coast(world, 600, v);
    expect(v.waterStatus().flood).toBeGreaterThan(0);
    v.resetTo({ position: { x: 0, y: 30, z: 0 } });
    expect(v.waterStatus().flood).toBe(0);
    world.dispose();
  });
});

// `phaseWater` carries the @hotloop mark, but hotLoopAllocation.test.ts is an
// AST guard over the marked body's own syntax — it cannot see into
// computeWaterLoad or the sampling helpers underneath it. That is exactly
// where the allocations were: a rebuilt corner table per level sample (nine a
// tick), a grid-coordinate object per sample, and seven local->world rotations
// through the allocating rotateVecByQuat. This measures the real thing instead.
describe('water force path allocation', () => {
  it('computes a submerged load without allocating', () => {
    const terrain = pondWorld({ level: 3 }).terrain;
    const geom = geomFor(createStockBuild('ridgeback'));
    const state = createWaterState();
    const load = createWaterLoad();
    const pose = {
      t: { x: 0, y: 1.2, z: 0 },
      r: { x: 0, y: 0, z: 0, w: 1 },
      lv: { x: 1.5, y: -0.2, z: 0.4 },
      av: { x: 0.05, y: 0.1, z: 0.02 },
    };

    // Warm up so JIT and lazy allocations are not counted as steady state.
    for (let i = 0; i < 5_000; i++) computeWaterLoad(terrain, geom, state, pose, 1 / 60, load);
    expect(load.submergedFrac).toBeGreaterThan(0);

    const iterations = 50_000;
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < iterations; i++) computeWaterLoad(terrain, geom, state, pose, 1 / 60, load);
    const perCall = (process.memoryUsage().heapUsed - before) / iterations;

    // A steady-state allocation-free loop lands near zero; GC running mid-run
    // can even make it negative. The pre-fix path allocated ~35 objects a
    // call, so anything under a couple of bytes proves the slots are reused.
    expect(perCall).toBeLessThan(2);
  });
});
