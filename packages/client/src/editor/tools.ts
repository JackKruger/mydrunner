// What the pointer does, and the settings behind it.
//
// Separated from the UI so the panel is a view over this state rather
// than the place the state lives — the keyboard shortcuts and the panel
// both write here, and only one of them can be the source of truth.

import { Maps, Physics } from '@mydrunner/shared';
import type { SculptMode } from './editSession.js';

export type ToolId =
  SculptMode | 'paint' | 'water' | 'object' | 'spawn' | 'marker' | 'delete';

/** What the water brush does with a drag.
 *  - raise: flood to `waterDepth` above the ground at the stroke centre
 *  - erase: dry the cells out
 *  - flow:  stamp the drag direction into the velocity field */
export type WaterMode = 'raise' | 'erase' | 'flow';
export type DeleteMode = 'single' | 'radius';
export type ObjectPlacementMode = 'ground' | 'offset' | 'absolute';

export interface ToolState {
  tool: ToolId;
  radius: number;
  strength: number;
  hardness: number;
  surface: Physics.Surface;
  objectKind: Physics.ObstacleKind;
  objectSize: number;
  objectHeight: number;
  /** Run along the object's local +X. Only written into the document for
   *  kinds that use it — but held for every kind so switching back and
   *  forth doesn't lose the value you dialled in. */
  objectLength: number;
  /** Facing of the next object placed, in radians. Objects used to get
   *  `Math.random()` at placement time, which made the ghost a lie: you
   *  aimed one thing and got another. */
  objectYaw: number;
  /** How the next object's base/origin is resolved vertically. */
  objectPlacementMode: ObjectPlacementMode;
  /** Metres above (or below, when negative) the terrain under the object. */
  objectYOffset: number;
  /** Fixed world-space Y of the object's base/origin. */
  objectWorldY: number;
  /** Facing written onto the next spawn point placed, in radians. */
  spawnYaw: number;
  markerKind: Maps.MarkerKind;
  /** Trigger radius of the next marker, in metres. For a garage bay this
   *  also sizes the painted bay: the box and the volume you have to be
   *  inside are the same number, so they cannot drift apart. */
  markerRadius: number;
  /** Parked facing for kinds whose `usesYaw` is set, in radians. */
  markerYaw: number;
  /** Blank means "number one from the kind's prefix" — the common case,
   *  and the reason placing three bays does not need three trips to a
   *  text field. */
  markerLabel: string;
  waterMode: WaterMode;
  /** Metres of water the raise mode floods to, above the ground under
   *  the stroke centre. */
  waterDepth: number;
  /** Metres per second written by the flow mode and the auto-flow button. */
  waterSpeed: number;
  /** Single picks one object under the pointer (or one nearby spawn).
   *  Radius clears every object and spawn inside the brush ring. */
  deleteMode: DeleteMode;
}

export function defaultToolState(): ToolState {
  return {
    tool: 'raise',
    radius: 12,
    // Metres per second of held brush. 6 built a 6 m wall out of a
    // one-second drag, which is past the point where you can steer the
    // result; 2.5 lets a slope be worked up over a few passes.
    strength: 2.5,
    hardness: 0.35,
    surface: Physics.Surface.Dirt,
    objectKind: 'rock',
    objectSize: Physics.objectInfo('rock').defaults.size,
    objectHeight: Physics.objectInfo('rock').defaults.height,
    objectLength: 3,
    objectYaw: 0,
    objectPlacementMode: 'ground',
    objectYOffset: 0,
    objectWorldY: 0,
    // pi/2 matches Room's road-grid spawn: local +Z rotated onto world +X.
    spawnYaw: Math.PI / 2,
    markerKind: 'garageBay',
    markerRadius: Maps.markerInfo('garageBay').defaultRadius,
    markerYaw: Math.PI / 2,
    markerLabel: '',
    waterMode: 'raise',
    // Just over the Hilux's air intake and well under the Patrol's
    // snorkel, so the default brush authors a crossing that already
    // separates the kinds.
    waterDepth: 0.9,
    waterSpeed: 1.8,
    deleteMode: 'single',
  };
}

/** Resolve the next object's base for both the ghost and the placed record. */
export function objectBaseY(state: ToolState, groundY: number): number {
  switch (state.objectPlacementMode) {
    case 'offset': return groundY + state.objectYOffset;
    case 'absolute': return state.objectWorldY;
    default: return groundY;
  }
}

/** Tools that paint continuously while dragging. The rest act once per
 *  click — dragging the object tool would carpet the map in rocks. */
export function isContinuous(tool: ToolId): boolean {
  return tool === 'raise' || tool === 'lower' || tool === 'smooth'
    || tool === 'flatten' || tool === 'paint' || tool === 'water';
}

export function isSculpt(tool: ToolId): tool is SculptMode {
  return tool === 'raise' || tool === 'lower' || tool === 'smooth' || tool === 'flatten';
}

export const TOOL_KEYS: ReadonlyArray<{ code: string; tool: ToolId; label: string }> = [
  { code: 'Digit1', tool: 'raise', label: 'Raise' },
  { code: 'Digit2', tool: 'lower', label: 'Lower' },
  { code: 'Digit3', tool: 'smooth', label: 'Smooth' },
  { code: 'Digit4', tool: 'flatten', label: 'Flatten' },
  { code: 'Digit5', tool: 'paint', label: 'Paint' },
  { code: 'Digit6', tool: 'object', label: 'Object' },
  { code: 'Digit7', tool: 'spawn', label: 'Spawn' },
  { code: 'Digit8', tool: 'delete', label: 'Delete' },
  { code: 'Digit9', tool: 'water', label: 'Water' },
  { code: 'Digit0', tool: 'marker', label: 'Marker' },
];

/** The radius the brush ring should draw for a tool.
 *
 *  The marker tool's footprint is its own trigger radius, not the shared
 *  brush radius — a ring showing 12 m while the bay you are about to drop
 *  is 1.65 m is worse than no ring at all. */
export function cursorRadius(state: ToolState): number {
  return state.tool === 'marker' ? state.markerRadius : state.radius;
}

/** Surfaces offered by the paint tool.
 *
 *  Derived from SURFACE_INFO rather than listed here, because that table
 *  is the one TypeScript forces to stay complete — a new surface appears
 *  in the palette without anyone remembering to add it. */
export function paintableSurfaces(): Array<{ id: Physics.Surface; label: string }> {
  return Object.entries(Physics.SURFACE_INFO)
    .map(([id, info]) => ({ id: Number(id) as Physics.Surface, label: info.label }))
    .sort((a, b) => a.id - b.id);
}

/** Kinds offered by the object tool, grouped for the palette.
 *
 *  Derived from OBJECT_INFO for the same reason paintableSurfaces derives
 *  from SURFACE_INFO: the hand-written copy that used to live here was one
 *  of three, and the compiler checked none of them. */
export function placeableKinds(): ReturnType<typeof Physics.objectKindsByGroup> {
  return Physics.objectKindsByGroup();
}

/** Kinds offered by the marker tool.
 *
 *  Derived from MARKER_INFO for the same reason the surface and object
 *  palettes derive from their tables: a hand-written copy here is a list
 *  the compiler does not check. */
export function placeableMarkerKinds(): Array<{ kind: Maps.MarkerKind; label: string }> {
  return Maps.MARKER_KINDS.map((kind) => ({ kind, label: Maps.markerInfo(kind).label }));
}

/** Reseed the marker radius from the kind, and drop a label typed for the
 *  previous kind — "Workshop bay" on a checkpoint is worse than blank. */
export function applyMarkerKindDefaults(state: ToolState, kind: Maps.MarkerKind): void {
  state.markerKind = kind;
  state.markerRadius = Maps.markerInfo(kind).defaultRadius;
  state.markerLabel = '';
}

/** Seed the size/height/length sliders from the kind's own defaults.
 *
 *  Replaces a single global 1.6 / 2 that sized every kind alike — which
 *  made placing a flagpole produce a 1.6 m-radius pole. */
export function applyKindDefaults(state: ToolState, kind: Physics.ObstacleKind): void {
  const info = Physics.objectInfo(kind);
  state.objectKind = kind;
  state.objectSize = info.defaults.size;
  state.objectHeight = info.defaults.height;
  state.objectLength = info.defaults.length ?? info.limits.length?.[0] ?? 3;
}

/** Radians per `[` / `]` press or wheel notch. */
export const OBJECT_YAW_STEP = Math.PI / 12;

export function stepYaw(yaw: number, dir: number): number {
  const next = yaw + dir * OBJECT_YAW_STEP;
  // Wrapped to the slider's own range so the panel readout and the ghost
  // never disagree about which way round the object is pointing.
  return Math.atan2(Math.sin(next), Math.cos(next));
}
