import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clientToNdc, wireCanvasPointerControls } from '../canvasControls.js';

function pointer(type: string, init: MouseEventInit & { pointerId?: number } = {}): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  return event as PointerEvent;
}

describe('canvas pointer controls', () => {
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    canvas.setPointerCapture = vi.fn();
    canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON() {} });
  });

  it('converts client coordinates relative to an offset canvas', () => {
    expect(clientToNdc(canvas, 100, 50).toArray()).toEqual([-1, 1]);
    expect(clientToNdc(canvas, 300, 150).toArray()).toEqual([0, 0]);
    expect(clientToNdc(canvas, 500, 250).toArray()).toEqual([1, -1]);
  });

  it('routes selection coordinates and primary clicks without dragging the camera', () => {
    const winch = { isTargeting: () => true, pointerMove: vi.fn(() => true), primaryClick: vi.fn(() => true) };
    const camera = { begin: vi.fn(), drag: vi.fn(), end: vi.fn() };
    wireCanvasPointerControls(canvas, winch, camera);
    canvas.dispatchEvent(pointer('pointerdown', { clientX: 300, clientY: 150, button: 0 }));
    canvas.dispatchEvent(pointer('pointermove', { clientX: 400, clientY: 100, button: 0 }));
    canvas.dispatchEvent(pointer('pointerup', { clientX: 400, clientY: 100, button: 0 }));
    expect(winch.pointerMove.mock.calls.at(-1)?.[0].toArray()).toEqual([0.5, 0.5]);
    expect(winch.primaryClick.mock.calls[0]?.[0].toArray()).toEqual([0.5, 0.5]);
    expect(camera.begin).not.toHaveBeenCalled();
    expect(camera.drag).not.toHaveBeenCalled();
  });

  it('uses a threshold before inactive winch input becomes a camera drag', () => {
    const winch = { isTargeting: () => false, pointerMove: vi.fn(), primaryClick: vi.fn() };
    const camera = { begin: vi.fn(), drag: vi.fn(), end: vi.fn() };
    wireCanvasPointerControls(canvas, winch, camera);
    canvas.dispatchEvent(pointer('pointerdown', { clientX: 200, clientY: 100, button: 0 }));
    canvas.dispatchEvent(pointer('pointermove', { clientX: 203, clientY: 102 }));
    expect(camera.begin).not.toHaveBeenCalled();
    canvas.dispatchEvent(pointer('pointermove', { clientX: 208, clientY: 100 }));
    expect(camera.begin).toHaveBeenCalledOnce();
    expect(camera.drag).toHaveBeenCalledOnce();
  });
});
