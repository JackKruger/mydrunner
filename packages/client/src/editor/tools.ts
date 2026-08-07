// What the pointer does, and the settings behind it.
//
// Separated from the UI so the panel is a view over this state rather
// than the place the state lives — the keyboard shortcuts and the panel
// both write here, and only one of them can be the source of truth.

import { Physics } from '@mydrunner/shared';
import type { SculptMode } from './editSession.js';

export type ToolId = SculptMode | 'paint' | 'water' | 'object' | 'spawn' | 'delete';

/** What the water brush does with a drag.
 *  - raise: flood to `waterDepth` above the ground at the stroke centre
 *  - erase: dry the cells out
 *  - flow:  stamp the drag direction into the velocity field */
export type WaterMode = 'raise' | 'erase' | 'flow';

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
  /** Facing written onto the next spawn point placed, in radians. */
  spawnYaw: number;
  waterMode: WaterMode;
  /** Metres of water the raise mode floods to, above the ground under
   *  the stroke centre. */
  waterDepth: number;
  /** Metres per second written by the flow mode and the auto-flow button. */
  waterSpeed: number;
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
    // pi/2 matches Room's road-grid spawn: local +Z rotated onto world +X.
    spawnYaw: Math.PI / 2,
    waterMode: 'raise',
    // Just over the Hilux's air intake and well under the Patrol's
    // snorkel, so the default brush authors a crossing that already
    // separates the kinds.
    waterDepth: 0.9,
    waterSpeed: 1.8,
  };
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
];

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
