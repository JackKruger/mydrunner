// The map document: what a level editor saves and what the server and
// client both load a world from.
//
// Shape is "procedural base + authored edits on top". The base is the
// existing generator, addressed by { seed, size, resolution } plus the
// road / bog / pad data that used to be hardcoded. On top of that sit a
// height delta, a surface override, and object / spawn / marker lists.
//
// The delta form is what makes generator improvements flow into existing
// maps for free, and it is also the format's one real hazard: a delta is
// only meaningful against the base it was authored on. `baseChecksum`
// catches the drift (see applyMapDoc), and `bake` is the escape hatch —
// once a map is finished, freeze the composed grids into the document and
// the generator stops mattering to it forever.

import { isObstacleKind, type ObstacleKind } from '../physics/objectCatalog.js';
import type { Bog, PetrolStationPad, Road, Surface } from '../physics/terrain.js';
import { canonicalStringify, fnv1a32 } from '../hash.js';
import type { TileGrid } from './tileGrid.js';

/** Bumped when the document shape changes incompatibly. decodeMapDoc
 *  refuses anything it does not recognise rather than guessing. */
export const MAP_FORMAT_VERSION = 1;

/** Height deltas are stored in centimetres so the grid can be int16.
 *  ±327 m of range against a 70 m peak, and 1 cm over a 2.5 m cell is a
 *  0.4% grade artifact — below anything the suspension can feel. */
export const HEIGHT_DELTA_SCALE = 100;

/** Sentinel in `surfaceOverride` meaning "leave the generated surface".
 *  Cannot be 0: that is Surface.Road. */
export const NO_SURFACE_OVERRIDE = 0xff;

export interface SpawnPoint {
  x: number;
  z: number;
  yaw: number;
}

export type MarkerKind = 'checkpoint' | 'objective' | 'cargoPickup' | 'cargoDropoff';

export const MARKER_KINDS: readonly MarkerKind[] = [
  'checkpoint', 'objective', 'cargoPickup', 'cargoDropoff',
];

/** Authored gameplay marker. Carried and rendered, not yet simulated —
 *  these are data for the cargo objective on the roadmap. */
export interface Marker {
  id: string;
  kind: MarkerKind;
  x: number;
  y: number;
  z: number;
  radius: number;
  label: string;
}

/** An obstacle as authored.
 *
 *  Deliberately not an `Obstacle`: it stores no absolute `y`. Sculpting
 *  under a placed rock must re-seat it, not leave it floating, so height
 *  is resolved from the *composed* terrain at load time and `yOffset`
 *  carries the author's intent ("2 m up a cliff face") instead. */
export interface PlacedObject {
  id: string;
  kind: ObstacleKind;
  x: number;
  z: number;
  size: number;
  height: number;
  yaw: number;
  /** Run along the object's local +X, before yaw. Meaningful only for kinds
   *  whose `OBJECT_INFO[kind].dims.length` is set — a rock has no run, and
   *  the editor omits the field rather than writing a number that means
   *  nothing but still changes the document's revision hash. */
  length?: number;
  /** Metres above the composed ground. Default 0 = sits on terrain. */
  yOffset?: number;
}

export interface MapDoc {
  formatVersion: number;
  /** Stable identity. Rides on the wire so both sides load the same map. */
  id: string;
  name: string;
  base: { seed: number; size: number; resolution: number };
  /** Fingerprint of the generated base this document's delta was authored
   *  against. Zero means "not recorded" (a freshly built procedural doc). */
  baseChecksum: number;
  roads: Road[];
  bogs: Bog[];
  pad?: PetrolStationPad;
  /** Signed centimetre offsets applied after the generator's layers. */
  heightDelta: TileGrid;
  /** Surface ids, NO_SURFACE_OVERRIDE where the generator wins. */
  surfaceOverride: TileGrid;
  /** Frozen composed grids. When present these REPLACE the generated
   *  ones, and the generator no longer affects this map's terrain. */
  bake?: { heights: TileGrid; surfaces: TileGrid };
  objects: {
    includeProcedural: boolean;
    added: PlacedObject[];
    removed: string[];
  };
  spawns: SpawnPoint[];
  markers: Marker[];
}

/** Content fingerprint. Key order does not affect it, so a hand-edit that
 *  reorders fields is not a different map. This is what the client and
 *  server compare to catch one side shipping a stale bundle. */
export function mapDocRev(doc: MapDoc): number {
  return fnv1a32(canonicalStringify(doc));
}

/** Stable-key JSON, for writing a document to a file. */
export function encodeMapDoc(doc: MapDoc): string {
  return JSON.stringify(JSON.parse(canonicalStringify(doc)), null, 2);
}

// --- Strict decoding -------------------------------------------------
//
// Same posture as decodeClient in net/messages.ts: a document may come
// from a file the user picked, so every field is checked and every
// number must be finite. A malformed map should fail at load with a
// readable reason, not produce a world with NaN heights.

class MapDocError extends Error {}

function fail(path: string, why: string): never {
  throw new MapDocError(`map document: ${path} ${why}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  return v as Record<string, unknown>;
}

function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'must be a string');
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'must be a boolean');
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be an array');
  return v;
}

function tileGrid(v: unknown, path: string, resolution: number): TileGrid {
  const o = obj(v, path);
  const n = num(o.n, `${path}.n`);
  if (n !== resolution) {
    fail(path, `is a ${n}-cell grid but the map is ${resolution} cells; resolution cannot be changed by hand`);
  }
  const cells = arr(o.cells, `${path}.cells`).map((c, i) => {
    const e = obj(c, `${path}.cells[${i}]`);
    return { i: num(e.i, `${path}.cells[${i}].i`), b: str(e.b, `${path}.cells[${i}].b`) };
  });
  return { n, tile: num(o.tile, `${path}.tile`), cells };
}

export function decodeMapDoc(input: unknown): MapDoc {
  const o = obj(input, 'root');

  const formatVersion = num(o.formatVersion, 'formatVersion');
  if (formatVersion !== MAP_FORMAT_VERSION) {
    fail('formatVersion', `is ${formatVersion}, this build reads ${MAP_FORMAT_VERSION}`);
  }

  const base = obj(o.base, 'base');
  const resolution = num(base.resolution, 'base.resolution');
  if (!Number.isInteger(resolution) || resolution < 2) fail('base.resolution', 'must be an integer >= 2');
  const size = num(base.size, 'base.size');
  if (size <= 0) fail('base.size', 'must be positive');

  const objects = obj(o.objects, 'objects');
  const bakeRaw = o.bake === undefined ? undefined : obj(o.bake, 'bake');

  return {
    formatVersion,
    id: str(o.id, 'id'),
    name: str(o.name, 'name'),
    base: { seed: num(base.seed, 'base.seed'), size, resolution },
    baseChecksum: num(o.baseChecksum, 'baseChecksum'),
    roads: arr(o.roads, 'roads').map((r, i) => decodeRoad(r, `roads[${i}]`)),
    bogs: arr(o.bogs, 'bogs').map((b, i) => decodeBog(b, `bogs[${i}]`)),
    pad: o.pad === undefined ? undefined : decodePad(o.pad, 'pad'),
    heightDelta: tileGrid(o.heightDelta, 'heightDelta', resolution),
    surfaceOverride: tileGrid(o.surfaceOverride, 'surfaceOverride', resolution),
    bake: bakeRaw && {
      heights: tileGrid(bakeRaw.heights, 'bake.heights', resolution),
      surfaces: tileGrid(bakeRaw.surfaces, 'bake.surfaces', resolution),
    },
    objects: {
      includeProcedural: bool(objects.includeProcedural, 'objects.includeProcedural'),
      added: arr(objects.added, 'objects.added').map((p, i) => decodePlaced(p, `objects.added[${i}]`)),
      removed: arr(objects.removed, 'objects.removed').map((s, i) => str(s, `objects.removed[${i}]`)),
    },
    spawns: arr(o.spawns, 'spawns').map((s, i) => {
      const e = obj(s, `spawns[${i}]`);
      return {
        x: num(e.x, `spawns[${i}].x`),
        z: num(e.z, `spawns[${i}].z`),
        yaw: num(e.yaw, `spawns[${i}].yaw`),
      };
    }),
    markers: arr(o.markers, 'markers').map((m, i) => decodeMarker(m, `markers[${i}]`)),
  };
}

function decodeRoad(v: unknown, path: string): Road {
  const o = obj(v, path);
  const points = arr(o.points, `${path}.points`).map((p, i) => {
    const e = obj(p, `${path}.points[${i}]`);
    return { x: num(e.x, `${path}.points[${i}].x`), z: num(e.z, `${path}.points[${i}].z`) };
  });
  if (points.length < 2) fail(`${path}.points`, 'needs at least 2 points');
  return {
    points,
    width: num(o.width, `${path}.width`),
    surface: num(o.surface, `${path}.surface`) as Surface,
    shoulderWidth: num(o.shoulderWidth, `${path}.shoulderWidth`),
    gradeIntoTerrain: o.gradeIntoTerrain === undefined
      ? undefined
      : bool(o.gradeIntoTerrain, `${path}.gradeIntoTerrain`),
  };
}

function decodeBog(v: unknown, path: string): Bog {
  const o = obj(v, path);
  return {
    x: num(o.x, `${path}.x`),
    z: num(o.z, `${path}.z`),
    depth: num(o.depth, `${path}.depth`),
    sigma: num(o.sigma, `${path}.sigma`),
  };
}

function decodePad(v: unknown, path: string): PetrolStationPad {
  const o = obj(v, path);
  return {
    cx: num(o.cx, `${path}.cx`),
    cz: num(o.cz, `${path}.cz`),
    halfW: num(o.halfW, `${path}.halfW`),
    halfD: num(o.halfD, `${path}.halfD`),
    wingDelta: num(o.wingDelta, `${path}.wingDelta`),
    fade: num(o.fade, `${path}.fade`),
    yaw: num(o.yaw, `${path}.yaw`),
  };
}

function decodePlaced(v: unknown, path: string): PlacedObject {
  const o = obj(v, path);
  // Validated against the catalog, not a list kept here. The copy that
  // used to live at this line had no compile-time link to the kind union,
  // so a new kind decoded as "not a known obstacle kind" until someone
  // remembered this file existed.
  const kind = str(o.kind, `${path}.kind`);
  if (!isObstacleKind(kind)) fail(`${path}.kind`, `is not a known obstacle kind`);
  return {
    id: str(o.id, `${path}.id`),
    kind,
    x: num(o.x, `${path}.x`),
    z: num(o.z, `${path}.z`),
    size: num(o.size, `${path}.size`),
    height: num(o.height, `${path}.height`),
    yaw: num(o.yaw, `${path}.yaw`),
    length: o.length === undefined ? undefined : num(o.length, `${path}.length`),
    yOffset: o.yOffset === undefined ? undefined : num(o.yOffset, `${path}.yOffset`),
  };
}

function decodeMarker(v: unknown, path: string): Marker {
  const o = obj(v, path);
  const kind = str(o.kind, `${path}.kind`) as MarkerKind;
  if (!MARKER_KINDS.includes(kind)) fail(`${path}.kind`, 'is not a known marker kind');
  return {
    id: str(o.id, `${path}.id`),
    kind,
    x: num(o.x, `${path}.x`),
    y: num(o.y, `${path}.y`),
    z: num(o.z, `${path}.z`),
    radius: num(o.radius, `${path}.radius`),
    label: str(o.label, `${path}.label`),
  };
}
