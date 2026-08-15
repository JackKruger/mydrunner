// The brake pedal and the reverse request are the same physical control.
//
// The touch UI ships two pedals and no reverse control, so `sampleInput`
// synthesises reverse from the brake pedal (`t.throttle - t.brake`). It used
// to *also* report that press as a full service brake, which deadlocked the
// truck: the brake locked all four wheels while the gearbox sat in reverse at
// full torque, so it never moved and the tacho parked at its stall target for
// as long as the pedal was held. Reverse was unreachable on mobile. Shift+S
// produced the identical pair on the keyboard.
//
// The resolution is the one a driver makes: brake until stopped, then let the
// selected gear pull away. These tests pin both halves of that handoff, and
// that the two commands are never issued together again.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearKeys, initInput, sampleInput, setForwardSpeed, setManualGear } from '../input.js';
import { getTouchState, initTouchInput } from '../touchInput.js';

beforeAll(() => {
  initInput();
});

beforeEach(() => {
  document.body.innerHTML = `
    <div id="touch-controls">
      <button class="pedal" id="throttle-btn"></button>
      <button class="pedal" id="brake-btn"></button>
    </div>`;
  initTouchInput();
  // Touch state is module-level and outlives the DOM the last test replaced,
  // so a pedal left down leaks into the next case. The fresh buttons are bound
  // to the same state, so releasing them here zeroes it.
  pedal('throttle-btn', 'pointerup');
  pedal('brake-btn', 'pointerup');
  clearKeys();
  setManualGear(null);
  setForwardSpeed(0);
});

function pedal(id: string, type: 'pointerdown' | 'pointerup'): void {
  document.getElementById(id)!.dispatchEvent(new PointerEvent(type, { bubbles: true }));
}

function key(code: string, type: 'keydown' | 'keyup'): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
}

describe('touch brake pedal', () => {
  it('brakes without asking for reverse while still rolling forward', () => {
    pedal('brake-btn', 'pointerdown');
    setForwardSpeed(8);
    const input = sampleInput();
    expect(getTouchState().brake).toBe(1);
    expect(input.brake).toBe(1);
    expect(input.throttle).toBe(0);
  });

  it('hands off to reverse once the truck has stopped', () => {
    pedal('brake-btn', 'pointerdown');
    setForwardSpeed(0);
    const input = sampleInput();
    expect(input.brake).toBe(0);
    expect(input.throttle).toBe(-1);
  });

  it('stays in reverse once rolling backward', () => {
    pedal('brake-btn', 'pointerdown');
    setForwardSpeed(-6);
    const input = sampleInput();
    expect(input.brake).toBe(0);
    expect(input.throttle).toBe(-1);
  });

  it('never commands a service brake and reverse torque on the same tick', () => {
    pedal('brake-btn', 'pointerdown');
    for (const speed of [20, 5, 1, 0.5, 0.2, 0, -3, -12]) {
      setForwardSpeed(speed);
      const input = sampleInput();
      expect(
        input.brake > 0 && input.throttle < 0,
        `at ${speed} m/s: brake=${input.brake} throttle=${input.throttle}`,
      ).toBe(false);
    }
  });

  it('leaves the gas pedal alone', () => {
    pedal('throttle-btn', 'pointerdown');
    setForwardSpeed(0);
    const input = sampleInput();
    expect(input.throttle).toBe(1);
    expect(input.brake).toBe(0);
  });
});

describe('keyboard brake + reverse', () => {
  it('brakes rather than engaging reverse while rolling forward', () => {
    key('ShiftLeft', 'keydown');
    key('KeyS', 'keydown');
    setForwardSpeed(9);
    const input = sampleInput();
    expect(input.brake).toBe(1);
    expect(input.throttle).toBe(0);
    key('ShiftLeft', 'keyup');
    key('KeyS', 'keyup');
  });

  it('releases the brake for reverse once stopped', () => {
    key('ShiftLeft', 'keydown');
    key('KeyS', 'keydown');
    setForwardSpeed(0);
    const input = sampleInput();
    expect(input.brake).toBe(0);
    expect(input.throttle).toBe(-1);
    key('ShiftLeft', 'keyup');
    key('KeyS', 'keyup');
  });

  it('keeps Shift a plain service brake with no reverse requested', () => {
    key('ShiftLeft', 'keydown');
    setForwardSpeed(0);
    const input = sampleInput();
    expect(input.brake).toBe(1);
    expect(input.throttle).toBe(0);
    key('ShiftLeft', 'keyup');
  });

  it('keeps S a plain brake when the H-pattern lever supplies direction', () => {
    setManualGear(-1);
    key('KeyS', 'keydown');
    setForwardSpeed(0);
    const input = sampleInput();
    // With a lever fitted S is only ever a brake, so there is no reverse
    // request to hand off to and the brake must survive at a standstill.
    expect(input.brake).toBe(1);
    expect(input.throttle).toBe(0);
    key('KeyS', 'keyup');
    setManualGear(null);
  });
});
