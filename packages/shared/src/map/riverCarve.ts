// The valley river, as a pure document transform.
//
// It edits the DOCUMENT, not the generator. That is deliberate: a river as a
// height layer would move the procedural base under every authored map's
// delta, invalidating baseChecksum and breaking the invariant that
// applyMapDoc(proceduralDoc()) reproduces generateTerrain() byte for byte. As
// document data it is exactly what a user could have authored in the editor,
// and the shipped map stays rebase-free.
//
// Lives in src rather than in scripts/ so the fixed-point property below is
// testable. It used to be inlined in scripts/carveRiver.ts, where the only
// way to check "running it twice produces the same file" was to run it twice
// and look - which nobody did, and it had not been true for some time.

import { HEIGHT_DELTA_SCALE, WATER_FLOW_SCALE, WATER_LEVEL_SCALE, WATER_NONE_CM } from './mapDoc.js';
import type { MapDoc } from './mapDoc.js';
import { decodeInt16Grid, encodeInt16Grid } from './tileGrid.js';
import { generateTerrain, pointToSegmentDist } from '../physics/terrain.js';

/** The river's centreline, north (high ground) to south (lowlands).
 *
 *  Crosses the main road (z = TERRAIN.roadZ = -50) at about x = -40, which is
 *  ~95 m along the road from the spawn grid: far enough to arrive at speed,
 *  close enough that every player meets it. */
export const RIVER_CENTRELINE: ReadonlyArray<{ x: number; z: number; level: number; bed: number }> = [
  { x: -30, z: 10, level: 0.3, bed: 1.55 },
  { x: -34, z: -14, level: -0.05, bed: 1.9 },
  // The ford. Deliberately the shallowest point on the river: a road crosses
  // where the water is shallow, which is both why real fords exist and what
  // stops the main artery being a wall. At 1.45 m the smallest airbox goes
  // under and everything else gets through, while 20 m either side is deep
  // enough to drown a ute and float a wagon off its wheels - so the reward
  // for holding the line is real.
  { x: -40, z: -50, level: -0.45, bed: 1.45 },
  { x: -46, z: -78, level: -0.95, bed: 1.95 },
  { x: -38, z: -110, level: -1.4, bed: 2.1 },
];

/** Half-width of the deep channel, m.
 *
 *  Narrow on purpose. A wide flat-bottomed ford is one depth everywhere, so
 *  there is no line to pick and no reason to look at the water before driving
 *  in - every vehicle crosses it identically. A deep channel with graded
 *  shoulders gives the crossing a profile: the direct line is for the
 *  snorkelled wagon, everyone else angles for the shallow shelf. */
export const CHANNEL_HALF = 6;
/** Half-width of the graded bank outside the channel, m. */
export const BANK_HALF = 18;
/** Flow speed at the centreline, m/s. Falls to zero at the bank. */
export const FLOW_SPEED = 1.15;

interface Nearest {
  dist: number;
  level: number;
  bed: number;
  tanX: number;
  tanZ: number;
}

/** Distance to the centreline, plus the interpolated surface level and the
 *  downstream tangent at the closest point. */
function nearestOnRiver(x: number, z: number): Nearest {
  let best: Nearest = { dist: Infinity, level: 0, bed: 0, tanX: 0, tanZ: 0 };
  for (let i = 0; i < RIVER_CENTRELINE.length - 1; i++) {
    const a = RIVER_CENTRELINE[i]!;
    const b = RIVER_CENTRELINE[i + 1]!;
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

export interface RiverCarveResult {
  doc: MapDoc;
  /** Cells cut down to the bed profile. */
  carved: number;
  /** Cells that ended up under the waterline. Always <= carved. */
  wet: number;
}

/**
 * Cut the river into a copy of `doc` and return it. The input is not mutated.
 *
 * A fixed point: carve(carve(d)) deep-equals carve(d), because the river's own
 * contribution is recomputed from scratch over its whole footprint rather than
 * accumulated on top of the last run's.
 *
 * That footprint is the subtlety. The reset must cover every cell the carve
 * can touch - everything inside BANK_HALF - not just the cells the last run
 * left under water. Those sets differ by the entire graded bank, which is
 * carved and stays dry by design; keying the reset on the water grid left
 * those cuts in place to be re-carved on top of themselves, so each run bit
 * deeper, pushed more shoulder cells under the waterline, and changed the
 * reset set for the next run. It never settled.
 */
export function carveRiver(source: MapDoc): RiverCarveResult {
  const doc: MapDoc = JSON.parse(JSON.stringify(source)) as MapDoc;
  const n = doc.base.resolution;
  const size = doc.base.size;

  // The ground as the map composes it, minus any river a previous run cut.
  const base = generateTerrain({
    seed: doc.base.seed,
    size: doc.base.size,
    resolution: n,
    roads: doc.roads.length ? doc.roads : undefined,
    bogs: doc.bogs,
    pad: doc.pad,
  });
  const priorDelta = decodeInt16Grid(doc.heightDelta);

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

      // Outside the footprint the authored delta is somebody else's work and
      // is carried through untouched. Inside it, this function owns the
      // ground: start from zero and cut the channel fresh.
      const near = nearestOnRiver(x, z);
      if (near.dist > BANK_HALF) {
        delta[i] = priorDelta[i]!;
        continue;
      }
      delta[i] = 0;

      const w = falloff(near.dist, CHANNEL_HALF, BANK_HALF);
      // The delta was just zeroed, so the ground here is the bare base.
      const ground = base.heights[i]!;
      const bedTarget = near.level - near.bed;
      // Only ever cut down. A river that filled a hollow to reach its bed
      // would dam the valley it is supposed to drain.
      if (bedTarget < ground) {
        const cut = (ground - bedTarget) * w;
        delta[i] = Math.round(-cut * HEIGHT_DELTA_SCALE);
        carved += 1;
      }

      // Water fills the channel out to where the bank rises above the
      // surface, so the waterline lands on the geometry rather than at a
      // fixed radius.
      const newGround = base.heights[i]! + delta[i]! / HEIGHT_DELTA_SCALE;
      if (newGround < near.level) {
        level[i] = Math.round(near.level * WATER_LEVEL_SCALE);
        // Fastest in the middle, still at the edges - the shallows are where
        // you recover, so they should not shove you.
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
  return { doc, carved, wet };
}
