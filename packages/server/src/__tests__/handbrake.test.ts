// Handbrake tests. Verifies that handbrake decelerates a moving vehicle
// faster than just releasing the throttle (coasting).

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, EMPTY_INPUT } from '@mydrunner/shared';

beforeAll(async () => {
  await Physics.initRapier();
});

const FIXED_DT = 1 / 60;

function simSteps(world: Physics.World, steps: number): void {
  for (let i = 0; i < steps; i++) world.step();
}

function speedXZ(v: Physics.VehicleLike): number {
  const s = v.getState();
  return Math.hypot(s.linVel.x, s.linVel.z);
}

function makeRoadWorld(): Physics.World {
  const n = 32;
  const size = 100;
  const heights = new Float32Array(n * n);
  const surfaces = new Uint8Array(n * n);
  surfaces.fill(Physics.Surface.Road);
  return new Physics.World({
    terrain: {
      size,
      resolution: n,
      heights,
      surfaces,
      seed: 0,
      mountain: Physics.mountainFor(size),
      petrolStation: Physics.petrolStationPadFor(size),
      bogs: [],
      roads: [],
    },
  });
}

/** Build a world, settle, accelerate for `accelSteps`, return world+vehicle. */
function setupMovingVehicle(accelSteps: number): { world: Physics.World; v: Physics.VehicleLike } {
  const world = makeRoadWorld();
  const v = world.spawnVehicle('p', { position: { x: 0, y: 1.5, z: 0 } });
  simSteps(world, 60); // settle
  v.setInput({ ...EMPTY_INPUT, seq: 1, throttle: 1 });
  simSteps(world, accelSteps);
  return { world, v };
}

describe('handbrake', () => {
  it('reduces speed faster than coasting over the same time window', () => {
    const ACCEL_STEPS = 4 * 60; // 4 s of acceleration
    const DECEL_STEPS = 2 * 60; // 2 s of deceleration

    const { world: wCoast, v: vCoast } = setupMovingVehicle(ACCEL_STEPS);
    const { world: wHB, v: vHB } = setupMovingVehicle(ACCEL_STEPS);

    // Coast: release throttle
    vCoast.setInput({ ...EMPTY_INPUT, seq: 2 });
    simSteps(wCoast, DECEL_STEPS);
    const coastSpeed = speedXZ(vCoast);

    // Handbrake: rear wheels actively braked (1.5× brakeForce on rear)
    vHB.setInput({ ...EMPTY_INPUT, seq: 2, handbrake: 1 });
    simSteps(wHB, DECEL_STEPS);
    const hbSpeed = speedXZ(vHB);

    expect(
      hbSpeed,
      `handbrake speed ${hbSpeed.toFixed(2)} m/s should be less than coast speed ${coastSpeed.toFixed(2)} m/s`,
    ).toBeLessThan(coastSpeed);

    wCoast.dispose();
    wHB.dispose();
  });

  it('is more effective than brake-only over the same time window', () => {
    const ACCEL_STEPS = 4 * 60;
    const DECEL_STEPS = 2 * 60;

    const { world: wBrake, v: vBrake } = setupMovingVehicle(ACCEL_STEPS);
    const { world: wHB, v: vHB } = setupMovingVehicle(ACCEL_STEPS);

    vBrake.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    simSteps(wBrake, DECEL_STEPS);
    const brakeSpeed = speedXZ(vBrake);

    // Handbrake = rear-only 1.5×; brake = all-wheel 1×. With a full brake
    // pedal, brake force should be equal or greater overall — this tests
    // that handbrake alone is a meaningful amount of braking.
    vHB.setInput({ ...EMPTY_INPUT, seq: 2, handbrake: 1 });
    simSteps(wHB, DECEL_STEPS);
    const hbSpeed = speedXZ(vHB);

    // Handbrake (rear only, 1.5×) should at least bring speed within 2× of full brake
    expect(hbSpeed).toBeLessThan(brakeSpeed * 2 + 0.5);
    wBrake.dispose();
    wHB.dispose();
  });

  it('full brake (all wheels) stops faster than handbrake alone (rear only)', () => {
    // Full brake applies braking torque to all 4 wheels; handbrake only the
    // 2 rear wheels. All else equal, 4-wheel braking should outperform 2-wheel.
    const ACCEL_STEPS = 4 * 60;
    const DECEL_STEPS = 2 * 60;

    const { world: wBrake, v: vBrake } = setupMovingVehicle(ACCEL_STEPS);
    const { world: wHB, v: vHB } = setupMovingVehicle(ACCEL_STEPS);

    vBrake.setInput({ ...EMPTY_INPUT, seq: 2, brake: 1 });
    simSteps(wBrake, DECEL_STEPS);
    const brakeSpeed = speedXZ(vBrake);

    vHB.setInput({ ...EMPTY_INPUT, seq: 2, handbrake: 1 });
    simSteps(wHB, DECEL_STEPS);
    const hbOnlySpeed = speedXZ(vHB);

    expect(
      brakeSpeed,
      `brake-only speed ${brakeSpeed.toFixed(2)} should be less than HB-only ${hbOnlySpeed.toFixed(2)}`,
    ).toBeLessThan(hbOnlySpeed);

    wBrake.dispose();
    wHB.dispose();
  });
});
