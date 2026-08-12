// Deterministic driving scenarios behind the serialized physics goldens.
//
// Shared by physicsGolden.test.ts and its UPDATE_GOLDEN=1 regeneration path so
// the fixture and the check can never describe different runs.
//
// Nothing here touches TUNING. A golden that depended on live tuning state
// would pass or fail on test ordering.

import { EMPTY_INPUT, Physics, createStockBuild } from '../index.js';
import type { PlayerInput, VehicleBuild } from '../types.js';

export const GOLDEN_BUILDS: Readonly<Record<string, VehicleBuild>> = {
  ridgeback: createStockBuild('ridgeback'),
  dustback: createStockBuild('dustback-rs'),
  // The prepared crawler: flex lift, portals, 40s and beadlocks.
  outclaw: {
    ...createStockBuild('outclaw'),
    suspensionId: 'outclaw.suspension.flex-100',
    axleId: 'outclaw.axle.portal-240',
    tireId: 'outclaw.tire.xt-40-wide',
    wheelId: 'outclaw.wheel.beadlock-alloy',
  },
};

export type GoldenTerrain = 'road' | 'slope' | 'split' | 'mud' | 'corrugations';

export const GOLDEN_TERRAINS: readonly GoldenTerrain[] = [
  'road', 'slope', 'split', 'mud', 'corrugations',
];

const RESOLUTION = 96;
const SIZE = 60;

function terrainFor(kind: GoldenTerrain): Physics.TerrainData {
  const heights = new Float32Array(RESOLUTION * RESOLUTION);
  const surfaces = new Uint8Array(RESOLUTION * RESOLUTION);
  for (let zi = 0; zi < RESOLUTION; zi++) {
    const z = (zi / (RESOLUTION - 1) - 0.5) * SIZE;
    for (let xi = 0; xi < RESOLUTION; xi++) {
      const x = (xi / (RESOLUTION - 1) - 0.5) * SIZE;
      const i = zi * RESOLUTION + xi;
      switch (kind) {
        case 'road':
          surfaces[i] = Physics.Surface.Road;
          break;
        case 'slope':
          // A planar 12% grade climbing along +z.
          heights[i] = z * 0.12;
          surfaces[i] = Physics.Surface.Dirt;
          break;
        case 'split':
          // Grip step down the centreline: gravel one side, road the other.
          surfaces[i] = x < 0 ? Physics.Surface.Gravel : Physics.Surface.Road;
          break;
        case 'mud':
          surfaces[i] = Physics.Surface.DeepMud;
          break;
        case 'corrugations':
          // ~1.6 m pitch, 45 mm amplitude: the classic outback washboard.
          heights[i] = Math.sin(z * (2 * Math.PI / 1.6)) * 0.045;
          surfaces[i] = Physics.Surface.Gravel;
          break;
      }
    }
  }
  return {
    size: SIZE,
    resolution: RESOLUTION,
    heights,
    surfaces,
    seed: 4_242,
    mountain: Physics.mountainFor(SIZE),
    petrolStation: Physics.petrolStationPadFor(SIZE),
    ...Physics.dryWater(RESOLUTION),
    bogs: [],
    roads: [],
  } as Physics.TerrainData;
}

/** One fixed control script for every scenario: launch, weave, lift, brake.
 *  Keeping it common means a fixture diff localises to the build or the
 *  surface rather than to the driving. */
function inputAt(tick: number): Partial<PlayerInput> {
  if (tick < 40) return { throttle: 0.5 };
  if (tick < 120) return { throttle: 0.85, steer: 0.3 };
  if (tick < 180) return { throttle: 0.85, steer: -0.35 };
  if (tick < 210) return { throttle: 0 };
  return { throttle: 0, brake: 1 };
}

const TICKS = 240;
const SAMPLE_EVERY = 40;

function q(value: number): string {
  return value.toPrecision(17);
}

/** Serialize one scenario to fixture lines. Deterministic for a given build,
 *  terrain and tick count — see the determinism rules in solidAxleVehicle.ts. */
export function runGoldenScenario(buildId: string, terrain: GoldenTerrain): string[] {
  const build = GOLDEN_BUILDS[buildId];
  if (!build) throw new Error(`unknown golden build: ${buildId}`);
  const world = new Physics.World({ terrain: terrainFor(terrain), obstacles: [] });
  // debugTelemetry is optional on VehicleLike; the owner model always has it.
  const vehicle = world.spawnVehicle(
    `${buildId}-${terrain}`,
    { position: { x: 0, y: 2.2, z: -18 }, yaw: 0.2 },
    build,
  ) as Physics.SolidAxleVehicle;
  const lines: string[] = [];
  for (let tick = 0; tick < TICKS; tick++) {
    vehicle.setInput({ ...EMPTY_INPUT, seq: tick + 1, ...inputAt(tick) });
    world.step();
    if (tick % SAMPLE_EVERY !== 0 && tick !== TICKS - 1) continue;
    const s = vehicle.getState();
    const d = vehicle.debugTelemetry();
    const row: string[] = [
      String(tick),
      q(s.position.x), q(s.position.y), q(s.position.z),
      q(s.rotation.x), q(s.rotation.y), q(s.rotation.z), q(s.rotation.w),
      q(s.linVel.x), q(s.linVel.y), q(s.linVel.z),
      q(s.angVel.x), q(s.angVel.y), q(s.angVel.z),
      q(s.rpm), String(s.gear),
      q(s.axles![0]!.rideY), q(s.axles![0]!.rollAngle),
      q(s.axles![1]!.rideY), q(s.axles![1]!.rollAngle),
    ];
    for (const wheel of s.wheels) {
      row.push(
        q(wheel.spin), wheel.contact ? '1' : '0', q(wheel.suspensionLength),
        q(wheel.angVel), q(wheel.tireDeflection),
      );
    }
    for (const wheel of d.wheels) {
      row.push(q(wheel.normalLoad), q(wheel.slipRatio), q(wheel.sinkDepth));
    }
    lines.push(row.join(','));
  }
  world.dispose();
  return lines;
}

export function goldenName(buildId: string, terrain: GoldenTerrain): string {
  return `${buildId}-${terrain}`;
}
