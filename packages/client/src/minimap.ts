// Corner minimap: a 2D canvas showing the terrain surface layout with a
// hillshade, plus live player dots. The base map is painted once from
// TerrainData (deterministic, same generator as the mesh); only the dots
// redraw per frame. Pure DOM/canvas - no Three.js involvement.

import { Physics } from '@mydrunner/shared';

const SIZE_PX = 168;

export interface MinimapPlayer {
  x: number;
  z: number;
  /** World yaw (rad) - only used for the local player's heading wedge. */
  yaw: number;
  isLocal: boolean;
}

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private worldSize = 1;

  constructor() {
    const wrap = document.createElement('aside');
    wrap.id = 'minimap-wrap';
    wrap.className = 'instrument-panel';
    wrap.setAttribute('aria-label', 'Stage minimap');
    wrap.innerHTML = `
      <div class="minimap-header">
        <span class="minimap-title">Stage map</span>
        <span class="minimap-compass" aria-hidden="true">N ↑</span>
      </div>
    `;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'minimap';
    this.canvas.width = SIZE_PX;
    this.canvas.height = SIZE_PX;
    this.canvas.setAttribute('aria-label', 'Terrain and player positions');
    wrap.appendChild(this.canvas);
    document.body.appendChild(wrap);
    this.ctx = this.canvas.getContext('2d')!;
    this.drawStandby();
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
  }
}
