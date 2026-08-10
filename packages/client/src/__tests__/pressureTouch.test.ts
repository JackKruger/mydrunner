import { beforeEach, describe, expect, it } from 'vitest';
import { getTouchState, initTouchInput } from '../touchInput.js';

beforeEach(() => {
  document.body.innerHTML = `
    <div id="touch-controls">
      <button id="air-down-btn"></button>
      <button id="inflate-btn"></button>
    </div>`;
  initTouchInput();
});

function pointer(id: string, type: 'pointerdown' | 'pointerup'): void {
  document.getElementById(id)!.dispatchEvent(new PointerEvent(type, { bubbles: true }));
}

describe('touch tyre pressure holds', () => {
  it('holds and releases air-down independently', () => {
    pointer('air-down-btn', 'pointerdown');
    expect(getTouchState().airDown).toBe(1);
    expect(getTouchState().inflate).toBe(0);
    pointer('air-down-btn', 'pointerup');
    expect(getTouchState().airDown).toBe(0);
  });

  it('holds and releases inflation independently', () => {
    pointer('inflate-btn', 'pointerdown');
    expect(getTouchState().inflate).toBe(1);
    expect(getTouchState().airDown).toBe(0);
    pointer('inflate-btn', 'pointerup');
    expect(getTouchState().inflate).toBe(0);
  });
});
