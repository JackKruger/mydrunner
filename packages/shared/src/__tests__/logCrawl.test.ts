// Six-log crawl course.
//
// A stock Ridgeback in low range crawls at under 5 km/h, in a straight line,
// into a row of six logs laid square across its path. The logs span the full
// track, so both wheels of an axle load identically: the excitation is pure
// pitch. Nothing steers, the course is symmetric about x = 0, and the only
// asymmetric thing in the world is the vehicle model itself. That is the
// point of the rig — roll, yaw and lateral drift all have a correct answer of
// approximately zero, so any of them appearing is a defect and not terrain.
//
// This is the first test that drives a vehicle through the condition
// LEDGE_CONTACT.normalMassBudget was added for. That constant exists because
// "obstacles catching three or four tyres in the same tick claim up to twice
// the sprung mass and manufacture chassis momentum", but its only other
// coverage (wheelLedge.test.ts) tightens the constant and watches a run
// signature move — nothing puts a vehicle across a row of obstacles.
//
// STATUS: THIS TEST IS EXPECTED TO FAIL ON THE CURRENT PHYSICS. It is a
// reproduction, not a regression guard. The truck does crawl over all six
// logs under 5 km/h without getting air, but it exits several metres to one
// side and tens of degrees off heading with the steering input pinned at
// zero. Measured numbers are in the assertion messages. Do not widen a
// threshold to make this green; the thresholds are what "crawls over a log"
// means.
//
// Measured while building this rig — a stock Ridgeback, speed-controlled at
// 1.13 m/s, six logs, gap of one diameter, steering pinned at zero. `drift` is
// peak |x| in metres and `yaw` peak heading error in degrees; both have a
// correct answer of ~0. Range 4H is included because it isolates the two
// failure modes from each other:
//
//   r=0.0975 4L cap 0.25   stalls z=5.3   drift 0.9   yaw 85.6   roll 24deg
//   r=0.0975 4L cap 0.35   CLEARS         drift 6.2   yaw 74.8
//   r=0.0975 4L cap 0.50   stalls z=5.3   drift 28.9  yaw 176.8  maxVy 56.0 m/s
//   r=0.0975 4H cap 0.35   stalls z=3.3   drift 0.000 yaw 0.2
//   r=0.13   4L cap 0.35   CLEARS         drift 4.7   yaw 62.0
//   r=0.13   4H cap 0.35   stalls z=3.2   drift 0.000 yaw 0.1
//   r=0.195  4L cap 0.50   CLEARS         drift 6.5   yaw 34.4
//   r=0.195  4H cap 0.50   stalls z=3.1   drift 0.009 yaw 6.9
//
// In high range the truck is immaculate — it tracks dead straight to three
// decimal places and never lifts a wheel — but it has no torque to climb, so
// it stops at the first log. In low range it has the torque and every run that
// climbs is thrown metres sideways and tens of degrees off heading. No
// configuration does both. The 56 m/s vertical is the ejection defect
// wheelLedge.test.ts:583 records at 39.5 m/s, reached here on 10 cm logs.
//
// The outcome is also bifurcation-sensitive in the way wheelLedge.test.ts:540
// warns about: this test targets 1.25 m/s rather than 1.13 and stalls at the
// second log where the 1.13 run cleared all six.
//
// Run alone:
//   pnpm --filter @mydrunner/shared exec vitest run src/__tests__/logCrawl.test.ts

import { beforeAll, describe, expect, it } from 'vitest';
import { BUTTON_RANGE, EMPTY_INPUT, type PlayerInput } from '../types.js';
import { createStockBuild } from '../vehicleBuild.js';
import type { Obstacle } from '../physics/objectCatalog.js';
import {
  Surface, dryWater, mountainFor, petrolStationPadFor, type TerrainData,
} from '../physics/terrain.js';
import { SolidAxleVehicle } from '../physics/solidAxleVehicle.js';
import { spawnYAboveGround } from '../physics/vehicleGeom.js';
import { World, initRapier } from '../physics/world.js';

beforeAll(async () => {
  await initRapier();
});

const SIZE = 40;
const RES = 16;

// Stock Ridgeback, measured: wheelRadius 0.39, wheelbase 2.72, track 1.78,
// 1800 kg, low range 2.65:1, and no lockers (createStockBuild fits those only
// on the Outclaw). Settled chassis sits at y 1.265 with the belly at 0.775.
const WHEEL_RADIUS = 0.39;

// "Half the size of a stock tyre". OBJECT_INFO.log seats the drum at
// y = radius, so the crest lands at 2 * 0.195 = 0.39 m — exactly hub height.
const LOG_RADIUS = WHEEL_RADIUS * 0.5;
// Gap of one log diameter between them, i.e. a centre pitch of two diameters.
const LOG_PITCH = LOG_RADIUS * 4;
const FIRST_LOG_Z = 5;
const LOG_COUNT = 6;
const LAST_LOG_Z = FIRST_LOG_Z + (LOG_COUNT - 1) * LOG_PITCH;
// Far enough past the last log that the rear axle (1.36 m behind the chassis
// origin) is clear of it before the run is called complete.
const FINISH_Z = LAST_LOG_Z + 2.5;

// Under 5 km/h is the specification; 1.25 m/s is 4.5 km/h, which leaves the
// controller a little room below the limit rather than sitting on it.
const TARGET_SPEED = 1.25;
const SPEED_LIMIT = 5 / 3.6;
// A crawl is part throttle. Uncapped, the speed controller floors it the
// instant the truck stalls against a log, which is a different manoeuvre.
const THROTTLE_CAP = 0.5;

const SETTLE_TICKS = 180;
const RUN_TICKS = 2400;

/** Flat road. The petrol station is pushed off-map for the same reason
 *  axleRegressions.test.ts does it: a landmark collider must not be able to
 *  masquerade as part of the course. */
function flatTerrain(): TerrainData {
  const petrolStation = petrolStationPadFor(SIZE);
  petrolStation.cx = SIZE * 4;
  petrolStation.cz = SIZE * 4;
  return {
    size: SIZE,
    resolution: RES,
    heights: new Float32Array(RES * RES),
    surfaces: new Uint8Array(RES * RES).fill(Surface.Road),
    seed: 0,
    mountain: mountainFor(SIZE),
    petrolStation,
    ...dryWater(RES),
    bogs: [],
    roads: [],
  };
}

/** Six logs across the path. Built as catalog obstacles rather than hand-rolled
 *  Rapier cylinders so the test gets the shipped collider geometry and the
 *  shipped friction (0.7) — wheelLedge.test.ts's addAxialLog hardcodes 1.0,
 *  which is not a surface that exists in the game. `length` spans the 1.78 m
 *  track with margin so the truck cannot drive around an end. */
function logRow(): Obstacle[] {
  const out: Obstacle[] = [];
  for (let i = 0; i < LOG_COUNT; i++) {
    out.push({
      id: `log-${i}`,
      kind: 'log',
      x: 0,
      y: 0,
      z: FIRST_LOG_Z + i * LOG_PITCH,
      size: LOG_RADIUS,
      height: 0.7, // unused by the log collider; OBJECT_INFO.log dims say so
      yaw: 0, // local +X is the log axis, so yaw 0 lays it square across +Z travel
      length: 6,
    });
  }
  return out;
}

interface CrawlRun {
  clearedTick: number;
  finalZ: number;
  finite: boolean;
  /** Ticks with every wheel out of contact at once. */
  allAirborneTicks: number;
  /** Per-wheel ticks out of contact, [FL, FR, RL, RR]. */
  liftTicks: number[];
  longestLiftStreak: number;
  maxVerticalSpeed: number;
  maxChassisY: number;
  maxSpeed: number;
  meanSpeed: number;
  maxDriftX: number;
  finalDriftX: number;
  maxYawDeg: number;
  maxRollDeg: number;
  maxPitchRad: number;
  chassisContactTicks: number;
  transferCase: string | undefined;
}

function runCrawl(): CrawlRun {
  const build = createStockBuild();
  const world = new World({ terrain: flatTerrain(), obstacles: logRow() });
  const vehicle = new SolidAxleVehicle(
    world,
    'log-crawl',
    { position: { x: 0, y: spawnYAboveGround(build), z: 0 } },
    build,
  );
  world.vehicles.set(vehicle.id, vehicle);

  vehicle.setInput({ ...EMPTY_INPUT, seq: 1 });
  for (let i = 0; i < SETTLE_TICKS; i++) world.step();

  // canShift gates on throttle < 0.18, so the range change has to happen on a
  // zero-throttle tick. Default is 4h and the cycle is 2h -> 4h -> 4l, so one
  // rising edge lands on low range. No locker bits: a stock Ridgeback has none
  // and the buttons would be inert.
  vehicle.setInput({ ...EMPTY_INPUT, seq: 2, buttons: BUTTON_RANGE });
  world.step();

  const input: PlayerInput = { ...EMPTY_INPUT, throttle: 0, seq: 3 };
  const run: CrawlRun = {
    clearedTick: -1, finalZ: 0, finite: true, allAirborneTicks: 0,
    liftTicks: [0, 0, 0, 0], longestLiftStreak: 0, maxVerticalSpeed: 0,
    maxChassisY: -Infinity, maxSpeed: 0, meanSpeed: 0, maxDriftX: 0,
    finalDriftX: 0, maxYawDeg: 0, maxRollDeg: 0, maxPitchRad: 0,
    chassisContactTicks: 0, transferCase: vehicle.drivetrainStatus?.().transferCase,
  };
  const streak = [0, 0, 0, 0];
  let speedSum = 0;
  let samples = 0;

  for (let tick = 0; tick < RUN_TICKS; tick++) {
    // Speed control, not rpm control. RPM cannot express this manoeuvre: a
    // truck stalled against a log idles at ~1150 rpm with the driveline
    // locked, so an rpm target reads as satisfied while the vehicle is
    // stationary and backs the throttle off to nothing. In low range rpm also
    // pins at the limiter whenever a tyre spins, so it measures wheelspin
    // rather than progress.
    const pre = vehicle.getState();
    const speed = Math.hypot(pre.linVel.x, pre.linVel.z);
    input.throttle = Math.max(0, Math.min(THROTTLE_CAP, TARGET_SPEED - speed));
    input.seq = tick + 4;
    vehicle.setInput(input);
    world.step();

    const state = vehicle.getState();
    run.finite &&= Number.isFinite(state.position.x + state.position.y + state.position.z)
      && Number.isFinite(state.rotation.x + state.rotation.y + state.rotation.z + state.rotation.w);

    // Measure from the moment the truck is rolling, so the settle transient
    // and the standing start are not folded into the crossing statistics.
    if (state.position.z > 0.4) {
      const telemetry = vehicle.debugTelemetry();
      let airborne = 0;
      telemetry.wheels.forEach((wheel, i) => {
        if (wheel.contact) {
          streak[i] = 0;
        } else {
          airborne++;
          run.liftTicks[i]!++;
          streak[i]!++;
          run.longestLiftStreak = Math.max(run.longestLiftStreak, streak[i]!);
        }
      });
      if (airborne === 4) run.allAirborneTicks++;

      const currentSpeed = Math.hypot(state.linVel.x, state.linVel.z);
      run.maxSpeed = Math.max(run.maxSpeed, currentSpeed);
      speedSum += currentSpeed;
      samples++;

      run.maxVerticalSpeed = Math.max(run.maxVerticalSpeed, Math.abs(state.linVel.y));
      run.maxChassisY = Math.max(run.maxChassisY, state.position.y);
      run.maxDriftX = Math.max(run.maxDriftX, Math.abs(state.position.x));
      run.maxRollDeg = Math.max(run.maxRollDeg, Math.abs(telemetry.rollAngle) * 180 / Math.PI);
      run.maxPitchRad = Math.max(run.maxPitchRad, Math.abs(telemetry.pitchAngle));

      const q = state.rotation;
      const yaw = Math.atan2(
        2 * (q.w * q.y + q.x * q.z),
        1 - 2 * (q.y * q.y + q.z * q.z),
      );
      run.maxYawDeg = Math.max(run.maxYawDeg, Math.abs(yaw) * 180 / Math.PI);

      // Belly strike: the crests stand 0.39 m up and the settled belly rides
      // at 0.775 m, so a chassis manifold against an obstacle means the truck
      // is somewhere it should not be.
      world.world.contactPairsWith(vehicle.chassis, () => { run.chassisContactTicks++; });
    }

    if (state.position.z > FINISH_Z) {
      run.clearedTick = tick;
      break;
    }
  }

  const final = vehicle.getState();
  run.finalZ = final.position.z;
  run.finalDriftX = Math.abs(final.position.x);
  run.meanSpeed = samples ? speedSum / samples : 0;
  world.dispose();
  return run;
}

describe('six-log crawl course', () => {
  it('crawls a row of six logs under 5 km/h without air, wheel lift or lateral drift', () => {
    const run = runCrawl();
    const report = `cleared=${run.clearedTick} finalZ=${run.finalZ.toFixed(2)} `
      + `speed=${run.meanSpeed.toFixed(2)}/${run.maxSpeed.toFixed(2)} m/s `
      + `maxVy=${run.maxVerticalSpeed.toFixed(2)} maxY=${run.maxChassisY.toFixed(2)} `
      + `drift=${run.maxDriftX.toFixed(2)}/${run.finalDriftX.toFixed(2)} m `
      + `yaw=${run.maxYawDeg.toFixed(1)}deg roll=${run.maxRollDeg.toFixed(1)}deg `
      + `pitch=${run.maxPitchRad.toFixed(2)}rad lift=${run.liftTicks.join(',')} `
      + `streak=${run.longestLiftStreak} allAir=${run.allAirborneTicks} `
      + `belly=${run.chassisContactTicks}`;

    // The run is only meaningful in low range; a refused range change would
    // quietly turn this into a different test.
    expect(run.transferCase, 'range change was refused').toBe('4l');
    expect(run.finite, `state went non-finite: ${report}`).toBe(true);

    // Crawls over all six.
    expect(run.clearedTick, `did not clear the row: ${report}`).toBeGreaterThanOrEqual(0);

    // ...slowly. Under 5 km/h is the specification.
    expect(run.maxSpeed, `exceeded 5 km/h: ${report}`).toBeLessThan(SPEED_LIMIT);

    // ...without getting air. A crawl over a 0.39 m crest is a ~46 mm
    // wheel-centre excursion; 0.8 m/s of chassis vertical speed is already
    // generous. wheelLedge.test.ts records the current model reaching 39.5 m/s
    // off a single log of this size.
    expect(run.maxVerticalSpeed, `chassis got air: ${report}`).toBeLessThan(0.8);
    expect(run.maxChassisY, `chassis rose too far: ${report}`).toBeLessThan(1.265 + 0.3);
    expect(run.allAirborneTicks, `all four wheels left the ground: ${report}`).toBe(0);

    // ...without really lifting a tyre. The logs are square to the vehicle, so
    // both wheels of an axle rise together and neither should ever unload.
    expect(run.longestLiftStreak, `a wheel hung in the air: ${report}`).toBeLessThan(10);

    // ...and with near-zero horizontal movement, because the course is
    // symmetric and the steering input is zero for the whole run.
    expect(run.finalDriftX, `drifted sideways: ${report}`).toBeLessThan(0.15);
    expect(run.maxYawDeg, `yawed off heading: ${report}`).toBeLessThan(3);
    expect(run.maxRollDeg, `rolled on a symmetric obstacle: ${report}`).toBeLessThan(3);

    expect(run.maxPitchRad, `pitched excessively: ${report}`).toBeLessThan(0.25);
    expect(run.chassisContactTicks, `belly struck the course: ${report}`).toBe(0);
  }, 30_000);
});
