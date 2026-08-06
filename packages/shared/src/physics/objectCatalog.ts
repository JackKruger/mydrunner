// What a placeable object *is*: one table, keyed by kind.
//
// This is SURFACE_INFO's pattern applied to obstacles. Before it, the five
// kinds were written out by hand in five places — the union here, the
// collider if/else in obstacles.ts, the mesh if/else in the client, the
// decoder's own copy in mapDoc.ts, and the editor's palette — and only the
// first was checked by the compiler. Adding a sixth meant finding the other
// four from memory.
//
// `Obstacle` and `ObstacleKind` live here rather than in obstacles.ts
// because the table has to name them and obstacles.ts has to read the
// table; the other direction is an import cycle. obstacles.ts re-exports
// both, so no downstream import moved.
//
// Nothing in here imports Rapier or three. The table is read by the
// physics collider builder, the client's mesh builders, the document
// decoder and the editor panel alike, and only one of those can afford the
// WASM.

/** Editor grouping. Purely how the palette is organised — physics does not
 *  read it. */
export type ObjectGroup = 'natural' | 'trail' | 'props' | 'markers';

export const OBJECT_GROUP_LABELS: Record<ObjectGroup, string> = {
  natural: 'Natural',
  trail: 'Trail',
  props: 'Props',
  markers: 'Markers',
};

export interface Obstacle {
  /** Stable identity, deterministic for a given terrain. Authored maps
   *  record removals by id, so an id must survive regeneration — it is
   *  derived from the generating pass and the index within it, never from
   *  the obstacle's position (which shifts when the heightfield changes). */
  id: string;
  kind: ObstacleKind;
  x: number;
  y: number;
  z: number;
  /** Per-kind meaning — see OBJECT_INFO[kind].dims, which is the readable
   *  form of what used to be a comment listing four overloads. */
  size: number;
  height: number;
  yaw: number;
  /** Run along the object's local +X, before yaw. Kinds whose `dims.length`
   *  is undefined ignore it. */
  length?: number;
}

/** A collider in the obstacle's local frame: origin at its ground point,
 *  +X along the yaw direction.
 *
 *  The vocabulary is semantic rather than arithmetic — "a post standing
 *  `stand` tall" instead of a capsule half-height — so the table never has
 *  to spell out `(height - 2*size)/2`, and so the three legacy shapes stay
 *  expressible without leaking their derivations into 35 entries. */
export type ColliderPart =
  /** Sphere of `radius`, centre lifted `radius * sink` above the anchor, so
   *  a rock sits part-buried rather than balanced on a point. */
  | { shape: 'boulder'; radius: number; sink: number }
  /** Upright capsule standing `stand` tall from the anchor. */
  | { shape: 'post'; radius: number; stand: number; x?: number; z?: number }
  /** Box. `y` is the base above the anchor unless the entry says otherwise. */
  | { shape: 'box'; hx: number; hy: number; hz: number; x?: number; y: number; z?: number }
  /** Cylinder, axis along a local axis. `y` is the centre above the anchor. */
  | { shape: 'drum'; radius: number; halfLength: number; axis: 'x' | 'y' | 'z';
      x?: number; y: number; z?: number }
  /** The tilted plank: geometry comes from rampTransform, which the client's
   *  ramp mesh also reads so the two cannot disagree. */
  | { shape: 'plank' };

export interface ObjectInfo {
  label: string;
  group: ObjectGroup;
  /** Seeded into the editor's ToolState when the kind changes. Replaces the
   *  single global 1.6 / 2 that sized a traffic cone like a boulder. */
  defaults: { size: number; height: number; length?: number };
  /** Editor slider bounds. */
  limits: { size: [number, number]; height: [number, number]; length?: [number, number] };
  /** What each authored dimension means for this kind. Shown in the panel,
   *  and the only documentation of the overload that is not a comment.
   *  `length: undefined` means the kind ignores it — the editor then omits
   *  it from the document rather than writing a meaningless number. */
  dims: { size: string; height: string; length?: string };
  /** Empty = decorative, no collider at all. */
  colliders(o: Obstacle): ColliderPart[];
  friction: number;
}

// --- The table --------------------------------------------------------
//
// The five kinds below are the shipped world. Their collider geometry is
// frozen: the server and every client's prediction sim build these
// independently from the same map document, so a change here that is not
// matched by a PROTOCOL_VERSION bump desyncs the two silently.
// obstacleColliders.test.ts pins them.

const OBJECT_TABLE = {
  rock: {
    label: 'Rock',
    group: 'natural',
    defaults: { size: 1.6, height: 2 },
    limits: { size: [0.3, 8], height: [0.3, 8] },
    dims: { size: 'radius', height: 'unused' },
    friction: 0.9,
    colliders: (o) => [{ shape: 'boulder', radius: o.size, sink: 0.6 }],
  },

  tree: {
    label: 'Tree',
    group: 'natural',
    defaults: { size: 0.32, height: 7 },
    limits: { size: [0.1, 1.5], height: [2, 20] },
    dims: { size: 'trunk radius', height: 'total height' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  pine: {
    label: 'Pine',
    group: 'natural',
    defaults: { size: 0.45, height: 14 },
    limits: { size: [0.15, 2], height: [4, 30] },
    dims: { size: 'trunk radius', height: 'total height' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  ramp: {
    label: 'Ramp',
    group: 'trail',
    defaults: { size: 1.6, height: 0.6, length: 3 },
    limits: { size: [0.5, 6], height: [0.1, 3], length: [1, 12] },
    dims: { size: 'half-width', height: 'rise of the high edge', length: 'run' },
    friction: 1.0,
    colliders: () => [{ shape: 'plank' }],
  },

  flagpole: {
    label: 'Flagpole',
    group: 'markers',
    defaults: { size: 0.07, height: 8 },
    limits: { size: [0.03, 0.4], height: [2, 20] },
    dims: { size: 'pole radius', height: 'pole height' },
    // A flagpole has never had a collider branch of its own: it fell
    // through to the tree capsule, which at a 0.07 m radius is a thin pole
    // and reads correctly. Kept deliberately — the obvious "fix" of giving
    // it a real cylinder would move the shipped world's physics and force a
    // PROTOCOL_VERSION bump for no gameplay gain.
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  // --- Natural -------------------------------------------------------

  boulder: {
    label: 'Boulder',
    group: 'natural',
    defaults: { size: 2.6, height: 3 },
    limits: { size: [1, 12], height: [1, 12] },
    dims: { size: 'radius', height: 'unused' },
    friction: 0.9,
    colliders: (o) => [{ shape: 'boulder', radius: o.size, sink: 0.55 }],
  },

  deadTree: {
    label: 'Dead tree',
    group: 'natural',
    defaults: { size: 0.3, height: 6 },
    limits: { size: [0.1, 1.2], height: [2, 16] },
    dims: { size: 'trunk radius', height: 'total height' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  stump: {
    label: 'Stump',
    group: 'natural',
    defaults: { size: 0.55, height: 0.8 },
    limits: { size: [0.2, 2], height: [0.2, 2.5] },
    dims: { size: 'radius', height: 'stump height' },
    friction: 0.8,
    colliders: (o) => [
      { shape: 'drum', radius: o.size, halfLength: o.height / 2, axis: 'y', y: o.height / 2 },
    ],
  },

  log: {
    label: 'Log',
    group: 'natural',
    defaults: { size: 0.35, height: 0.7, length: 4 },
    limits: { size: [0.15, 1.2], height: [0.3, 2.4], length: [1, 14] },
    dims: { size: 'radius', height: 'unused', length: 'log length' },
    friction: 0.7,
    colliders: (o) => [
      { shape: 'drum', radius: o.size, halfLength: (o.length ?? 4) / 2, axis: 'x', y: o.size },
    ],
  },

  bush: {
    label: 'Bush',
    group: 'natural',
    defaults: { size: 1.1, height: 1.2 },
    // Scrub you brush through, not a wall. No collider at all: a bush that
    // stops a 4x4 dead is worse than one you can't touch, and a soft
    // collider is not something a static-only obstacle can express.
    limits: { size: [0.4, 3], height: [0.4, 3] },
    dims: { size: 'clump radius', height: 'unused' },
    friction: 0.6,
    colliders: () => [],
  },

  palm: {
    label: 'Palm',
    group: 'natural',
    defaults: { size: 0.26, height: 9 },
    limits: { size: [0.1, 0.8], height: [3, 18] },
    dims: { size: 'trunk radius', height: 'total height' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  rockStep: {
    label: 'Rock step',
    group: 'natural',
    defaults: { size: 1.4, height: 0.7, length: 5 },
    limits: { size: [0.5, 6], height: [0.2, 3], length: [1, 16] },
    dims: { size: 'half-depth', height: 'step height', length: 'width' },
    friction: 0.95,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 5) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  // --- Trail ---------------------------------------------------------

  kicker: {
    label: 'Kicker',
    group: 'trail',
    defaults: { size: 1.6, height: 0.9, length: 4 },
    limits: { size: [0.5, 6], height: [0.2, 3], length: [1, 12] },
    dims: { size: 'half-width', height: 'rise at the lip', length: 'run' },
    friction: 1.0,
    // A wedge is not a primitive, so the drivable face is a thin box tipped
    // along the run. The gap underneath is invisible from a truck and
    // cheaper than a trimesh.
    colliders: (o) => {
      const len = o.length ?? 4;
      return [{
        shape: 'box',
        hx: Math.hypot(len, o.height) / 2, hy: 0.06, hz: o.size,
        y: o.height / 2,
      }];
    },
  },

  tyreStack: {
    label: 'Tyre stack',
    group: 'trail',
    defaults: { size: 0.55, height: 1.4 },
    limits: { size: [0.3, 1.5], height: [0.4, 4] },
    dims: { size: 'outer radius', height: 'stack height' },
    friction: 0.85,
    colliders: (o) => [
      { shape: 'drum', radius: o.size, halfLength: o.height / 2, axis: 'y', y: o.height / 2 },
    ],
  },

  tyreWall: {
    label: 'Tyre wall',
    group: 'trail',
    defaults: { size: 0.4, height: 1.2, length: 6 },
    limits: { size: [0.25, 1], height: [0.5, 4], length: [2, 20] },
    dims: { size: 'half-depth', height: 'wall height', length: 'wall length' },
    friction: 0.85,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 6) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  culvertPipe: {
    label: 'Culvert pipe',
    group: 'trail',
    // Solid, not hollow. Rapier has no tube primitive; the three-box tunnel
    // that would let you drive through reads badly under about 2 m radius
    // and doubles the collider count. This is something you climb over.
    defaults: { size: 0.7, height: 1.4, length: 5 },
    limits: { size: [0.3, 2.5], height: [0.6, 5], length: [1, 16] },
    dims: { size: 'outer radius', height: 'unused', length: 'pipe length' },
    friction: 0.7,
    colliders: (o) => [
      { shape: 'drum', radius: o.size, halfLength: (o.length ?? 5) / 2, axis: 'x', y: o.size },
    ],
  },

  concreteBlock: {
    label: 'Concrete block',
    group: 'trail',
    defaults: { size: 0.5, height: 0.8, length: 2 },
    limits: { size: [0.2, 2], height: [0.2, 3], length: [0.5, 6] },
    dims: { size: 'half-depth', height: 'height', length: 'length' },
    friction: 0.9,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 2) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  jerseyBarrier: {
    label: 'Jersey barrier',
    group: 'trail',
    defaults: { size: 0.32, height: 0.9, length: 3 },
    limits: { size: [0.2, 0.8], height: [0.4, 1.6], length: [1, 8] },
    dims: { size: 'half-depth at base', height: 'height', length: 'length' },
    friction: 0.9,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 3) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  plankBridge: {
    label: 'Plank bridge',
    group: 'trail',
    defaults: { size: 1.2, height: 0.5, length: 6 },
    limits: { size: [0.6, 4], height: [0.1, 3], length: [2, 20] },
    dims: { size: 'half-width', height: 'deck height', length: 'span' },
    // Static, like everything else here. A teeter that actually pivots
    // needs a dynamic body and a revolute joint, which is a different
    // feature with its own wire state — not something Obstacle can carry.
    friction: 0.95,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 6) / 2, hy: 0.06, hz: o.size, y: o.height },
    ],
  },

  logCrossing: {
    label: 'Log crossing',
    group: 'trail',
    defaults: { size: 0.32, height: 0.7, length: 5 },
    limits: { size: [0.15, 0.8], height: [0.3, 2], length: [2, 14] },
    dims: { size: 'log radius', height: 'unused', length: 'log length' },
    friction: 0.75,
    colliders: (o) => {
      const half = (o.length ?? 5) / 2;
      return [-1, 0, 1].map((i) => ({
        shape: 'drum' as const,
        radius: o.size, halfLength: half, axis: 'x' as const,
        y: o.size, z: i * o.size * 2.1,
      }));
    },
  },

  cattleGrid: {
    label: 'Cattle grid',
    group: 'trail',
    defaults: { size: 1.5, height: 0.25, length: 3 },
    limits: { size: [0.6, 4], height: [0.1, 0.8], length: [1, 8] },
    dims: { size: 'half-width', height: 'rail height', length: 'run' },
    friction: 0.8,
    colliders: (o) => [
      // One flat slab: the bars are a visual. A collider per bar would let
      // a wheel drop between them, which is realistic and miserable.
      { shape: 'box', hx: (o.length ?? 3) / 2, hy: 0.05, hz: o.size, y: o.height },
    ],
  },

  // --- Props ---------------------------------------------------------

  barrel: {
    label: 'Barrel',
    group: 'props',
    defaults: { size: 0.3, height: 0.9 },
    limits: { size: [0.15, 0.8], height: [0.3, 2] },
    dims: { size: 'radius', height: 'height' },
    friction: 0.7,
    colliders: (o) => [
      { shape: 'drum', radius: o.size, halfLength: o.height / 2, axis: 'y', y: o.height / 2 },
    ],
  },

  crate: {
    label: 'Crate',
    group: 'props',
    defaults: { size: 0.5, height: 0.9, length: 1 },
    limits: { size: [0.2, 2], height: [0.2, 3], length: [0.3, 4] },
    dims: { size: 'half-width', height: 'height', length: 'length' },
    friction: 0.75,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 1) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  pallet: {
    label: 'Pallet',
    group: 'props',
    defaults: { size: 0.6, height: 0.14, length: 1.2 },
    limits: { size: [0.3, 1.5], height: [0.08, 0.4], length: [0.5, 3] },
    dims: { size: 'half-width', height: 'thickness', length: 'length' },
    friction: 0.8,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 1.2) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  hayBale: {
    label: 'Hay bale',
    group: 'props',
    defaults: { size: 0.7, height: 1.4, length: 1.4 },
    limits: { size: [0.3, 1.5], height: [0.5, 3], length: [0.5, 3] },
    dims: { size: 'radius', height: 'unused', length: 'bale width' },
    friction: 0.8,
    colliders: (o) => [
      { shape: 'drum', radius: o.size, halfLength: (o.length ?? 1.4) / 2, axis: 'x', y: o.size },
    ],
  },

  trafficCone: {
    label: 'Traffic cone',
    group: 'props',
    defaults: { size: 0.22, height: 0.7 },
    limits: { size: [0.1, 0.5], height: [0.2, 1.2] },
    dims: { size: 'base radius', height: 'height' },
    friction: 0.6,
    colliders: (o) => [
      { shape: 'drum', radius: o.size * 0.5, halfLength: o.height / 2, axis: 'y', y: o.height / 2 },
    ],
  },

  bollard: {
    label: 'Bollard',
    group: 'props',
    defaults: { size: 0.09, height: 1 },
    limits: { size: [0.05, 0.3], height: [0.4, 2] },
    dims: { size: 'radius', height: 'height' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  fencePost: {
    label: 'Fence post',
    group: 'props',
    defaults: { size: 0.08, height: 1.3 },
    limits: { size: [0.04, 0.3], height: [0.4, 3] },
    dims: { size: 'half-width', height: 'height' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  fenceRun: {
    label: 'Fence run',
    group: 'props',
    defaults: { size: 0.08, height: 1.3, length: 8 },
    limits: { size: [0.04, 0.3], height: [0.4, 3], length: [2, 30] },
    dims: { size: 'post half-width', height: 'fence height', length: 'run' },
    friction: 0.6,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 8) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  gate: {
    label: 'Gate',
    group: 'props',
    defaults: { size: 0.1, height: 1.4, length: 3.5 },
    limits: { size: [0.05, 0.3], height: [0.6, 3], length: [1, 8] },
    dims: { size: 'post radius', height: 'gate height', length: 'gate width' },
    friction: 0.6,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 3.5) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  signpost: {
    label: 'Signpost',
    group: 'props',
    defaults: { size: 0.06, height: 2.2, length: 1.2 },
    limits: { size: [0.03, 0.2], height: [0.8, 5], length: [0.4, 3] },
    dims: { size: 'post radius', height: 'total height', length: 'panel width' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  telegraphPole: {
    label: 'Telegraph pole',
    group: 'props',
    defaults: { size: 0.16, height: 8 },
    limits: { size: [0.08, 0.5], height: [3, 16] },
    dims: { size: 'pole radius', height: 'total height' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  windSock: {
    label: 'Wind sock',
    group: 'markers',
    defaults: { size: 0.07, height: 4 },
    limits: { size: [0.03, 0.25], height: [1.5, 10] },
    dims: { size: 'pole radius', height: 'pole height' },
    friction: 0.6,
    colliders: (o) => [{ shape: 'post', radius: o.size, stand: o.height }],
  },

  campfire: {
    label: 'Campfire',
    group: 'markers',
    defaults: { size: 0.8, height: 0.3 },
    limits: { size: [0.3, 2], height: [0.1, 1] },
    dims: { size: 'ring radius', height: 'unused' },
    // Decoration. Driving through a fire ring should scatter it, and since
    // it cannot, a collider would just be an invisible kerb.
    friction: 0.6,
    colliders: () => [],
  },

  picnicTable: {
    label: 'Picnic table',
    group: 'props',
    defaults: { size: 0.4, height: 0.75, length: 2 },
    limits: { size: [0.25, 1], height: [0.4, 1.2], length: [1, 4] },
    dims: { size: 'half-width', height: 'table height', length: 'length' },
    friction: 0.7,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 2) / 2, hy: 0.06, hz: o.size * 1.4, y: o.height },
    ],
  },

  wreckCar: {
    label: 'Wrecked car',
    group: 'props',
    defaults: { size: 0.85, height: 1.4, length: 4 },
    limits: { size: [0.5, 1.6], height: [0.6, 2.5], length: [2, 7] },
    dims: { size: 'half-width', height: 'body height', length: 'length' },
    friction: 0.7,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 4) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  // --- Structures ----------------------------------------------------

  shippingContainer: {
    label: 'Shipping container',
    group: 'props',
    defaults: { size: 1.2, height: 2.6, length: 6 },
    limits: { size: [0.6, 2], height: [1, 4], length: [2, 14] },
    dims: { size: 'half-width', height: 'height', length: 'length' },
    friction: 0.7,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 6) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
    ],
  },

  waterTank: {
    label: 'Water tank',
    group: 'props',
    defaults: { size: 1.6, height: 3 },
    limits: { size: [0.6, 4], height: [1, 8] },
    dims: { size: 'radius', height: 'tank height' },
    friction: 0.7,
    colliders: (o) => [
      { shape: 'drum', radius: o.size, halfLength: o.height / 2, axis: 'y', y: o.height / 2 },
    ],
  },

  shed: {
    label: 'Shed',
    group: 'props',
    defaults: { size: 1.5, height: 2.4, length: 4 },
    limits: { size: [0.8, 5], height: [1.5, 6], length: [1.5, 12] },
    dims: { size: 'half-depth', height: 'eave height', length: 'width' },
    friction: 0.7,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 4) / 2, hy: o.height / 2, hz: o.size, y: o.height / 2 },
      // The roof, so you cannot drive up the pitch and sit on the ridge.
      { shape: 'box', hx: (o.length ?? 4) / 2, hy: o.height * 0.16, hz: o.size,
        y: o.height + o.height * 0.16 },
    ],
  },

  jetty: {
    label: 'Jetty',
    group: 'props',
    defaults: { size: 1.4, height: 0.8, length: 8 },
    limits: { size: [0.6, 4], height: [0.2, 3], length: [2, 24] },
    dims: { size: 'half-width', height: 'deck height', length: 'length' },
    friction: 0.9,
    colliders: (o) => [
      { shape: 'box', hx: (o.length ?? 8) / 2, hy: 0.06, hz: o.size, y: o.height },
    ],
  },
} satisfies Record<string, ObjectInfo>;

export type ObstacleKind = keyof typeof OBJECT_TABLE;

export const OBJECT_INFO: Record<ObstacleKind, ObjectInfo> = OBJECT_TABLE;

/** Every placeable kind. Derived, so nothing hand-copies it — this is the
 *  list the decoder validates against and the editor palette is built from. */
export const OBJECT_KINDS: readonly ObstacleKind[] =
  Object.keys(OBJECT_TABLE) as ObstacleKind[];

export function isObstacleKind(v: string): v is ObstacleKind {
  return Object.prototype.hasOwnProperty.call(OBJECT_TABLE, v);
}

/** Strict lookup. Unlike surfaceInfo's Dirt fallback this throws: a surface
 *  that guesses wrong tints a texel, an obstacle that guesses wrong gives
 *  the server and the prediction sim different collision geometry. */
export function objectInfo(kind: ObstacleKind): ObjectInfo {
  const info = OBJECT_INFO[kind];
  if (!info) throw new Error(`objectInfo: unknown obstacle kind "${String(kind)}"`);
  return info;
}

/** The kinds an editor palette should show, grouped. */
export function objectKindsByGroup(): Array<{
  group: ObjectGroup; label: string; kinds: ObstacleKind[];
}> {
  const groups: ObjectGroup[] = ['natural', 'trail', 'props', 'markers'];
  return groups.map((group) => ({
    group,
    label: OBJECT_GROUP_LABELS[group],
    kinds: OBJECT_KINDS.filter((k) => OBJECT_INFO[k].group === group),
  })).filter((g) => g.kinds.length > 0);
}

// --- Ramp geometry ----------------------------------------------------

// Geometry for a flex ramp: tilted cuboid placed so the low long edge
// rests on the ground at the obstacle's y and the opposite long edge sits
// `rise` metres above. Returns the centroid + orientation quaternion the
// renderer also needs, so client visuals stay aligned with the collider
// without re-deriving the math.
const RAMP_HALF_THICK = 0.06;

export function rampTransform(o: Obstacle): {
  cx: number; cy: number; cz: number;
  qx: number; qy: number; qz: number; qw: number;
  halfLength: number; halfWidth: number; halfThick: number;
  tilt: number;
} {
  const halfLength = (o.length ?? 3) / 2;
  const halfWidth = o.size;
  const halfThick = RAMP_HALF_THICK;
  const tilt = Math.atan2(o.height, halfWidth * 2);
  // Lift centroid so the low edge rests on the ground after tilt:
  // bottom-most corner Y = cy - halfWidth*sin(tilt) - halfThick*cos(tilt).
  const cy = o.y + halfWidth * Math.sin(tilt) + halfThick * Math.cos(tilt);
  // Composite quat: yaw (around world Y) then tilt (around local X).
  // Pre-multiplied form: q = q_yaw * q_tilt.
  const sty = Math.sin(o.yaw / 2), cty = Math.cos(o.yaw / 2);
  const sta = Math.sin(tilt / 2), cta = Math.cos(tilt / 2);
  return {
    cx: o.x, cy, cz: o.z,
    qx: cty * sta,
    qy: sty * cta,
    qz: -sty * sta,
    qw: cty * cta,
    halfLength, halfWidth, halfThick, tilt,
  };
}

// --- Resolving a kind to world-space colliders ------------------------

export interface ResolvedCollider {
  shape: 'ball' | 'capsule' | 'cuboid' | 'cylinder';
  /** ball: [r] · capsule: [halfHeight, r] · cuboid: [hx, hy, hz]
   *  · cylinder: [halfHeight, r] — Rapier's own argument orders. */
  args: readonly number[];
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number; w: number };
  friction: number;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 } as const;

function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** Rotate a local-frame offset onto world axes. */
function offset(o: Obstacle, x: number, z: number): { x: number; z: number } {
  if (x === 0 && z === 0) return { x: o.x, z: o.z };
  const s = Math.sin(o.yaw), c = Math.cos(o.yaw);
  return { x: o.x + x * c + z * s, z: o.z - x * s + z * c };
}

/** Obstacle → world-space colliders. Pure, and Rapier-free, so it can be
 *  golden-tested without a physics world and so a future collider-debug
 *  overlay reads the same answer the simulation does. */
export function resolveColliders(o: Obstacle): ResolvedCollider[] {
  const info = objectInfo(o.kind);
  const out: ResolvedCollider[] = [];
  for (const part of info.colliders(o)) {
    switch (part.shape) {
      case 'boulder': {
        // A sphere is yaw-invariant, so the collider carries no rotation.
        // Emitting one would be physically identical and would still churn
        // the golden fingerprint every time a rock's yaw changed.
        out.push({
          shape: 'ball',
          args: [part.radius],
          pos: { x: o.x, y: o.y + part.radius * part.sink, z: o.z },
          rot: IDENTITY,
          friction: info.friction,
        });
        break;
      }
      case 'post': {
        const halfHeight = Math.max(0.1, (part.stand - 2 * part.radius) / 2);
        const p = offset(o, part.x ?? 0, part.z ?? 0);
        // An upright capsule on the anchor is yaw-invariant too; one that
        // is offset still needs the offset rotated, which `offset` did.
        out.push({
          shape: 'capsule',
          args: [halfHeight, part.radius],
          pos: { x: p.x, y: o.y + halfHeight + part.radius, z: p.z },
          rot: IDENTITY,
          friction: info.friction,
        });
        break;
      }
      case 'box': {
        const p = offset(o, part.x ?? 0, part.z ?? 0);
        out.push({
          shape: 'cuboid',
          args: [part.hx, part.hy, part.hz],
          pos: { x: p.x, y: o.y + part.y, z: p.z },
          rot: yawQuat(o.yaw),
          friction: info.friction,
        });
        break;
      }
      case 'drum': {
        const p = offset(o, part.x ?? 0, part.z ?? 0);
        out.push({
          shape: 'cylinder',
          args: [part.halfLength, part.radius],
          pos: { x: p.x, y: o.y + part.y, z: p.z },
          // Rapier cylinders stand on Y. A log lying along local X needs a
          // -90° roll about Z composed under the yaw; along Z, +90° about X.
          rot: part.axis === 'y' ? yawQuat(o.yaw) : lieDown(o.yaw, part.axis),
          friction: info.friction,
        });
        break;
      }
      case 'plank': {
        const t = rampTransform(o);
        out.push({
          shape: 'cuboid',
          args: [t.halfLength, t.halfThick, t.halfWidth],
          pos: { x: t.cx, y: t.cy, z: t.cz },
          rot: { x: t.qx, y: t.qy, z: t.qz, w: t.qw },
          friction: info.friction,
        });
        break;
      }
    }
  }
  return out;
}

/** Yaw ∘ (tip the cylinder axis off Y onto local X or Z). */
function lieDown(yaw: number, axis: 'x' | 'z'): { x: number; y: number; z: number; w: number } {
  const h = Math.SQRT1_2; // sin/cos of 45° — a quarter turn's half-angle
  // Quarter turn that carries +Y onto the target axis.
  const t = axis === 'x'
    ? { x: 0, y: 0, z: -h, w: h }
    : { x: h, y: 0, z: 0, w: h };
  const q = yawQuat(yaw);
  // Hamilton product q * t.
  return {
    x: q.w * t.x + q.x * t.w + q.y * t.z - q.z * t.y,
    y: q.w * t.y - q.x * t.z + q.y * t.w + q.z * t.x,
    z: q.w * t.z + q.x * t.y - q.y * t.x + q.z * t.w,
    w: q.w * t.w - q.x * t.x - q.y * t.y - q.z * t.z,
  };
}
