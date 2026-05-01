// Client entry point. Owns the net client, the scene, and the input loop.

import { TICK_RATE, type PlayerId } from '@mydrunner/shared';
import { initInput, sampleInput, isPressed } from './input.js';
import { NetClient } from './net.js';
import { Scene } from './scene.js';

function getServerUrl(): string {
  const explicit = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (explicit) return explicit;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.hostname}:2567`;
}

const hud = document.getElementById('hud')!;
const app = document.getElementById('app')!;

initInput();
const scene = new Scene(app);

let localId: PlayerId | null = null;
let connected = false;
let lastSnapTick = 0;
let lastSpeed = 0;
let lastSurface = '';

const net = new NetClient(getServerUrl(), `player-${Math.floor(Math.random() * 1000)}`, {
  onOpen() {
    connected = true;
  },
  onWelcome(id, _serverTimeMs, terrain) {
    localId = id;
    scene.setLocalPlayer(id);
    scene.setTerrain(terrain.seed, terrain.size, terrain.resolution);
  },
  onSnapshot(snap, recvAtMs) {
    lastSnapTick = snap.tick;
    scene.pushSnapshot(snap, recvAtMs);
    if (localId) {
      const me = snap.players.find((p) => p.id === localId);
      if (me) {
        const lv = me.vehicle.linVel;
        lastSpeed = Math.hypot(lv.x, lv.z);
      }
    }
  },
  onRut(_version, cells) {
    scene.applyRuts(cells);
  },
  onClose(reason) {
    connected = false;
    hud.textContent = `disconnected: ${reason}`;
  },
});
net.connect();

// Camera-cycle hotkey (C). Edge-triggered.
let cPrev = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyC' && !cPrev) {
    scene.cycleCameraMode();
    cPrev = true;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyC') cPrev = false;
});

// Input send loop at TICK_RATE.
const inputIntervalMs = 1000 / TICK_RATE;
setInterval(() => {
  if (!connected) return;
  net.sendInput(sampleInput());
}, inputIntervalMs);

// Render loop.
function frame(): void {
  const now = performance.now();
  scene.render(now);
  if (connected) {
    const kmh = (lastSpeed * 3.6).toFixed(0);
    const reset = isPressed('KeyR') ? ' · RESET' : '';
    hud.textContent = `connected · id=${localId?.slice(0, 8) ?? '?'} · tick=${lastSnapTick} · ${kmh} km/h${lastSurface ? ' · ' + lastSurface : ''}${reset}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
