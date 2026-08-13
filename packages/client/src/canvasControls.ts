import { Vector2 } from 'three';

/** Convert viewport pointer coordinates into the canvas' normalized device coordinates. */
export function clientToNdc(canvas: Pick<HTMLCanvasElement, 'getBoundingClientRect'>, clientX: number, clientY: number): Vector2 {
  const rect = canvas.getBoundingClientRect();
  return new Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
}

interface WinchPointerControls {
  isTargeting(): boolean;
  pointerMove(ndc: Vector2): boolean;
  primaryClick(ndc: Vector2): boolean;
}

interface CameraPointerControls {
  begin(): void;
  drag(yaw: number, pitch: number): void;
  end(): void;
}

/** Wire canvas input with winch selection taking precedence over camera orbit. */
export function wireCanvasPointerControls(
  canvas: HTMLCanvasElement,
  winch: WinchPointerControls,
  camera: CameraPointerControls,
): void {
  const DRAG_THRESHOLD_PX = 5;
  const PX_PER_RAD = 220;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let dragging = false;
  let winchPointer = false;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.target !== canvas) return;
    if (winch.isTargeting()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      winchPointer = event.button === 0;
      pointerId = event.pointerId;
      winch.pointerMove(clientToNdc(canvas, event.clientX, event.clientY));
      return;
    }
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    startX = lastX = event.clientX;
    startY = lastY = event.clientY;
    dragging = false;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (winch.isTargeting()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      winch.pointerMove(clientToNdc(canvas, event.clientX, event.clientY));
      return;
    }
    if (event.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX) return;
    if (!dragging) {
      dragging = true;
      camera.begin();
      canvas.setPointerCapture(event.pointerId);
    }
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    camera.drag(-dx / PX_PER_RAD, dy / PX_PER_RAD);
  });

  const endPointer = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    if (winchPointer) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'pointerup' && event.button === 0) {
        winch.primaryClick(clientToNdc(canvas, event.clientX, event.clientY));
      }
    } else if (dragging) {
      camera.end();
    }
    pointerId = null;
    dragging = false;
    winchPointer = false;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
}
