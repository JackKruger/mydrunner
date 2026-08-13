// Full-screen toggle.
//
// On a phone the browser chrome owns a fifth of a landscape viewport and it
// is the one strip the game cannot draw over, so this is a layout feature
// rather than a nicety — it buys back more screen than every HUD trim
// combined.
//
// Every control registered here reads its state back from `fullscreenchange`
// rather than from its own clicks: the browser leaves fullscreen on its own
// (ESC, a system gesture, a tab switch), and a control that tracked what it
// asked for would then be showing the opposite of what the screen is doing.

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

const controls: HTMLElement[] = [];
let listening = false;

/** False on iPhone Safari, which offers the API on `<video>` only. The
 *  controls are removed rather than left dead, because a button that does
 *  nothing reads as a broken game. */
export function fullscreenSupported(): boolean {
  const root = document.documentElement as FullscreenElement;
  return typeof root.requestFullscreen === 'function'
    || typeof root.webkitRequestFullscreen === 'function';
}

export function isFullscreen(): boolean {
  const doc = document as FullscreenDocument;
  return Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement);
}

export async function setFullscreen(next: boolean): Promise<void> {
  const root = document.documentElement as FullscreenElement;
  const doc = document as FullscreenDocument;
  try {
    if (next) await (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.());
    else await (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
  } catch {
    // A request outside a user gesture, or a platform that advertises the
    // API and then refuses it, rejects here. Nothing to recover: the
    // refresh below leaves every control showing the real state.
  }
  refreshControls();
}

function refreshControls(): void {
  const active = isFullscreen();
  for (const el of controls) {
    if (el instanceof HTMLInputElement) el.checked = active;
    else {
      el.classList.toggle('pressed', active);
      el.setAttribute('aria-pressed', String(active));
    }
  }
}

/** Wire one control — an aux-tray button or a menu checkbox — to the toggle.
 *  Unsupported platforms get the control taken off screen instead. */
export function registerFullscreenControl(el: HTMLElement): void {
  if (!fullscreenSupported()) {
    (el.closest('label') ?? el).remove();
    return;
  }
  controls.push(el);
  if (el instanceof HTMLInputElement) {
    el.addEventListener('change', () => { void setFullscreen(el.checked); });
  } else {
    // pointerdown, matching every other touch control: the synthesized
    // click arrives ~300 ms later on some mobile browsers and by then the
    // gesture that authorises the request has expired.
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      void setFullscreen(!isFullscreen());
    });
    el.addEventListener('contextmenu', (event) => event.preventDefault());
  }
  if (!listening) {
    listening = true;
    document.addEventListener('fullscreenchange', refreshControls);
    document.addEventListener('webkitfullscreenchange', refreshControls);
  }
  refreshControls();
}

/** Bind the aux-tray button. Safe to call before the menu exists — controls
 *  register themselves independently. */
export function initFullscreen(): void {
  const button = document.getElementById('fullscreen-btn');
  if (button) registerFullscreenControl(button);
}
