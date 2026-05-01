// Keyboard + touch -> PlayerInput. Polled each frame from main loop.

import type { PlayerInput } from '@mydrunner/shared';

import { getTouchState } from './touchInput.js';

const KEYS = new Set<string>();
/** Handbrake is a toggle: each fresh Space press flips it. The keyboard
 *  no longer reports "Space is held" - it reports "the handbrake state
 *  is currently on / off". */
let handbrakeOn = false;

export function initInput(): void {
  window.addEventListener('keydown', (e) => {
    KEYS.add(e.code);
    if (e.code === 'Space' && !e.repeat) handbrakeOn = !handbrakeOn;
    // Prevent page scroll for game keys.
    if (
      e.code === 'Space' ||
      e.code.startsWith('Arrow') ||
      ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR'].includes(e.code)
    ) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => KEYS.delete(e.code));
  window.addEventListener('blur', () => {
    KEYS.clear();
    // Don't reset the handbrake toggle on focus loss - the player
    // probably didn't mean to release the brake just because they
    // alt-tabbed.
  });
}

/** The chat module calls this when its input opens; we also need to
 *  reset the handbrake-toggle on the same beat (otherwise pressing T
 *  could leave the truck rolling away). Actually no - the toggle is
 *  unaffected by clearing pressed keys; chat clears KEYS only. */

/** Drop any held keys. Called when the chat input opens so the truck
 *  doesn't keep moving from a key the player was holding before they
 *  started typing. */
export function clearKeys(): void {
  KEYS.clear();
}

let seq = 0;

export function sampleInput(): PlayerInput {
  seq += 1;
  const t = getTouchState();
  const fwd = (KEYS.has('KeyW') || KEYS.has('ArrowUp') ? 1 : 0)
            + (KEYS.has('KeyS') || KEYS.has('ArrowDown') ? -1 : 0);
  const turn = (KEYS.has('KeyD') || KEYS.has('ArrowRight') ? 1 : 0)
             + (KEYS.has('KeyA') || KEYS.has('ArrowLeft') ? -1 : 0);
  // Touch wins when keyboard is idle; otherwise the larger-magnitude wins so
  // a player using a keyboard with a touchscreen still gets full deflection.
  const throttle = Math.abs(t.throttle - t.brake) > Math.abs(fwd) ? t.throttle - t.brake : fwd;
  const steer = Math.abs(t.steer) > Math.abs(turn) ? t.steer : turn;
  const kbBrake = KEYS.has('ShiftLeft') || KEYS.has('ShiftRight') ? 1 : 0;
  const kbHandbrake = handbrakeOn ? 1 : 0;
  const kbReset = KEYS.has('KeyR') ? 1 : 0;
  return {
    seq,
    throttle,
    steer,
    brake: Math.max(kbBrake, t.brake),
    handbrake: Math.max(kbHandbrake, t.handbrake),
    buttons: Math.max(kbReset, t.reset),
  };
}
