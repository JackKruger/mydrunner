// What the pointer does, and the settings behind it.
//
// Separated from the UI so the panel is a view over this state rather
// than the place the state lives — the keyboard shortcuts and the panel
// both write here, and only one of them can be the source of truth.

import { Physics } from '@mydrunner/shared';
import type { SculptMode } from './editSession.js';

export type ToolId = SculptMode | 'paint' | 'object' | 'spawn' | 'delete';

export interface ToolState {
  tool: ToolId;
  radius: number;
  strength: number;
  hardness: number;
  surface: Physics.Surface;
  objectKind: Physics.ObstacleKind;
  objectSize: number;
  objectHeight: number;
  /** Facing written onto the next spawn point placed, in radians. */
  spawnYaw: number;
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
    objectSize: 1.6,
    objectHeight: 2,
    // pi/2 matches Room's road-grid spawn: local +Z rotated onto world +X.
    spawnYaw: Math.PI / 2,
  };
}

/** Tools that paint continuously while dragging. The rest act once per
 *  click — dragging the object tool would carpet the map in rocks. */
export function isContinuous(tool: ToolId): boolean {
  return tool === 'raise' || tool === 'lower' || tool === 'smooth'
    || tool === 'flatten' || tool === 'paint';
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

export const OBJECT_KINDS: readonly Physics.ObstacleKind[] = [
  'rock', 'tree', 'pine', 'ramp', 'flagpole',
];
