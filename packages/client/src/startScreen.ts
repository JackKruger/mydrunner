import { normalizeVehicleBuild, type VehicleBuild } from '@mydrunner/shared';
import type { JoinChoice } from './joinScreen.js';

const SAVES_KEY = 'mydrunner.saves.v1';
const OPTIONS_KEY = 'mydrunner.options.v1';

export interface GameSave {
  id: string;
  name: string;
  build: VehicleBuild;
  createdAt: number;
  updatedAt: number;
}

export interface StartOptions {
  engineAudio: boolean;
  showControlGuide: boolean;
}

export type StartChoice =
  | { type: 'play'; save: GameSave }
  | { type: 'new' };

const DEFAULT_OPTIONS: StartOptions = {
  // The procedural engine synth has historically started muted.
  engineAudio: false,
  showControlGuide: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeSave(value: unknown): GameSave | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (typeof value.name !== 'string' || !value.name.trim()) return null;
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt;
  try {
    return {
      id: value.id,
      name: value.name.trim().slice(0, 32),
      build: normalizeVehicleBuild(value.build),
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function persistSaves(saves: GameSave[]): void {
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(saves));
  } catch {
    // Storage can be unavailable in private browsing. The session still works.
  }
}

/** Read all local slots, newest first. A legacy single-player preference is
 * promoted once so existing players get a working Continue button. */
export function loadGameSaves(legacy?: JoinChoice | null): GameSave[] {
  let saves: GameSave[] = [];
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) saves = parsed.map(decodeSave).filter((save): save is GameSave => save !== null);
  } catch {
    saves = [];
  }

  if (saves.length === 0 && legacy) {
    const now = Date.now();
    saves = [{
      id: 'legacy',
      name: legacy.name,
      build: normalizeVehicleBuild(legacy.build),
      createdAt: now,
      updatedAt: now,
    }];
    persistSaves(saves);
  }
  return saves.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createGameSave(choice: JoinChoice): GameSave {
  const now = Date.now();
  const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${now}-${Math.random().toString(36).slice(2)}`;
  const save: GameSave = {
    id: randomPart,
    name: choice.name,
    build: normalizeVehicleBuild(choice.build),
    createdAt: now,
    updatedAt: now,
  };
  persistSaves([save, ...loadGameSaves()]);
  return save;
}

export function updateGameSave(id: string, choice: JoinChoice): GameSave | null {
  const saves = loadGameSaves();
  const save = saves.find((candidate) => candidate.id === id);
  if (!save) return null;
  save.name = choice.name;
  save.build = normalizeVehicleBuild(choice.build);
  save.updatedAt = Date.now();
  persistSaves(saves);
  return save;
}

export function touchGameSave(id: string): GameSave | null {
  const saves = loadGameSaves();
  const save = saves.find((candidate) => candidate.id === id);
  if (!save) return null;
  save.updatedAt = Date.now();
  persistSaves(saves);
  return save;
}

export function deleteGameSave(id: string): GameSave[] {
  const saves = loadGameSaves().filter((save) => save.id !== id);
  persistSaves(saves);
  return saves;
}

export function loadStartOptions(): StartOptions {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}');
    if (!isRecord(parsed)) return { ...DEFAULT_OPTIONS };
    return {
      engineAudio: typeof parsed.engineAudio === 'boolean' ? parsed.engineAudio : DEFAULT_OPTIONS.engineAudio,
      showControlGuide: typeof parsed.showControlGuide === 'boolean'
        ? parsed.showControlGuide
        : DEFAULT_OPTIONS.showControlGuide,
    };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}

export function saveStartOptions(options: StartOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Keep the selected settings for this page even if they cannot persist.
  }
}

export function applyStartOptions(options: StartOptions): void {
  document.body.classList.toggle('hide-driving-help', !options.showControlGuide);
}

function rigLabel(build: VehicleBuild): string {
  const labels: Record<VehicleBuild['baseId'], string> = {
    ridgeback: 'Ridgeback Wagon',
    overlander: 'Overlander Wagon',
    'stockman-single': 'Stockman Single Cab',
    'stockman-dual': 'Stockman Dual Cab',
    longreach: 'Longreach Carrier',
    outclaw: 'Outclaw Tube Crawler',
    'dustback-rs': 'Dustback RS',
  };
  return labels[build.baseId];
}

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return 'just now';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d ago`;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(timestamp);
}

export interface StartScreenConfig {
  saves: GameSave[];
  development: boolean;
  options: StartOptions;
  onOptionsChanged?: (options: StartOptions) => void;
}

/** Main-menu shell. Sub-pages stay inside one modal so Escape and Back always
 * return to a predictable place without reloading the game. */
export function showStartScreen(config: StartScreenConfig): Promise<StartChoice> {
  return new Promise<StartChoice>((resolve) => {
    let saves = [...config.saves].sort((a, b) => b.updatedAt - a.updatedAt);
    let options = { ...config.options };

    const overlay = document.createElement('div');
    overlay.id = 'start-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'start-title');
    overlay.innerHTML = `
      <div class="start-grain" aria-hidden="true"></div>
      <div class="start-panorama-label" aria-hidden="true"><i></i> Live view · Procedural Valley</div>
      <main id="start-card">
        <header class="start-brand">
          <div class="start-kicker">Australian backcountry</div>
          <h1 id="start-title"><span>myd</span>runner</h1>
          <p>Pick a line. Keep the wheels turning.</p>
        </header>
        <section id="start-panel" aria-live="polite"></section>
        <footer class="start-footer">
          <span>build ${__APP_VERSION__}</span>
          <span>Local saves stay on this device</span>
        </footer>
      </main>
    `;
    document.body.classList.add('start-screen-open');
    document.body.appendChild(overlay);
    const panel = overlay.querySelector('#start-panel') as HTMLElement;

    const finish = (choice: StartChoice): void => {
      document.body.classList.remove('start-screen-open');
      overlay.remove();
      resolve(choice);
    };

    const wireBack = (): void => {
      panel.querySelector<HTMLButtonElement>('[data-start-back]')?.addEventListener('click', renderMain);
    };

    const renderMain = (): void => {
      const latest = saves[0];
      panel.innerHTML = `
        <nav class="start-menu" aria-label="Main menu">
          <button class="start-action start-action-primary" id="start-continue" type="button" ${latest ? '' : 'disabled'}>
            <span>Continue</span>
            <small>${latest ? `${latest.name} · ${rigLabel(latest.build)} · ${relativeTime(latest.updatedAt)}` : 'No local save yet'}</small>
          </button>
          <button class="start-action" id="start-new" type="button"><span>New game</span><small>Create another driver and rig</small></button>
          <button class="start-action" id="start-load" type="button" ${saves.length ? '' : 'disabled'}><span>Load game</span><small>${saves.length} local ${saves.length === 1 ? 'save' : 'saves'}</small></button>
          <button class="start-action" id="start-options" type="button"><span>Options</span><small>Audio and interface</small></button>
          ${config.development ? '<button class="start-action start-action-dev" id="start-dev" type="button"><span>Dev tools</span><small>Assets and world building</small></button>' : ''}
        </nav>
      `;
      panel.querySelector<HTMLButtonElement>('#start-continue')?.addEventListener('click', () => {
        if (latest) finish({ type: 'play', save: latest });
      });
      panel.querySelector<HTMLButtonElement>('#start-new')?.addEventListener('click', () => finish({ type: 'new' }));
      panel.querySelector<HTMLButtonElement>('#start-load')?.addEventListener('click', renderLoad);
      panel.querySelector<HTMLButtonElement>('#start-options')?.addEventListener('click', renderOptions);
      panel.querySelector<HTMLButtonElement>('#start-dev')?.addEventListener('click', renderDev);
      panel.querySelector<HTMLButtonElement>('.start-action:not(:disabled)')?.focus();
    };

    const renderLoad = (): void => {
      panel.innerHTML = `
        <div class="start-subhead"><button class="start-back" data-start-back type="button" aria-label="Back to main menu">←</button><div><span>Local garage</span><h2>Load game</h2></div></div>
        <div class="start-save-list">
          ${saves.map((save) => `
            <article class="start-save" data-save-id="${save.id}">
              <button class="start-save-play" type="button">
                <strong>${escapeHtml(save.name)}</strong>
                <span>${rigLabel(save.build)} · ${relativeTime(save.updatedAt)}</span>
              </button>
              <button class="start-save-delete" type="button" aria-label="Delete ${escapeHtml(save.name)} save">Delete</button>
            </article>
          `).join('') || '<p class="start-empty">No saves on this device.</p>'}
        </div>
      `;
      wireBack();
      for (const row of panel.querySelectorAll<HTMLElement>('.start-save')) {
        const id = row.dataset.saveId!;
        const save = saves.find((candidate) => candidate.id === id)!;
        row.querySelector<HTMLButtonElement>('.start-save-play')?.addEventListener('click', () => finish({ type: 'play', save }));
        row.querySelector<HTMLButtonElement>('.start-save-delete')?.addEventListener('click', () => {
          const button = row.querySelector<HTMLButtonElement>('.start-save-delete')!;
          if (button.dataset.confirm !== 'true') {
            button.dataset.confirm = 'true';
            button.textContent = 'Confirm';
            window.setTimeout(() => {
              if (button.isConnected) {
                button.dataset.confirm = 'false';
                button.textContent = 'Delete';
              }
            }, 3000);
            return;
          }
          saves = deleteGameSave(id);
          renderLoad();
        });
      }
      panel.querySelector<HTMLButtonElement>('.start-back')?.focus();
    };

    const renderOptions = (): void => {
      panel.innerHTML = `
        <div class="start-subhead"><button class="start-back" data-start-back type="button" aria-label="Back to main menu">←</button><div><span>Preferences</span><h2>Options</h2></div></div>
        <div class="start-settings">
          <label class="start-setting"><span><strong>Engine audio</strong><small>Procedural engine and drivetrain sound</small></span><input id="option-audio" type="checkbox" ${options.engineAudio ? 'checked' : ''}><i aria-hidden="true"></i></label>
          <label class="start-setting"><span><strong>Control guide</strong><small>Show keyboard controls while driving</small></span><input id="option-guide" type="checkbox" ${options.showControlGuide ? 'checked' : ''}><i aria-hidden="true"></i></label>
        </div>
        <p class="start-storage-note">Settings and saves use your browser's local storage. Clearing site data removes them.</p>
      `;
      wireBack();
      const update = (): void => {
        options = {
          engineAudio: panel.querySelector<HTMLInputElement>('#option-audio')!.checked,
          showControlGuide: panel.querySelector<HTMLInputElement>('#option-guide')!.checked,
        };
        saveStartOptions(options);
        applyStartOptions(options);
        config.onOptionsChanged?.({ ...options });
      };
      panel.querySelector<HTMLInputElement>('#option-audio')?.addEventListener('change', update);
      panel.querySelector<HTMLInputElement>('#option-guide')?.addEventListener('change', update);
      panel.querySelector<HTMLButtonElement>('.start-back')?.focus();
    };

    const renderDev = (): void => {
      panel.innerHTML = `
        <div class="start-subhead"><button class="start-back" data-start-back type="button" aria-label="Back to main menu">←</button><div><span>Development</span><h2>Tools</h2></div></div>
        <div class="start-tool-grid">
          <a href="asset-editor.html"><strong>Asset designer</strong><span>Build and inspect procedural vehicle assets</span><b>Open ↗</b></a>
          <a href="editor.html"><strong>Map editor</strong><span>Sculpt terrain, paint surfaces, and place objects</span><b>Open ↗</b></a>
        </div>
      `;
      wireBack();
      panel.querySelector<HTMLButtonElement>('.start-back')?.focus();
    };

    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && panel.querySelector('[data-start-back]')) renderMain();
    });
    renderMain();
  });
}

function escapeHtml(value: string): string {
  const span = document.createElement('span');
  span.textContent = value;
  return span.innerHTML;
}
