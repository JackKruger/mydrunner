// Corner minimap: a 2D canvas showing the terrain surface layout with a
// hillshade, plus live player dots. The base map is painted once from
// TerrainData (deterministic, same generator as the mesh); only the dots
// redraw per frame. Pure DOM/canvas - no Three.js involvement.

import { Physics } from '@mydrunner/shared';
import { registerFullscreenControl } from './fullscreen.js';

const SIZE_PX = 168;

export interface MinimapPlayer {
  x: number;
  z: number;
  /** World yaw (rad) - only used for the local player's heading wedge. */
  yaw: number;
  isLocal: boolean;
  label?: string;
}

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private worldSize = 1;
  private readonly fullCanvas: HTMLCanvasElement;
  private readonly playerList: HTMLElement;
  private readonly overlay: HTMLElement;
  private open = false;

  constructor() {
    const wrap = document.createElement('aside');
    wrap.id = 'minimap-wrap';
    wrap.className = 'instrument-panel';
    wrap.setAttribute('aria-label', 'Game menu shortcut');
    wrap.innerHTML = `
      <button id="game-menu-button" type="button" aria-haspopup="dialog">MENU <kbd>ESC</kbd></button>
    `;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    this.canvas.width = SIZE_PX;
    this.canvas.height = SIZE_PX;
    this.canvas.setAttribute('aria-label', 'Terrain and player positions');
    this.canvas.hidden = true;
    wrap.appendChild(this.canvas);
    document.body.appendChild(wrap);
    this.ctx = this.canvas.getContext('2d')!;
    this.overlay = document.createElement('div');
    this.overlay.id = 'game-menu';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="game-menu-shell" role="dialog" aria-modal="true" aria-label="Game menu">
        <header><div><span class="hud-field-label">MYDRUNNER</span><h1>FIELD MENU</h1></div><button class="game-menu-close" type="button" aria-label="Close game menu">CLOSE <kbd>ESC</kbd></button></header>
        <nav aria-label="Game menu sections">
          <button type="button" data-menu-tab="map" aria-selected="true">MAP</button>
          <button type="button" data-menu-tab="players" aria-selected="false">PLAYERS</button>
          <button type="button" data-menu-tab="objectives" aria-selected="false">OBJECTIVES</button>
          <button type="button" data-menu-tab="settings" aria-selected="false">SETTINGS</button>
        </nav>
        <main>
          <section data-menu-panel="map"><div class="full-map-heading"><div><span class="hud-field-label">AREA OVERVIEW</span><h2>FULL STAGE MAP</h2></div><span class="full-map-north">N ↑</span></div><canvas id="full-map" width="640" height="640" aria-label="Full terrain map and player positions"></canvas></section>
          <section data-menu-panel="players" hidden><span class="hud-field-label">SESSION ROSTER</span><h2>PLAYERS</h2><div id="game-menu-players" class="game-menu-players"></div></section>
          <section data-menu-panel="objectives" hidden><span class="hud-field-label">MISSION LOG</span><h2>OBJECTIVES</h2><div class="objectives-empty"><strong>NO ACTIVE OBJECTIVES</strong><p>Contracts and trail objectives will appear here in a future gameplay update.</p></div></section>
          <section data-menu-panel="settings" hidden><span class="hud-field-label">LOCAL OPTIONS</span><h2>SETTINGS</h2><label class="menu-setting"><span><strong>FULL SCREEN</strong><small>Hide the browser chrome and drive on the whole display.</small></span><input type="checkbox" data-setting="fullscreen"></label><label class="menu-setting"><span><strong>MINIMAL HUD</strong><small>Hide driving instruments for a clean view.</small></span><input type="checkbox" data-setting="minimal-hud"></label><label class="menu-setting"><span><strong>MUTE ENGINE AUDIO</strong><small>Toggle vehicle audio on this device.</small></span><input type="checkbox" data-setting="mute"></label></section>
        </main>
        <footer>Driving continues while this menu is open.</footer>
      </div>`;
    document.body.appendChild(this.overlay);
    this.fullCanvas = this.overlay.querySelector('#full-map')!;
    this.playerList = this.overlay.querySelector('#game-menu-players')!;
    wrap.querySelector('button')!.addEventListener('click', () => this.toggle());
    this.overlay.querySelector('.game-menu-close')!.addEventListener('click', () => this.toggle(false));
    for (const tab of this.overlay.querySelectorAll<HTMLButtonElement>('[data-menu-tab]')) {
      tab.addEventListener('click', () => this.selectTab(tab.dataset.menuTab!));
    }
    // Registers itself rather than being wired from main: the control
    // removes itself where the platform has no fullscreen API, and that
    // decision belongs to one module.
    registerFullscreenControl(this.overlay.querySelector<HTMLInputElement>('[data-setting="fullscreen"]')!);
    const minimal = this.overlay.querySelector<HTMLInputElement>('[data-setting="minimal-hud"]')!;
    minimal.checked = localStorage.getItem('mydrunner.minimalHud') === 'true';
    document.body.classList.toggle('minimal-hud', minimal.checked);
    minimal.addEventListener('change', () => {
      document.body.classList.toggle('minimal-hud', minimal.checked);
      localStorage.setItem('mydrunner.minimalHud', String(minimal.checked));
    });
    this.overlay.querySelector<HTMLInputElement>('[data-setting="mute"]')!.addEventListener('change', () => {
      window.dispatchEvent(new CustomEvent('game-menu-mute'));
    });
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape' || document.body.classList.contains('start-screen-open')) return;
      if (!this.open && document.querySelector('#chat-input-wrap.open')) return;
      event.preventDefault();
      this.toggle();
    });
    this.drawStandby();
  }

  private toggle(force = !this.open): void {
    this.open = force;
    this.overlay.hidden = !force;
    document.body.classList.toggle('game-menu-open', force);
    if (force) this.overlay.querySelector<HTMLButtonElement>('[data-menu-tab][aria-selected="true"]')?.focus();
  }

  private selectTab(id: string): void {
    for (const tab of this.overlay.querySelectorAll<HTMLButtonElement>('[data-menu-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.menuTab === id));
    for (const panel of this.overlay.querySelectorAll<HTMLElement>('[data-menu-panel]')) panel.hidden = panel.dataset.menuPanel !== id;
  }

  private drawStandby(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#151713';
    ctx.fillRect(0, 0, SIZE_PX, SIZE_PX);
    ctx.strokeStyle = 'rgba(170, 169, 157, 0.12)';
    ctx.lineWidth = 1;
    for (let p = 0; p <= SIZE_PX; p += 24) {
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, SIZE_PX);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(SIZE_PX, p);
      ctx.stroke();
    }
    ctx.fillStyle = '#8f9186';
    ctx.font = '700 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('AWAITING STAGE DATA', SIZE_PX / 2, SIZE_PX / 2);
  }

  /** Paint the static base map from terrain data. Call once per welcome -
   *  terrain never changes within a session. */
  setTerrain(t: Physics.TerrainData): void {
    this.worldSize = t.size;
    const n = t.resolution;
    const img = new ImageData(n, n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        const [cr, cg, cb] = Physics.surfaceInfo(t.surfaces[i] ?? Physics.Surface.Dirt).minimapColor;
        // Cheap hillshade: brightness from the west-east height gradient,
        // matching the scene's sun sitting roughly to the east.
        const h = t.heights[i] ?? 0;
        const hw = t.heights[r * n + Math.max(0, c - 1)] ?? h;
        const shade = Math.max(0.55, Math.min(1.45, 1 + (h - hw) * 0.35));
        let red = cr * shade;
        let green = cg * shade;
        let blue = cb * shade;
        // Water blends over the bed rather than replacing it, so a
        // shallow ford still reads as the gravel it is and only the deep
        // channel goes solid blue. Same information the shader's depth
        // tint gives in the world, at map scale.
        const level = t.waterLevel[i] ?? Physics.WATER_NONE;
        if (Physics.isWet(level) && level > h) {
          const mix = Math.min(0.85, 0.3 + (level - h) * 0.45);
          red += (34 - red) * mix;
          green += (78 - green) * mix;
          blue += (104 - blue) * mix;
        }
        const o = i * 4;
        img.data[o] = Math.min(255, red);
        img.data[o + 1] = Math.min(255, green);
        img.data[o + 2] = Math.min(255, blue);
        img.data[o + 3] = 255;
      }
    }
    const base = document.createElement('canvas');
    base.width = n;
    base.height = n;
    base.getContext('2d')!.putImageData(img, 0, 0);
    this.base = base;
    document.getElementById('minimap-wrap')?.classList.add('ready');
  }

  /** Redraw base + player dots. Call once per render frame. */
  update(players: MinimapPlayer[]): void {
    if (!this.base) return;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, SIZE_PX, SIZE_PX);

    const toPx = (w: number): number => (w / this.worldSize + 0.5) * SIZE_PX;
    for (const p of players) {
      const px = toPx(p.x);
      const py = toPx(p.z);
      if (p.isLocal) {
        // Heading wedge. World yaw=0 faces +Z (map-down), positive yaw
        // rotates toward +X (map-right) - same atan2(fX, fZ) convention
        // as the chase camera. The wedge is drawn pointing map-up, so
        // the canvas rotation that puts its tip on the heading vector
        // (sin yaw, cos yaw) in (right, down) space is pi - yaw.
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.PI - p.yaw);
        ctx.fillStyle = '#ff7a2e';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(4.2, 4.5);
        ctx.lineTo(-4.2, 4.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = '#f2f2f2';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (!this.open) return;
    const full = this.fullCanvas.getContext('2d')!;
    full.imageSmoothingEnabled = true;
    full.drawImage(this.canvas, 0, 0, this.fullCanvas.width, this.fullCanvas.height);
    this.playerList.replaceChildren(...players.map((player) => {
      const row = document.createElement('div');
      row.className = 'game-menu-player';
      row.innerHTML = `<span class="player-marker ${player.isLocal ? 'local' : ''}"></span><strong></strong><small>${player.isLocal ? 'YOU' : 'ONLINE'}</small>`;
      row.querySelector('strong')!.textContent = player.label || (player.isLocal ? 'Driver' : 'Trail driver');
      return row;
    }));
  }
}
