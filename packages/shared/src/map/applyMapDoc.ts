// Compose a map document into everything a world needs.
//
// One function used by the relay, owner client, editor and tests. These
// callers once assembled the map separately: the client regenerated terrain
// from the seed, Obstacles regenerated its own list, and the local physics
// path built another World. That was safe only while all content was purely
// procedural. Authored maps remove that guarantee, so composition has one
// canonical path.

import { TERRAIN } from '../constants.js';
import { fnv1aArray } from '../hash.js';
import {
  generateObstacles, type Obstacle,
} from '../physics/obstacles.js';
import { landmarksFor, type Landmarks } from '../physics/landmarks.js';
import {
  generateTerrain, petrolStationPadFor, sampleHeightBilinear, WATER_NONE,
  type TerrainData,
} from '../physics/terrain.js';
import {
  HEIGHT_DELTA_SCALE, MAP_FORMAT_VERSION, NO_SURFACE_OVERRIDE,
  WATER_FLOW_SCALE, WATER_LEVEL_SCALE, WATER_NONE_CM,
  type MapDoc, type Marker, type PlacedObject, type SpawnPoint,
} from './mapDoc.js';
import {
  decodeInt16Grid, decodeUint8Grid, encodeInt16Grid, encodeUint8Grid,
} from './tileGrid.js';

/** Everything assembled from one document. */
export interface MapWorld {
  doc: MapDoc;
  terrain: TerrainData;
  obstacles: Obstacle[];
  landmarks: Landmarks;
  spawns: SpawnPoint[];
  markers: Marker[];
}

export interface ApplyOptions {
  /** What to do when the generated base no longer matches the checksum
   *  the document's delta was authored against.
   *
   *  'throw' (default) is right for the server and the game: a map that
   *  silently means something different from what was authored is worse
   *  than a map that fails to load. The editor passes 'ignore' so it can
   *  open the document and offer to rebase or bake. */
  onBaseDrift?: 'throw' | 'ignore';
}

export class BaseDriftError extends Error {}

/** Fingerprint of a generated base, for detecting generator drift. */
export function baseChecksumOf(terrain: TerrainData): number {
  return fnv1aArray(terrain.surfaces, fnv1aArray(terrain.heights));
}

export function applyMapDoc(doc: MapDoc, opts: ApplyOptions = {}): MapWorld {
  const terrain = generateTerrain({
    seed: doc.base.seed,
    size: doc.base.size,
    resolution: doc.base.resolution,
    roads: doc.roads.length ? doc.roads : undefined,
    bogs: doc.bogs,
    pad: doc.pad,
  });

  const n = doc.base.resolution;
  const heightDelta = decodeInt16Grid(doc.heightDelta);
  const surfaceOverride = decodeUint8Grid(doc.surfaceOverride, NO_SURFACE_OVERRIDE);

  // Drift only matters if there is something layered on top to
  // reinterpret. A doc with no edits composes to the base whatever the
  // generator does, and a baked doc ignores the generated grids entirely.
  const hasEdits = doc.heightDelta.cells.length > 0 || doc.surfaceOverride.cells.length > 0;
  if (doc.baseChecksum !== 0 && hasEdits && !doc.bake) {
    const actual = baseChecksumOf(terrain);
    if (actual !== doc.baseChecksum && opts.onBaseDrift !== 'ignore') {
      throw new BaseDriftError(
        `map "${doc.id}": the generated base has changed since this map was authored ` +
        `(expected ${doc.baseChecksum}, got ${actual}). Its height edits were cut against ` +
        `the old ground and now mean something different. Rebase or bake the map in the editor.`,
      );
    }
  }

  if (doc.bake) {
    // A baked map replaces the generated grids outright. base.seed/size
    // still matter: mountain and pad specs drive obstacle placement and
    // the hill-climb trail helpers.
    // Written as a loop, not `.map(cm => cm / SCALE)`: TypedArray.map
    // returns the SAME typed array kind, so the division would be
    // truncated straight back to an integer and every baked map would
    // load with its heights rounded to whole metres.
    const cm = decodeInt16Grid(doc.bake.heights);
    for (let i = 0; i < cm.length; i++) terrain.heights[i] = cm[i]! / HEIGHT_DELTA_SCALE;
    terrain.surfaces.set(decodeUint8Grid(doc.bake.surfaces, 0));
  } else {
    for (let i = 0; i < n * n; i++) {
      const d = heightDelta[i]!;
      if (d !== 0) terrain.heights[i] = terrain.heights[i]! + d / HEIGHT_DELTA_SCALE;
      const s = surfaceOverride[i]!;
      if (s !== NO_SURFACE_OVERRIDE) terrain.surfaces[i] = s;
    }
  }

  // Water composes after the bake/delta branch and outside it: it is
  // absolute, not a delta, so a baked map's frozen ground does not make
  // its water any less authored. Levels stay in the same units the
  // heights they will be differenced against are in.
  const waterCm = decodeInt16Grid(doc.water.level, WATER_NONE_CM);
  const flowXCm = decodeInt16Grid(doc.water.flowX);
  const flowZCm = decodeInt16Grid(doc.water.flowZ);
  for (let i = 0; i < n * n; i++) {
    const lvl = waterCm[i]!;
    terrain.waterLevel[i] = lvl === WATER_NONE_CM ? WATER_NONE : lvl / WATER_LEVEL_SCALE;
    terrain.waterFlowX[i] = flowXCm[i]! / WATER_FLOW_SCALE;
    terrain.waterFlowZ[i] = flowZCm[i]! / WATER_FLOW_SCALE;
  }

  const obstacles = generateObstacles(terrain, {
    includeProcedural: doc.objects.includeProcedural,
    removed: doc.objects.removed,
    added: doc.objects.added.map((p) => resolveObject(p, terrain)),
  });

  return {
    doc,
    terrain,
    obstacles,
    landmarks: landmarksFor(terrain),
    spawns: doc.spawns,
    markers: doc.markers,
  };
}

/** Seat an authored object on the composed ground.
 *
 *  Resolved here rather than stored, so sculpting under a rock lifts it
 *  instead of burying it. Uses the same bilinear sample generateObstacles
 *  uses, so authored and generated objects sit identically. */
function resolveObject(p: PlacedObject, terrain: TerrainData): Obstacle {
  return {
    id: p.id,
    kind: p.kind,
    x: p.x,
    y: sampleHeightBilinear(terrain, p.x, p.z) + (p.yOffset ?? 0),
    z: p.z,
    size: p.size,
    height: p.height,
    yaw: p.yaw,
    ...(p.length === undefined ? {} : { length: p.length }),
  };
}

/** The shipped procedural world as a document, with no edits on top.
 *
 *  applyMapDoc(proceduralDoc()) must reproduce generateTerrain() exactly
 *  — that equivalence is what lets the document path replace the old one
 *  without changing the map anyone is driving on. */
export function proceduralDoc(overrides: Partial<MapDoc['base']> = {}): MapDoc {
  const base = {
    seed: overrides.seed ?? TERRAIN.defaultSeed,
    size: overrides.size ?? TERRAIN.defaultSize,
    resolution: overrides.resolution ?? TERRAIN.defaultResolution,
  };
  const n = base.resolution;
  const generated = generateTerrain(base);
  return {
    formatVersion: MAP_FORMAT_VERSION,
    id: 'procedural',
    name: 'Procedural Valley',
    base,
    baseChecksum: baseChecksumOf(generated),
    // Empty means "use the generator's defaults" — spelling the default
    // roads out here would freeze them against future generator changes,
    // which is the opposite of what a procedural document is for.
    roads: [],
    bogs: [...TERRAIN.bogs],
    pad: petrolStationPadFor(base.size),
    heightDelta: encodeInt16Grid(new Int16Array(n * n), n),
    surfaceOverride: encodeUint8Grid(
      new Uint8Array(n * n).fill(NO_SURFACE_OVERRIDE), n, NO_SURFACE_OVERRIDE,
    ),
    water: emptyWater(n),
    objects: { includeProcedural: true, added: [], removed: [] },
    spawns: [],
    markers: [],
  };
}

/** A document's water block with no water in it. The level grid's fill is
 *  the dry sentinel, so all three encode to zero stored tiles. */
export function emptyWater(n: number): MapDoc['water'] {
  return {
    level: encodeInt16Grid(new Int16Array(n * n).fill(WATER_NONE_CM), n, WATER_NONE_CM),
    flowX: encodeInt16Grid(new Int16Array(n * n), n),
    flowZ: encodeInt16Grid(new Int16Array(n * n), n),
  };
}
