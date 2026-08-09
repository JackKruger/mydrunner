// Key routing: game bindings must not touch keys aimed at a text field.
//
// initInput() installs a window-level keydown that preventDefault()s the
// game keys. Cancelling keydown also cancels text insertion, so before
// the isTextEntry guard the join screen's driver-name input silently
// swallowed w, a, s, d, r and space - and space additionally flipped the
// handbrake toggle, so a name with a space in it spawned you with the
// handbrake engaged.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  clearKeys,
  initInput,
  isHandbrakeOn,
  requestTransferCase,
  sampleInput,
  setDrivetrainControlsEnabled,
  setManualGear,
} from '../input.js';

beforeAll(() => {
  initInput();
});

function press(code: string, target: EventTarget): boolean {
  const ev = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function release(code: string, target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

function withInput<T>(fn: (el: HTMLInputElement) => T): T {
  const el = document.createElement('input');
  el.type = 'text';
  document.body.appendChild(el);
  try {
    return fn(el);
  } finally {
    el.remove();
  }
}

describe('game keys targeting the page', () => {
  it('includes the H-pattern manual selection in sampled input', () => {
    setManualGear(4);
    expect(sampleInput().manualGear).toBe(4);
    setManualGear(null);
    expect(sampleInput().manualGear).toBeNull();
  });

  it('uses S as the brake when the lever supplies direction', () => {
    setManualGear(2);
    press('KeyS', document.body);
    const input = sampleInput();
    expect(input.throttle).toBe(0);
    expect(input.brake).toBe(1);
    release('KeyS', document.body);
    setManualGear(null);
  });

  it('emits a transfer-case stick selection for one simulation tick', () => {
    requestTransferCase('2h');
    expect(sampleInput().transferCase).toBe('2h');
    expect(sampleInput().transferCase).toBeNull();
  });

  it('suppresses keyboard and direct drivetrain requests for a fixed-RWD car', () => {
    setDrivetrainControlsEnabled(false);
    requestTransferCase('4l');
    press('KeyV', document.body);
    press('KeyZ', document.body);
    press('KeyX', document.body);
    const input = sampleInput();
    expect(input.transferCase).toBeNull();
    expect(input.buttons).toBe(0);
    for (const key of ['KeyV', 'KeyZ', 'KeyX']) release(key, document.body);
    setDrivetrainControlsEnabled(true);
  });

  it('preventDefaults the movement keys and space', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'Space', 'ArrowUp']) {
      expect(press(code, document.body), code).toBe(true);
      release(code, document.body);
    }
    clearKeys();
  });

  it('drives throttle and steer from held keys', () => {
    press('KeyW', document.body);
    press('KeyD', document.body);
    const input = sampleInput();
    expect(input.throttle).toBe(1);
    expect(input.steer).toBe(1);
    release('KeyW', document.body);
    release('KeyD', document.body);
    clearKeys();
  });

  it('toggles the handbrake on space', () => {
    const before = isHandbrakeOn();
    press('Space', document.body);
    expect(isHandbrakeOn()).toBe(!before);
    release('Space', document.body);
    press('Space', document.body);
    expect(isHandbrakeOn()).toBe(before);
    release('Space', document.body);
    clearKeys();
  });
});

describe('keys targeting a text field', () => {
  it('lets the movement keys and space through untouched', () => {
    withInput((el) => {
      for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'Space']) {
        expect(press(code, el), code).toBe(false);
      }
    });
    clearKeys();
  });

  it('does not toggle the handbrake', () => {
    const before = isHandbrakeOn();
    withInput((el) => {
      press('Space', el);
      press('Space', el);
      press('Space', el);
    });
    expect(isHandbrakeOn()).toBe(before);
    clearKeys();
  });

  it('does not feed the truck', () => {
    withInput((el) => {
      press('KeyW', el);
      press('KeyD', el);
      const input = sampleInput();
      expect(input.throttle).toBe(0);
      expect(input.steer).toBe(0);
    });
    clearKeys();
  });

  it('also covers textarea and contenteditable', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    expect(press('KeyW', ta)).toBe(false);
    ta.remove();

    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    // jsdom does not implement isContentEditable from the attribute.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    document.body.appendChild(div);
    expect(press('KeyW', div)).toBe(false);
    div.remove();
    clearKeys();
  });

  it('still clears a key released after focus moved into a field', () => {
    // Press on the page, release while a text field has focus. The keyup
    // listener is deliberately unguarded so the key does not stick down
    // and drive the truck forever.
    press('KeyW', document.body);
    withInput((el) => release('KeyW', el));
    expect(sampleInput().throttle).toBe(0);
    clearKeys();
  });
});
