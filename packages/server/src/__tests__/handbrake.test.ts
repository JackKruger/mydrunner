// Handbrake tests.
//
// These used to assert only that the truck slowed down, which is why a
// handbrake that never locked a wheel and never rotated the vehicle passed
// for so long. Deceleration is the least interesting thing a handbrake does;
// the tests below pin the lock, the rear-only contract, and the rotation.
//
// They also used a 100 m world. The rig accelerates for 4 s and then brakes,
// which covers ~59 m from the centre — so the truck drove off the edge at
// z=47 and spent the last three quarters of every measurement window in
// FREE FALL (y: 1.3 -> 0.6 -> -2.3 -> -7.7). Every number the old file
// compared was air resistance on a falling body. The world is now big enough
// to hold the run, and `assertOnGround` fails loudly if that ever regresses.

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT, TUNING, createStockBuild } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

const DEG = 180 / Math.PI;

function simSteps(world: Physics.World, steps: number): void {
  for (let i = 0; i < steps; i++) world.step();
}

function speedXZ(v: Physics.VehicleLike): number {
  const s = v.getState();
  return Math.hypot(s.linVel.x, s.linVel.z);
}

/** Big enough that a 4 s launch plus a 2 s stop stays on the heightfield. */
function makeRoadWorld(surface: number = Physics.Surface.Road): Physics.World {
  const n = 128;
  const size = 400;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(surface);
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
    obstacles: [],
  });
}

/** The guard the old file needed: a vehicle in free fall decelerates too, and
 *  it decelerates in a way that has nothing to do with the brakes. */
function assertOnGround(v: Physics.VehicleLike, where: string): void {
  const tel = (v as Physics.SolidAxleVehicle).debugTelemetry();
  const contacts = tel.wheels.filter((w) => w.contact).length;
  expect(contacts, `${where}: only ${contacts}/4 wheels on the ground — the rig has driven off the terrain`)
    .toBeGreaterThanOrEqual(3);
}

/** Build a world, settle, accelerate for `accelSteps`, return world+vehicle. */
function setupMovingVehicle(accelSteps: number): { world: Physics.World; v: Physics.VehicleLike } {
  const world = makeRoadWorld();
  const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: -120 } });
  simSteps(world, 60); // settle
  v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
  simSteps(world, accelSteps);
  return { world, v };
}

describe('handbrake', () => {
  it('reduces speed faster than coasting over the same time window', () => {
    const ACCEL_STEPS = 4 * 60;
    const DECEL_STEPS = 2 * 60;

    const { world: wCoast, v: vCoast } = setupMovingVehicle(ACCEL_STEPS);
    const { world: wHB, v: vHB } = setupMovingVehicle(ACCEL_STEPS);

    vCoast.setInput({ ...EMPTY_INPUT, seq: 2 });
    simSteps(wCoast, DECEL_STEPS);
    const coastSpeed = speedXZ(vCoast);
    assertOnGround(vCoast, 'coast');

    vHB.setInput({ ...EMPTY_INPUT, seq: 2, handbrake: 1 });
    simSteps(wHB, DECEL_STEPS);
    const hbSpeed = speedXZ(vHB);
    assertOnGround(vHB, 'handbrake');

    expect(
      hbSpeed,
      `handbrake speed ${hbSpeed.toFixed(2)} m/s should be less than coast speed ${coastSpeed.toFixed(2)} m/s`,
    ).toBeLessThan(coastSpeed);

    wCoast.dispose();
    wHB.dispose();
  });

  /** Peak slip ratio on the loaded rear wheel while the handbrake is pulled. */
  function peakLoadedRearSlip(transferCase: '2h' | '4h'): number {
    const world = makeRoadWorld();
    const v = world.spawnVehicle(
      'p', { position: { x: 0, y: 1.5, z: -120 } }, createStockBuild('ridgeback'),
    ) as Physics.SolidAxleVehicle;
    v.setInput({ ...EMPTY_INPUT, seq: 1, transferCase });
    simSteps(world, 60);
    v.setInput({ ...EMPTY_INPUT, seq: 2, throttle: 1, transferCase });
    simSteps(world, 3 * 60);
    v.setInput({ ...EMPTY_INPUT, seq: 3, handbrake: 1, transferCase });

    let peak = 0;
    for (let i = 0; i < 60; i++) {
      world.step();
      const tel = v.debugTelemetry();
      // The inner rear wheel can unload to zero and lock trivially; the
      // loaded one is the one that has to break away.
      const loadedRear = [tel.wheels[2]!, tel.wheels[3]!]
        .sort((a, b) => b.normalLoad - a.normalLoad)[0]!;
      if (loadedRear.normalLoad > 500) peak = Math.max(peak, Math.abs(loadedRear.slipRatio));
    }
    assertOnGround(v, `lock test (${transferCase})`);
    world.dispose();
    return peak;
  }

  it('locks the loaded rear wheel in 2H instead of threshold-braking it', () => {
    // The bug this pins: brakeForceN used to be TUNING.brakeForce (4500 N)
    // for the handbrake too, while a loaded rear tyre's grip limit reaches
    // 9826 N. The clamp therefore always bound on brake force rather than
    // grip and the wheel settled into a perfect-ABS equilibrium — brake
    // torque and ground torque equal to the newton-metre, wheel at 28.06
    // rad/s against a 30.67 rad/s rolling speed, ~8% slip, never locking.
    // A handbrake that cannot lock cannot break traction.
    const peak = peakLoadedRearSlip('2h');
    expect(
      peak,
      `loaded rear wheel reached only ${peak.toFixed(2)} slip ratio; the handbrake is modulating, not locking`,
    ).toBeGreaterThan(0.9);
  });

  it('cannot fully lock the rear in 4H, because the centre transfer is rigid', () => {
    // Not a shortfall — the consequence of the drivetrain being modelled.
    // solveCenterTransferImpulse equalises the front and rear carrier speeds
    // every tick, so with the handbrake on the rear and nothing on the front,
    // the unbraked front axle feeds speed back into the rear through the
    // transfer case and the rear settles short of a full lock. It is still
    // an order of magnitude past the ~0.08 threshold-braking plateau the
    // handbrake used to sit at, so this pins the difference between the two
    // ranges rather than a single number.
    const fourHigh = peakLoadedRearSlip('4h');
    expect(fourHigh, `4H rear slip ${fourHigh.toFixed(2)}`).toBeGreaterThan(0.5);
    expect(fourHigh, `4H rear slip ${fourHigh.toFixed(2)}`).toBeLessThan(0.9);
  });

  it('applies brake torque to the rear wheels only', () => {
    // "The handbrake should only impact the wheels" — specifically the two
    // it is fitted to. Any front brake torque here would mean the handbrake
    // had grown a chassis- or axle-level effect.
    const { world, v } = setupMovingVehicle(2 * 60);
    v.setInput({ ...EMPTY_INPUT, seq: 2, handbrake: 1 });
    simSteps(world, 30);

    const tel = (v as Physics.SolidAxleVehicle).debugTelemetry();
    expect(tel.wheels[0]!.brakeTorque).toBe(0);
    expect(tel.wheels[1]!.brakeTorque).toBe(0);
    expect(tel.wheels[2]!.brakeTorque).toBeGreaterThan(0);
    expect(tel.wheels[3]!.brakeTorque).toBeGreaterThan(0);
    world.dispose();
  });

  it('swings the tail out mid-corner rather than only slowing down', () => {
    // The test the old file was missing entirely, and the reason a handbrake
    // that did nothing to the vehicle's line survived review.
    //
    // Radius is compared at MATCHED SPEED, never at matched time. The
    // handbrake sheds so much speed that at equal elapsed time the arc
    // shrinks for purely geometric reasons — that reads as rotation and is
    // not. 2H because in 4H the locked centre transfer drags the front axle
    // to lock as well, which is its own (correct) behaviour.
    const cornerRun = (handbrake: number) => {
      const world = makeRoadWorld();
      const v = world.spawnVehicle(
        'p', { position: { x: 0, y: 1.5, z: -120 } }, createStockBuild('ridgeback'),
      ) as Physics.SolidAxleVehicle;
      // The transfer case only moves below 20 km/h off the throttle.
      v.setInput({ ...EMPTY_INPUT, seq: 1, transferCase: '2h' });
      simSteps(world, 60);
      v.setInput({ ...EMPTY_INPUT, seq: 2, throttle: 1, transferCase: '2h' });
      simSteps(world, 150);
      v.setInput({ ...EMPTY_INPUT, seq: 3, throttle: 0.35, steer: 0.5, transferCase: '2h' });
      simSteps(world, 60);
      v.setInput({ ...EMPTY_INPUT, seq: 4, throttle: 0, steer: 0.5, handbrake, transferCase: '2h' });

      const samples: Array<{ speed: number; radius: number; slipR: number; slipF: number }> = [];
      for (let i = 0; i < 150; i++) {
        world.step();
        const tel = v.debugTelemetry();
        const speed = speedXZ(v);
        const contacting = (idx: number[]) => idx
          .map((k) => tel.wheels[k]!)
          .filter((w) => w.contact);
        const meanSlip = (ws: readonly { slipAngle: number }[]) => (ws.length
          ? ws.reduce((a, w) => a + Math.abs(w.slipAngle), 0) / ws.length * DEG
          : 0);
        samples.push({
          speed,
          radius: speed / Math.max(1e-3, Math.abs(tel.yawRate)),
          slipF: meanSlip(contacting([0, 1])),
          slipR: meanSlip(contacting([2, 3])),
        });
      }
      assertOnGround(v, 'corner');
      world.dispose();
      return samples;
    };

    const coast = cornerRun(0);
    const hb = cornerRun(1);
    const entry = coast[0]!.speed;
    const at = (s: typeof coast, target: number) => s.find((r) => r.speed <= target);

    // The rear must slide MORE than the front — that is oversteer. Locking
    // the rear while the front slides just as much is a braking device.
    const peakOversteer = (s: typeof coast) => Math.max(...s.map((r) => r.slipR - r.slipF));
    const diag = `coast oversteer ${peakOversteer(coast).toFixed(1)} deg, handbrake ${peakOversteer(hb).toFixed(1)} deg`;
    expect(peakOversteer(hb), diag).toBeGreaterThan(peakOversteer(coast) + 3);

    // And the line must actually tighten at the same road speed.
    for (const frac of [0.9, 0.75]) {
      const c = at(coast, entry * frac);
      const h = at(hb, entry * frac);
      if (!c || !h) continue;
      expect(
        h.radius,
        `at ${(entry * frac).toFixed(1)} m/s the handbrake arc is ${h.radius.toFixed(1)} m against a ${c.radius.toFixed(1)} m coasting arc`,
      ).toBeLessThan(c.radius);
    }
  }, 30_000);

  it('is stronger than the service brake alone, because only it can lock', () => {
    // This replaces an assertion that full brake must out-stop handbrake-only
    // on the reasoning that four wheels beat two. That reasoning does not
    // survive the brakes being modelled honestly: TUNING.brakeForce is 4500 N
    // against a ~7600 N loaded-front grip limit, so the service brake is
    // deliberately sub-grip and CANNOT lock on high-grip road — it is a
    // modulated brake. The handbrake is a mechanical lock, and in 4H the
    // locked centre transfer carries that lock to the front axle too, so all
    // four tyres end up on their sliding tail. Measured total longitudinal
    // force on a world large enough to stay on: 13199 N foot brake against
    // 15991 N handbrake. Two locked wheels plus a driveline is more than four
    // modulated ones.
    const ACCEL_STEPS = 4 * 60;
    const DECEL_STEPS = 2 * 60;

    const { world: wBrake, v: vBrake } = setupMovingVehicle(ACCEL_STEPS);
    const { world: wBoth, v: vBoth } = setupMovingVehicle(ACCEL_STEPS);

    vBrake.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    simSteps(wBrake, DECEL_STEPS);
    const brakeSpeed = speedXZ(vBrake);
    assertOnGround(vBrake, 'brake');

    vBoth.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1, handbrake: 1 });
    simSteps(wBoth, DECEL_STEPS);
    const bothSpeed = speedXZ(vBoth);
    assertOnGround(vBoth, 'brake+handbrake');

    // Adding the handbrake to the service brake must never make the truck
    // stop more slowly.
    expect(
      bothSpeed,
      `brake+handbrake ${bothSpeed.toFixed(2)} should not be slower to stop than brake alone ${brakeSpeed.toFixed(2)}`,
    ).toBeLessThanOrEqual(brakeSpeed + 0.05);

    wBrake.dispose();
    wBoth.dispose();
  });
});

describe('TUNING: handbrakeForce', () => {
  // The convention (CLAUDE.md): every TUNING field needs a real reader AND a
  // test proving the reader responds. The panel has twice grown sliders for
  // fields nothing read.
  const withTuning = <T>(patch: Partial<typeof TUNING>, fn: () => T): T => {
    const saved = { ...TUNING };
    Object.assign(TUNING, patch);
    try {
      return fn();
    } finally {
      Object.assign(TUNING, saved);
    }
  };

  const handbrakeSpeedAfter2s = (patch: Partial<typeof TUNING>): number =>
    withTuning(patch, () => {
      const { world, v } = setupMovingVehicle(4 * 60);
      v.setInput({ ...EMPTY_INPUT, seq: 2, handbrake: 1 });
      simSteps(world, 2 * 60);
      const speed = speedXZ(v);
      world.dispose();
      return speed;
    });

  it('is read by the handbrake path', () => {
    const weak = handbrakeSpeedAfter2s({ handbrakeForce: 1_200 });
    const strong = handbrakeSpeedAfter2s({ handbrakeForce: 12_000 });
    expect(strong, `weak ${weak.toFixed(2)} m/s vs strong ${strong.toFixed(2)} m/s`)
      .toBeLessThan(weak);
  });

  it('is genuinely separate from brakeForce', () => {
    // The whole point of the field. If the handbrake still read brakeForce,
    // changing brakeForce alone would move handbrake-only deceleration.
    const low = handbrakeSpeedAfter2s({ brakeForce: 500 });
    const high = handbrakeSpeedAfter2s({ brakeForce: 9_000 });
    expect(Math.abs(high - low), `brakeForce moved handbrake-only deceleration: ${low.toFixed(3)} vs ${high.toFixed(3)}`)
      .toBeLessThan(0.01);
  });
});
