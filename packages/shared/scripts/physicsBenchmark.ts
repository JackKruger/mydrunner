import {
  BUTTON_FRONT_LOCKER,
  BUTTON_REAR_LOCKER,
  EMPTY_INPUT,
  Physics,
  createStockBuild,
} from '../src/index.js';

const WARM_TICKS = 240;
const MEASURE_TICKS = 1_200;
const LIMIT_MS = 2;

await Physics.initRapier();

const resolution = 64;
const size = 32;
const heights = new Float32Array(resolution * resolution);
const surfaces = new Uint8Array(resolution * resolution).fill(Physics.Surface.DeepMud);
// Keep each tyre in deformable soil while the axle tube/differential centre
// passes over a narrow sealed ridge. This makes the benchmark exercise both
// soil/rut sampling and the low-friction axle probes on every measured tick.
for (let z = 0; z < resolution; z++) {
  for (let x = Math.floor(resolution / 2) - 1; x <= Math.floor(resolution / 2); x++) {
    surfaces[z * resolution + x] = Physics.Surface.Road;
    heights[z * resolution + x] = 0.42;
  }
}
const terrain: Physics.TerrainData = {
  size,
  resolution,
  heights,
  surfaces,
  seed: 91,
  mountain: Physics.mountainFor(size),
  petrolStation: Physics.petrolStationPadFor(size),
  ...Physics.dryWater(resolution),
  bogs: [],
  roads: [],
};
const world = new Physics.World({ terrain });
const build = {
  ...createStockBuild('outclaw'),
  suspensionId: 'outclaw.suspension.flex-100',
  axleId: 'outclaw.axle.portal-240',
  tireId: 'outclaw.tire.xt-40-wide',
  wheelId: 'outclaw.wheel.beadlock-alloy',
  frontLocker: true,
  rearLocker: true,
};
const vehicle = world.spawnVehicle('benchmark', { position: { x: 0, y: 1.8, z: 0 } }, build);
vehicle.setInput({
  ...EMPTY_INPUT,
  seq: 1,
  transferCase: '4l',
  buttons: BUTTON_FRONT_LOCKER | BUTTON_REAR_LOCKER,
});
world.step();

const field = world.ruts as Physics.SparseRutField;
const samples = new Float64Array(MEASURE_TICKS);
let maxSinkage = 0;
let probeContacts = 0;
let lockersEngaged = false;
for (let tick = 0; tick < WARM_TICKS + MEASURE_TICKS; tick++) {
  vehicle.setInput({
    ...EMPTY_INPUT,
    seq: tick + 2,
    throttle: 0.38,
    steer: tick % 240 < 120 ? 0.18 : -0.18,
  });
  if (tick % 7 === 0) {
    const position = vehicle.getState().position;
    field.applyStamp({
      x: position.x - 0.7,
      z: position.z,
      heading: 0,
      radiusLong: 0.45,
      radiusLat: 0.18,
      depth: 0.004,
    });
  }
  const started = performance.now();
  world.step();
  const debug = vehicle.debugTelemetry?.();
  if (debug) {
    for (const wheel of debug.wheels) maxSinkage = Math.max(maxSinkage, wheel.sinkDepth);
    for (const axle of debug.axles) {
      if (axle.tubeContact || axle.housingContact) probeContacts++;
    }
    lockersEngaged ||= debug.driveline.frontLocked && debug.driveline.rearLocked;
  }
  if (tick >= WARM_TICKS) samples[tick - WARM_TICKS] = performance.now() - started;
}

const ordered = [...samples].sort((a, b) => a - b);
const p95 = ordered[Math.floor(ordered.length * 0.95)]!;
const mean = ordered.reduce((sum, sample) => sum + sample, 0) / ordered.length;
const rutDepth = field.sampleDepth(vehicle.getState().position.x - 0.7, vehicle.getState().position.z);
console.log(JSON.stringify({
  ticks: MEASURE_TICKS,
  meanMs: mean,
  p95Ms: p95,
  limitMs: LIMIT_MS,
  maxSinkage,
  probeContacts,
  rutDepth,
  lockersEngaged,
}));
world.dispose();
if (p95 >= LIMIT_MS || maxSinkage <= 0 || probeContacts <= 0 || rutDepth <= 0 || !lockersEngaged) {
  process.exitCode = 1;
}
