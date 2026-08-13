// Touch / on-screen controls. Mirrors the keyboard-derived PlayerInput so
// `sampleInput` can OR-merge them.
//
// Layout (see index.html):
//   - left thumb pad gives an analog steer value in [-1, 1]
//   - right "gas" / "brake" pedals
//   - dedicated handbrake button
//   - aux buttons: cam, reset, mute (edge-triggered events)
//   - starter, held to crank a flooded engine back to life
//
// The aux buttons are split into a trail group that is always on screen and a
// pit group behind `#aux-more-btn`. That split is a layout decision, but it is
// bound here because this module already owns every control in the tray —
// every control that feeds `PlayerInput`, at least: the pit group's
// full-screen button is a viewport control and lives in `fullscreen.ts`.

type Edge = 'cam' | 'reset' | 'mute' | 'chat' | 'winch';

const state = {
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  reset: 0,
  starter: 0,
  range: 0,
  rearLocker: 0,
  frontLocker: 0,
  airDown: 0,
  inflate: 0,
  winchIn: 0,
  winchOut: 0,
};

const edgeListeners: Record<Edge, Array<() => void>> = {
  cam: [],
  reset: [],
  mute: [],
  chat: [],
  winch: [],
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
function bindHoldButton(
  el: HTMLElement,
  key: 'throttle' | 'brake' | 'handbrake' | 'reset' | 'starter' | 'range' | 'rearLocker' | 'frontLocker' | 'airDown' | 'inflate' | 'winchIn' | 'winchOut',
): void {
  const press = (e: Event): void => {
    e.preventDefault();
    state[key] = 1;
    el.classList.add('pressed');
    el.setAttribute('aria-pressed', 'true');
  };
  const release = (e: Event): void => {
    e.preventDefault();
    state[key] = 0;
    el.classList.remove('pressed');
    el.setAttribute('aria-pressed', 'false');
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
    el.setAttribute('aria-pressed', String(state[key] === 1));
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

/** Expand / collapse the pit half of the aux tray. Pure UI state: it feeds no
 *  `PlayerInput` field, so it never touches `state`. */
function bindTrayToggle(el: HTMLElement, tray: HTMLElement): void {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const open = tray.classList.toggle('open');
    el.classList.toggle('pressed', open);
    el.setAttribute('aria-expanded', String(open));
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function bindEdgeButton(el: HTMLElement, name: Edge): void {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.classList.add('pressed');
    el.setAttribute('aria-pressed', 'true');
    fireEdge(name);
  });
  const release = (): void => {
    el.classList.remove('pressed');
    el.setAttribute('aria-pressed', 'false');
  };
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
    pad.setAttribute('aria-valuenow', String(Math.round(state.steer * 100)));
  };

  const reset = (): void => {
    activeId = null;
    state.steer = 0;
    knob.style.transform = '';
    pad.classList.remove('active');
    pad.setAttribute('aria-valuenow', '0');
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
  const starter = document.getElementById('starter-btn');
  const range = document.getElementById('range-btn');
  const rearLocker = document.getElementById('rear-locker-btn');
  const frontLocker = document.getElementById('front-locker-btn');
  const cam = document.getElementById('cam-btn');
  const mute = document.getElementById('mute-btn');
  const chat = document.getElementById('chat-btn');
  const winch = document.getElementById('winch-btn');
  const winchIn = document.getElementById('winch-in-btn');
  const winchOut = document.getElementById('winch-out-btn');
  const airDown = document.getElementById('air-down-btn');
  const inflate = document.getElementById('inflate-btn');
  const tray = document.getElementById('aux-tray');
  const trayToggle = document.getElementById('aux-more-btn');

  if (pad && knob) bindSteerPad(pad, knob);
  if (throttle) bindHoldButton(throttle, 'throttle');
  if (brake) bindHoldButton(brake, 'brake');
  if (handbrake) bindToggleButton(handbrake, 'handbrake');
  if (reset) bindHoldButton(reset, 'reset');
  // Held, not edge-triggered: cranking takes WATER.crankTicks of
  // continuous hold, same as the keyboard binding.
  if (starter) bindHoldButton(starter, 'starter');
  if (range) bindHoldButton(range, 'range');
  if (rearLocker) bindHoldButton(rearLocker, 'rearLocker');
  if (frontLocker) bindHoldButton(frontLocker, 'frontLocker');
  if (airDown) bindHoldButton(airDown, 'airDown');
  if (inflate) bindHoldButton(inflate, 'inflate');
  if (cam) bindEdgeButton(cam, 'cam');
  if (mute) bindEdgeButton(mute, 'mute');
  if (chat) bindEdgeButton(chat, 'chat');
  if (winch) bindEdgeButton(winch, 'winch');
  if (winchIn) bindHoldButton(winchIn, 'winchIn');
  if (winchOut) bindHoldButton(winchOut, 'winchOut');
  if (tray && trayToggle) bindTrayToggle(trayToggle, tray);

  // Stop the page from rubber-banding when the player drags on the controls.
  document.getElementById('touch-controls')?.addEventListener(
    'touchmove',
    (e) => e.preventDefault(),
    { passive: false },
  );
}
