// Keyboard + touch -> PlayerInput. Polled each frame from main loop.

import {
  BUTTON_FRONT_LOCKER,
  BUTTON_RANGE,
  BUTTON_REAR_LOCKER,
  BUTTON_RESET,
  BUTTON_STARTER,
  type ManualGear,
  type PlayerInput,
  type TransferCaseMode,
} from '@mydrunner/shared';

import { getTouchState } from './touchInput.js';

const KEYS = new Set<string>();
/** Handbrake is a toggle: each fresh Space press flips it. The keyboard
 *  no longer reports "Space is held" - it reports "the handbrake state
 *  is currently on / off". */
let handbrakeOn = false;
let manualGear: ManualGear | null = null;
let pendingTransferCase: TransferCaseMode | null = null;
let drivetrainControlsEnabled = true;

/** Disable all transfer/locker input sources for fixed-drivetrain vehicles. */
export function setDrivetrainControlsEnabled(enabled: boolean): void {
  drivetrainControlsEnabled = enabled;
  if (!enabled) pendingTransferCase = null;
}

/** Select a physical gear, or return control to the automatic gearbox. */
export function setManualGear(gear: ManualGear | null): void {
  manualGear = gear;
}

export function getManualGear(): ManualGear | null {
  return manualGear;
}

/** Queue one transfer-case movement for the next fixed simulation tick. */
export function requestTransferCase(mode: TransferCaseMode): void {
  if (drivetrainControlsEnabled) pendingTransferCase = mode;
}

/** True when a key event is destined for a text field, so game bindings
 *  must keep their hands off it.
 *
 *  Without this the window-level handler below preventDefault()s W/A/S/D/R
 *  and Space for EVERY keydown, including ones targeting the join screen's
 *  driver-name input - cancelling keydown cancels the text insertion, so
 *  those six characters silently never appeared. Space was worse: it also
 *  flipped the handbrake toggle, so a name with a space in it spawned you
 *  with the handbrake on.
 *
 *  Checks tagName rather than `instanceof HTMLInputElement` so it still
 *  works for targets from another realm (iframe / portal), where
 *  instanceof against this window's constructors is false. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { tagName?: unknown }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function initInput(): void {
  window.addEventListener('keydown', (e) => {
    if (isTextEntry(e.target)) return;
    KEYS.add(e.code);
    if (e.code === 'Space' && !e.repeat) handbrakeOn = !handbrakeOn;
    // Prevent page scroll for game keys.
    if (
      e.code === 'Space' ||
      e.code.startsWith('Arrow') ||
      ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyV', 'KeyZ', 'KeyX'].includes(e.code)
    ) {
      e.preventDefault();
    }
  });
  // No isTextEntry guard on keyup: a key pressed on the canvas and
  // released after focus moved into a text field must still be cleared,
  // or it sticks down forever.
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

/** Current handbrake-toggle state (keyboard). The HUD shows it because a
 *  toggle with no indicator reads as "the truck is mysteriously stuck". */
export function isHandbrakeOn(): boolean {
  return handbrakeOn;
}

let seq = 0;

export function sampleInput(): PlayerInput {
  seq += 1;
  const t = getTouchState();
  const keyboardReverse = KEYS.has('KeyS') || KEYS.has('ArrowDown');
  const fwd = (KEYS.has('KeyW') || KEYS.has('ArrowUp') ? 1 : 0)
            + (manualGear === null && keyboardReverse ? -1 : 0);
  const turn = (KEYS.has('KeyD') || KEYS.has('ArrowRight') ? 1 : 0)
             + (KEYS.has('KeyA') || KEYS.has('ArrowLeft') ? -1 : 0);
  // Touch wins when keyboard is idle; otherwise the larger-magnitude wins so
  // a player using a keyboard with a touchscreen still gets full deflection.
  const throttle = Math.abs(t.throttle - t.brake) > Math.abs(fwd) ? t.throttle - t.brake : fwd;
  const steer = Math.abs(t.steer) > Math.abs(turn) ? t.steer : turn;
  // Once the lever supplies direction, S / ArrowDown becomes the natural
  // brake binding instead of an automatic request for reverse.
  const kbBrake = KEYS.has('ShiftLeft') || KEYS.has('ShiftRight')
    || (manualGear !== null && keyboardReverse) ? 1 : 0;
  const kbHandbrake = handbrakeOn ? 1 : 0;
  const reset = KEYS.has('KeyR') || t.reset > 0;
  const starter = KEYS.has('KeyE') || t.starter > 0;
  const range = drivetrainControlsEnabled && (KEYS.has('KeyV') || t.range > 0);
  const rearLocker = drivetrainControlsEnabled && (KEYS.has('KeyZ') || t.rearLocker > 0);
  const frontLocker = drivetrainControlsEnabled && (KEYS.has('KeyX') || t.frontLocker > 0);
  const transferCase = drivetrainControlsEnabled ? pendingTransferCase : null;
  pendingTransferCase = null;
  return {
    seq,
    throttle,
    steer,
    brake: Math.max(kbBrake, t.brake),
    handbrake: Math.max(kbHandbrake, t.handbrake),
    manualGear,
    transferCase,
    buttons: (reset ? BUTTON_RESET : 0)
      | (starter ? BUTTON_STARTER : 0)
      | (range ? BUTTON_RANGE : 0)
      | (rearLocker ? BUTTON_REAR_LOCKER : 0)
      | (frontLocker ? BUTTON_FRONT_LOCKER : 0),
  };
}
