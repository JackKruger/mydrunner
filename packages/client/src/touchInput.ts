// Touch / on-screen controls. Mirrors the keyboard-derived PlayerInput so
// `sampleInput` can OR-merge them.
//
// Layout (see index.html):
//   - left thumb pad gives an analog steer value in [-1, 1]
//   - right "gas" / "brake" pedals
//   - dedicated handbrake button
//   - aux buttons: cam, reset, mute (edge-triggered events)

type Edge = 'cam' | 'reset' | 'mute' | 'chat';

const state = {
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  reset: 0,
};

const edgeListeners: Record<Edge, Array<() => void>> = {
  cam: [],
  reset: [],
  mute: [],
  chat: [],
};

function fireEdge(name: Edge): void {
  for (const fn of edgeListeners[name]) fn();
}

export function onTouchEdge(name: Edge, fn: () => void): void {
  edgeListeners[name].push(fn);
}

export function getTouchState(): Readonly<typeof state> {
  return state;
}

/** True if the device reports any touch capability. */
function isTouchDevice(): boolean {
  return (
    'ontouchstart' in window ||
    (navigator.maxTouchPoints ?? 0) > 0 ||
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** Bind a button so it sets `state[key]` to 1 while held, 0 on release. */
function bindHoldButton(el: HTMLElement, key: 'throttle' | 'brake' | 'handbrake' | 'reset'): void {
  const press = (e: Event): void => {
    e.preventDefault();
    state[key] = 1;
    el.classList.add('pressed');
  };
  const release = (e: Event): void => {
    e.preventDefault();
    state[key] = 0;
    el.classList.remove('pressed');
  };
  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
  // Block the synthesized click + native focus ring on touch devices.
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** Toggle button: each press flips state[key] between 0 and 1. Used for
 *  the handbrake so the player doesn't have to hold the on-screen
 *  button while driving. */
function bindToggleButton(el: HTMLElement, key: 'handbrake'): void {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    state[key] = state[key] === 1 ? 0 : 1;
    el.classList.toggle('pressed', state[key] === 1);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function bindEdgeButton(el: HTMLElement, name: Edge): void {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.classList.add('pressed');
    fireEdge(name);
  });
  const release = (): void => el.classList.remove('pressed');
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
}

function bindSteerPad(pad: HTMLElement, knob: HTMLElement): void {
  let activeId: number | null = null;
  // Knob displacement is clamped to this radius (px); steer = dx / radius.
  const radius = 60;

  const update = (clientX: number, rect: DOMRect): void => {
    const cx = rect.left + rect.width / 2;
    const dx = clientX - cx;
    const clamped = Math.max(-radius, Math.min(radius, dx));
    state.steer = clamped / radius;
    knob.style.transform = `translateX(${clamped}px)`;
  };

  const reset = (): void => {
    activeId = null;
    state.steer = 0;
    knob.style.transform = '';
    pad.classList.remove('active');
  };

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    activeId = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('active');
    update(e.clientX, pad.getBoundingClientRect());
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activeId) return;
    update(e.clientX, pad.getBoundingClientRect());
  });
  const end = (e: PointerEvent): void => {
    if (e.pointerId !== activeId) return;
    reset();
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
}

/** Wire up the touch UI. Idempotent and safe to call before DOMContentLoaded. */
export function initTouchInput(): void {
  if (isTouchDevice()) document.body.classList.add('touch');

  const pad = document.getElementById('steer-pad');
  const knob = document.getElementById('steer-knob');
  const throttle = document.getElementById('throttle-btn');
  const brake = document.getElementById('brake-btn');
  const handbrake = document.getElementById('handbrake-btn');
  const reset = document.getElementById('reset-btn');
  const cam = document.getElementById('cam-btn');
  const mute = document.getElementById('mute-btn');
  const chat = document.getElementById('chat-btn');

  if (pad && knob) bindSteerPad(pad, knob);
  if (throttle) bindHoldButton(throttle, 'throttle');
  if (brake) bindHoldButton(brake, 'brake');
  if (handbrake) bindToggleButton(handbrake, 'handbrake');
  if (reset) bindHoldButton(reset, 'reset');
  if (cam) bindEdgeButton(cam, 'cam');
  if (mute) bindEdgeButton(mute, 'mute');
  if (chat) bindEdgeButton(chat, 'chat');

  // Stop the page from rubber-banding when the player drags on the controls.
  document.getElementById('touch-controls')?.addEventListener(
    'touchmove',
    (e) => e.preventDefault(),
    { passive: false },
  );
}
