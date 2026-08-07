// Carve the valley river into the default map, and re-emit the module.
//
// Run once, by hand, when the river's geometry needs to change:
//
//   pnpm --filter @mydrunner/shared exec tsx scripts/carveRiver.ts
//
// It edits the DOCUMENT, not the generator. That is deliberate: a river
// as a height layer would move the procedural base under every authored
// map's delta, invalidating baseChecksum and breaking the invariant that
// applyMapDoc(proceduralDoc()) reproduces generateTerrain() byte for
// byte. As document data it is exactly what a user could have authored
// in the editor, and the shipped map stays rebase-free.
//
// Idempotent: the carve is computed against the base + the map's
// pre-existing delta, and the river's own contribution is recomputed
// from scratch each run rather than accumulated, so running it twice
// produces the same file.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applyMapDoc, encodeMapDoc, HEIGHT_DELTA_SCALE, WATER_FLOW_SCALE,
  WATER_LEVEL_SCALE, WATER_NONE_CM, decodeInt16Grid, encodeInt16Grid,
  type MapDoc,
} from '../src/map/index.js';
import { defaultMap } from '../src/map/maps/defaultMap.js';
import { generateTerrain, pointToSegmentDist } from '../src/physics/terrain.js';

/** The river's centreline, north (high ground) to south (lowlands).
 *
 *  Crosses the main road (z = TERRAIN.roadZ = -50) at about x = -40,
 *  which is ~95 m along the road from the spawn grid: far enough to
 *  arrive at speed, close enough that every player meets it. */
const CENTRELINE: ReadonlyArray<{ x: number; z: number; level: number; bed: number }> = [
  { x: -30, z: 10, level: 0.3, bed: 1.55 },
  { x: -34, z: -14, level: -0.05, bed: 1.9 },
  // The ford. Deliberately the shallowest point on the river: a road
  // crosses where the water is shallow, which is both why real fords
  // exist and what stops the main artery being a wall. At 1.45 m the
  // motorbike's airbox goes under and everything else gets through,
  // while 20 m either side is deep enough to drown a ute and float a
  // Patrol off its wheels - so the reward for holding the line is real.
  { x: -40, z: -50, level: -0.45, bed: 1.45 },
  { x: -46, z: -78, level: -0.95, bed: 1.95 },
  { x: -38, z: -110, level: -1.4, bed: 2.1 },
];

/** Half-width of the deep channel, m.
 *
 *  Narrow on purpose. A wide flat-bottomed ford is one depth everywhere,
 *  so there is no line to pick and no reason to look at the water before
 *  driving in — every kind crosses it identically. A deep channel with
 *  graded shoulders gives the crossing a profile: the direct line is for
 *  the snorkelled Patrol, everyone else angles for the shallow shelf. */
const CHANNEL_HALF = 6;
/** Half-width of the graded bank outside the channel, m. */
const BANK_HALF = 18;

/** Flow speed at the centreline, m/s. Falls to zero at the bank. */
const FLOW_SPEED = 1.15;

interface Nearest {
  dist: number;
  level: number;
  bed: number;
  tanX: number;
  tanZ: number;
}

/** Distance to the centreline, plus the interpolated surface level and
 *  the downstream tangent at the closest point. */
function nearestOnRiver(x: number, z: number): Nearest {
  let best: Nearest = { dist: Infinity, level: 0, bed: 0, tanX: 0, tanZ: 0 };
  for (let i = 0; i < CENTRELINE.length - 1; i++) {
    const a = CENTRELINE[i]!;
    const b = CENTRELINE[i + 1]!;
    const d = pointToSegmentDist(x, z, a.x, a.z, b.x, b.z);
    if (d >= best.dist) continue;
    // Parameter along the segment, for interpolating the level.
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0
      ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2))
      : 0;
    const len = Math.sqrt(len2) || 1;
    best = {
      dist: d,
      level: a.level + (b.level - a.level) * t,
      bed: a.bed + (b.bed - a.bed) * t,
      tanX: dx / len,
      tanZ: dz / len,
    };
  }
  return best;
}

/** 1 inside `inner`, easing to 0 at `outer`. */
function falloff(d: number, inner: number, outer: number): number {
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  const t = (d - inner) / (outer - inner);
  return 1 - t * t * (3 - 2 * t);
}

function main(): void {
  const doc: MapDoc = JSON.parse(JSON.stringify(defaultMap)) as MapDoc;
  const n = doc.base.resolution;
  const size = doc.base.size;

  // The ground as the map currently composes it, MINUS any river the
  // last run carved. Recomputing from base + non-river delta is what
  // makes this script idempotent.
  const base = generateTerrain({
    seed: doc.base.seed,
    size: doc.base.size,
    resolution: n,
    roads: doc.roads.length ? doc.roads : undefined,
    bogs: doc.bogs,
    pad: doc.pad,
  });
  const priorDelta = decodeInt16Grid(doc.heightDelta);
  const priorWater = decodeInt16Grid(doc.water.level, WATER_NONE_CM);

  const delta = new Int16Array(n * n);
  const level = new Int16Array(n * n).fill(WATER_NONE_CM);
  const flowX = new Int16Array(n * n);
  const flowZ = new Int16Array(n * n);

  let wet = 0;
  let carved = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const x = (c / (n - 1) - 0.5) * size;
      const z = (r / (n - 1) - 0.5) * size;

      // Start from the authored delta, with the previous run's channel
      // removed: a cell the river touched before had its delta written
      // by this script, so keeping it would deepen the channel every run.
      const wasRiver = priorWater[i] !== WATER_NONE_CM;
      delta[i] = wasRiver ? 0 : priorDelta[i]!;

      const near = nearestOnRiver(x, z);
      if (near.dist > BANK_HALF) continue;

      const w = falloff(near.dist, CHANNEL_HALF, BANK_HALF);
      const ground = base.heights[i]! + delta[i]! / HEIGHT_DELTA_SCALE;
      const bedTarget = near.level - near.bed;
      // Only ever cut down. A river that filled a hollow to reach its
      // bed would dam the valley it is supposed to drain.
      if (bedTarget < ground) {
        const cut = (ground - bedTarget) * w;
        delta[i] = Math.round((ground - cut - base.heights[i]!) * HEIGHT_DELTA_SCALE);
        carved += 1;
      }

      // Water fills the channel out to where the bank rises above the
      // surface, so the waterline lands on the geometry rather than at
      // a fixed radius.
      const newGround = base.heights[i]! + delta[i]! / HEIGHT_DELTA_SCALE;
      if (newGround < near.level) {
        level[i] = Math.round(near.level * WATER_LEVEL_SCALE);
        // Fastest in the middle, still at the edges — the shallows are
        // where you recover, so they should not shove you.
        const speed = FLOW_SPEED * falloff(near.dist, 0, BANK_HALF);
        flowX[i] = Math.round(near.tanX * speed * WATER_FLOW_SCALE);
        flowZ[i] = Math.round(near.tanZ * speed * WATER_FLOW_SCALE);
        wet += 1;
      }
    }
  }

  doc.heightDelta = encodeInt16Grid(delta, n);
  doc.water = {
    level: encodeInt16Grid(level, n, WATER_NONE_CM),
    flowX: encodeInt16Grid(flowX, n),
    flowZ: encodeInt16Grid(flowZ, n),
  };

  // Compose it once here so a broken carve fails the script rather than
  // the game. baseChecksum is untouched: the generator has not moved.
  const world = applyMapDoc(doc);
  const fordIdx = (() => {
    const c = Math.round((-40 / size + 0.5) * (n - 1));
    const r = Math.round((-50 / size + 0.5) * (n - 1));
    return r * n + c;
  })();
  const fordDepth = world.terrain.waterLevel[fordIdx]! - world.terrain.heights[fordIdx]!;

  const out = join(dirname(fileURLToPath(import.meta.url)), '../src/map/maps/defaultMap.ts');
  writeFileSync(
    out,
    '// Generated from the authored default map in procedural(3).json.\n'
    + '// The valley river is carved by scripts/carveRiver.ts — re-run it\n'
    + '// rather than hand-editing the water grids.\n'
    + 'import type { MapDoc } from "../mapDoc.js";\n\n'
    + `export const defaultMap: MapDoc = ${encodeMapDoc(doc)};\n`,
  );

  process.stdout.write(
    `[carveRiver] carved ${carved} cells, ${wet} wet; ford depth ${fordDepth.toFixed(2)} m\n`,
  );
}

main();
