// First-load join screen: name + car picker. Persists choices in
// localStorage so subsequent visits skip straight to the game. Tests
// can pre-populate localStorage to bypass the picker.

import type { CarKind, VehicleBaseId, VehicleBuild } from '@mydrunner/shared';
import { createStockBuild, normalizeVehicleBaseId, normalizeVehicleBuild } from '@mydrunner/shared';

const NAME_KEY = 'mydrunner.name';
const CAR_KEY = 'mydrunner.carKind';
export const APPLIED_BUILD_KEY = 'mydrunner.appliedBuild.v1';

export interface JoinChoice {
  name: string;
  build: VehicleBuild;
  /** Compatibility mirror for editor handoff code. */
  carKind: VehicleBaseId;
}

export function loadSavedJoin(): JoinChoice | null {
  try {
    const name = localStorage.getItem(NAME_KEY);
    const carRaw = localStorage.getItem(CAR_KEY);
    if (!name) return null;
    const buildRaw = localStorage.getItem(APPLIED_BUILD_KEY);
    const build = buildRaw ? normalizeVehicleBuild(JSON.parse(buildRaw)) : createStockBuild(normalizeVehicleBaseId(carRaw));
    return { name, build, carKind: build.baseId };
  } catch {
    return null;
  }
}

export function saveJoin(choice: JoinChoice): void {
  try {
    localStorage.setItem(NAME_KEY, choice.name);
    localStorage.setItem(CAR_KEY, choice.build.baseId);
    localStorage.setItem(APPLIED_BUILD_KEY, JSON.stringify(choice.build));
  } catch {
    /* private browsing / storage disabled - run anyway, just don't persist */
  }
}

interface CarOption {
  kind: VehicleBaseId;
  name: string;
  desc: string;
  glyph: string;
  swatchBg: string;
}

const CAR_OPTIONS: CarOption[] = [
  {
    kind: 'ridgeback',
    name: 'Ridgeback Wagon',
    desc: 'Articulated trail wagon. Excellent on rocks; taller on side slopes.',
    glyph: '[==]',
    swatchBg: '#d9531e',
  },
  {
    kind: 'overlander',
    name: 'Overlander Wagon',
    desc: 'Stable, durable tourer with predictable grip and longer braking.',
    glyph: '[=#]',
    swatchBg: '#e8e3da',
  },
  {
    kind: 'stockman-single',
    name: 'Stockman Single Cab',
    desc: 'Nimble work ute with strong power-to-weight and a light rear.',
    glyph: '[=_]',
    swatchBg: '#f2c200',
  },
  {
    kind: 'stockman-dual',
    name: 'Stockman Dual Cab',
    desc: 'Balanced utility with a longer wheelbase and useful touring room.',
    glyph: '[==_]',
    swatchBg: '#2a8acb',
  },
  {
    kind: 'longreach',
    name: 'Longreach Carrier',
    desc: 'Expedition rig with high wading ability and a wide turning circle.',
    glyph: '[===]',
    swatchBg: '#b6a579',
  },
  {
    kind: 'outclaw',
    name: 'Outclaw Tube Crawler',
    desc: 'Wide live axles, huge articulation and a stripped-back tube chassis.',
    glyph: 'o-#-o',
    swatchBg: '#d64228',
  },
  {
    kind: 'dustback-rs',
    name: 'Dustback RS',
    desc: 'Light rear-drive rally hatch: razor sharp on gravel, fragile in rocks and deep mud.',
    glyph: 'o[==]o',
    swatchBg: '#e6e1d4',
  },
];

export function showJoinScreen(initial: Partial<JoinChoice>): Promise<JoinChoice> {
  return new Promise<JoinChoice>((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'join-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'join-title');

    let selected: VehicleBaseId = initial.build?.baseId ?? normalizeVehicleBaseId(initial.carKind);

    const card = document.createElement('form');
    card.id = 'join-card';
    card.innerHTML = `
      <div class="join-eyebrow">Rugged rally dispatch</div>
      <h1 id="join-title">mydrunner</h1>
      <p class="sub">Sign on, select a trail rig, and report to the start line. Your briefing is saved for the next run.</p>
      <div class="join-driver-row">
        <div class="join-driver-field">
          <label for="join-name">Driver call sign</label>
          <input id="join-name" type="text" maxlength="32" autocomplete="nickname" spellcheck="false" placeholder="Enter driver name" />
        </div>
        <p class="join-driver-note">Online trail session<br />Seven rigs available</p>
      </div>
      <fieldset id="join-rig-fieldset">
        <legend>Choose your rig</legend>
        <div id="join-cars" role="radiogroup" aria-label="Vehicle selection"></div>
      </fieldset>
      <div class="join-actions">
        <span class="join-actions-note">Arrow keys select · Enter confirms</span>
        <button id="join-go" type="submit">Drive</button>
      </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const nameInput = card.querySelector('#join-name') as HTMLInputElement;
    nameInput.value = initial.name ?? '';

    const carsEl = card.querySelector('#join-cars') as HTMLDivElement;
    const cardEls = new Map<VehicleBaseId, HTMLButtonElement>();
    const selectCar = (kind: VehicleBaseId, focus = false): void => {
      selected = kind;
      for (const [k, el] of cardEls) {
        const isSelected = k === selected;
        el.classList.toggle('selected', isSelected);
        el.setAttribute('aria-checked', String(isSelected));
        el.tabIndex = isSelected ? 0 : -1;
      }
      if (focus) cardEls.get(kind)?.focus();
    };
    for (const opt of CAR_OPTIONS) {
      const btn = document.createElement('button');
      btn.className = 'join-car';
      btn.type = 'button';
      btn.dataset.carKind = opt.kind;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', 'false');
      btn.innerHTML = `
        <div class="swatch" style="--rig-colour:${opt.swatchBg};" aria-hidden="true">${opt.glyph}</div>
        <div class="name">${opt.name}</div>
        <div class="desc">${opt.desc}</div>
      `;
      btn.addEventListener('click', () => selectCar(opt.kind));
      btn.addEventListener('keydown', (e) => {
        const index = CAR_OPTIONS.findIndex(({ kind }) => kind === selected);
        let nextIndex: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (index + 1) % CAR_OPTIONS.length;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = (index - 1 + CAR_OPTIONS.length) % CAR_OPTIONS.length;
        if (e.key === 'Home') nextIndex = 0;
        if (e.key === 'End') nextIndex = CAR_OPTIONS.length - 1;
        if (nextIndex === null) return;
        e.preventDefault();
        selectCar(CAR_OPTIONS[nextIndex]!.kind, true);
      });
      cardEls.set(opt.kind, btn);
      carsEl.appendChild(btn);
    }
    selectCar(selected);

    const submit = (): void => {
      const name = nameInput.value.trim().slice(0, 32) || `player-${Math.floor(Math.random() * 1000)}`;
      document.body.removeChild(overlay);
      const build = initial.build?.baseId === selected ? normalizeVehicleBuild(initial.build) : createStockBuild(selected);
      resolve({ name, build, carKind: selected });
    };
    card.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    setTimeout(() => nameInput.focus(), 0);
  });
}
