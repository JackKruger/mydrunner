// First-load join screen: name + car picker. Persists choices in
// localStorage so subsequent visits skip straight to the game. Tests
// can pre-populate localStorage to bypass the picker.

import type { CarKind } from '@mydrunner/shared';
import { normalizeCarKind } from '@mydrunner/shared';

const NAME_KEY = 'mydrunner.name';
const CAR_KEY = 'mydrunner.carKind';

export interface JoinChoice {
  name: string;
  carKind: CarKind;
}

export function loadSavedJoin(): JoinChoice | null {
  try {
    const name = localStorage.getItem(NAME_KEY);
    const carRaw = localStorage.getItem(CAR_KEY);
    if (!name) return null;
    return { name, carKind: normalizeCarKind(carRaw) };
  } catch {
    return null;
  }
}

export function saveJoin(choice: JoinChoice): void {
  try {
    localStorage.setItem(NAME_KEY, choice.name);
    localStorage.setItem(CAR_KEY, choice.carKind);
  } catch {
    /* private browsing / storage disabled - run anyway, just don't persist */
  }
}

const STYLE = `
#join-overlay {
  position: fixed; inset: 0; z-index: 10;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(circle at 50% 35%, rgba(40,55,75,0.92), rgba(10,12,16,0.96));
  font-family: ui-monospace, monospace; color: #eee;
}
#join-card {
  background: #14181f; border: 1px solid #2a323d; border-radius: 10px;
  padding: 28px 32px; width: min(560px, 92vw);
  box-shadow: 0 20px 60px rgba(0,0,0,0.6);
}
#join-card h1 { font-size: 20px; margin-bottom: 4px; letter-spacing: 0.06em; }
#join-card .sub { font-size: 11px; opacity: 0.65; margin-bottom: 22px; }
#join-card label { display: block; font-size: 11px; opacity: 0.7; margin-bottom: 6px; letter-spacing: 0.08em; }
#join-name {
  width: 100%; background: #0c0f14; color: #eee; border: 1px solid #2a323d; border-radius: 6px;
  padding: 10px 12px; font-family: inherit; font-size: 14px; outline: none;
}
#join-name:focus { border-color: #d9531e; }
#join-cars { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 18px 0 22px; }
.join-car {
  background: #0c0f14; border: 1px solid #2a323d; border-radius: 8px; padding: 14px;
  cursor: pointer; transition: border-color 0.12s, transform 0.12s;
  text-align: left;
}
.join-car:hover { border-color: #4a5568; transform: translateY(-1px); }
.join-car.selected { border-color: #d9531e; background: #1a1410; }
.join-car .name { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.join-car .desc { font-size: 11px; opacity: 0.65; line-height: 1.4; }
.join-car .swatch {
  width: 100%; height: 64px; border-radius: 4px; margin-bottom: 10px;
  display: flex; align-items: center; justify-content: center; font-size: 28px;
}
#join-go {
  width: 100%; padding: 12px; background: #d9531e; color: #fff;
  border: none; border-radius: 6px; font-family: inherit; font-size: 14px;
  font-weight: 600; letter-spacing: 0.05em; cursor: pointer; transition: background 0.12s;
}
#join-go:hover { background: #ec5e26; }
#join-go:disabled { background: #444; cursor: not-allowed; }
`;

interface CarOption {
  kind: CarKind;
  name: string;
  desc: string;
  glyph: string;
  swatchBg: string;
}

const CAR_OPTIONS: CarOption[] = [
  {
    kind: 'patrol',
    name: 'Patrol GQ',
    desc: 'Boxy 4x4 SUV. Roof rack, snorkel, bullbar. Tall and upright.',
    glyph: '[==]',
    swatchBg: '#d9531e',
  },
  {
    kind: 'hilux',
    name: 'Hilux',
    desc: 'Single-cab ute with a hardtop canopy on the bed.',
    glyph: '[=#]',
    swatchBg: '#e8e3da',
  },
  {
    kind: 'ute',
    name: 'Falcon Ute',
    desc: 'Sedan-based ute. Low cabin, open tray, chrome sport bar.',
    glyph: '[=_]',
    swatchBg: '#f2c200',
  },
  {
    kind: 'motorbike',
    name: 'Dual-Sport',
    desc: 'Lightweight motorbike. Thin frame, knobby tyres, no roof.',
    glyph: 'oo',
    swatchBg: '#2a8acb',
  },
];

export function showJoinScreen(initial: Partial<JoinChoice>): Promise<JoinChoice> {
  return new Promise<JoinChoice>((resolve) => {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'join-overlay';

    let selected: CarKind = initial.carKind ?? 'patrol';

    const card = document.createElement('div');
    card.id = 'join-card';
    card.innerHTML = `
      <h1>mydrunner</h1>
      <div class="sub">name and rig — saved for next time</div>
      <label for="join-name">DRIVER NAME</label>
      <input id="join-name" type="text" maxlength="32" autocomplete="off" spellcheck="false" />
      <label>VEHICLE</label>
      <div id="join-cars"></div>
      <button id="join-go">DRIVE</button>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const nameInput = card.querySelector('#join-name') as HTMLInputElement;
    nameInput.value = initial.name ?? '';

    const carsEl = card.querySelector('#join-cars') as HTMLDivElement;
    const cardEls = new Map<CarKind, HTMLButtonElement>();
    for (const opt of CAR_OPTIONS) {
      const btn = document.createElement('button');
      btn.className = 'join-car';
      btn.type = 'button';
      btn.innerHTML = `
        <div class="swatch" style="background:${opt.swatchBg};color:#111;">${opt.glyph}</div>
        <div class="name">${opt.name}</div>
        <div class="desc">${opt.desc}</div>
      `;
      btn.addEventListener('click', () => {
        selected = opt.kind;
        for (const [k, el] of cardEls) el.classList.toggle('selected', k === selected);
      });
      cardEls.set(opt.kind, btn);
      carsEl.appendChild(btn);
    }
    cardEls.get(selected)?.classList.add('selected');

    const goBtn = card.querySelector('#join-go') as HTMLButtonElement;
    const submit = (): void => {
      const name = nameInput.value.trim().slice(0, 32) || `player-${Math.floor(Math.random() * 1000)}`;
      document.body.removeChild(overlay);
      style.remove();
      resolve({ name, carKind: selected });
    };
    goBtn.addEventListener('click', submit);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    setTimeout(() => nameInput.focus(), 0);
  });
}
