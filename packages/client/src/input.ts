// Keyboard -> PlayerInput. Polled each frame from main loop.

import type { PlayerInput } from '@mydrunner/shared';

const KEYS = new Set<string>();

export function initInput(): void {
  window.addEventListener('keydown', (e) => {
    KEYS.add(e.code);
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
  window.addEventListener('blur', () => KEYS.clear());
}

let seq = 0;

export function sampleInput(): PlayerInput {
  seq += 1;
  const fwd = (KEYS.has('KeyW') || KEYS.has('ArrowUp') ? 1 : 0)
            + (KEYS.has('KeyS') || KEYS.has('ArrowDown') ? -1 : 0);
  const turn = (KEYS.has('KeyD') || KEYS.has('ArrowRight') ? 1 : 0)
             + (KEYS.has('KeyA') || KEYS.has('ArrowLeft') ? -1 : 0);
  return {
    seq,
    throttle: fwd,
    steer: turn,
    brake: KEYS.has('ShiftLeft') || KEYS.has('ShiftRight') ? 1 : 0,
    handbrake: KEYS.has('Space') ? 1 : 0,
    buttons: KEYS.has('KeyR') ? 1 : 0,
  };
}

export function isPressed(code: string): boolean {
  return KEYS.has(code);
}
