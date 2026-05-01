// Client entry point. Owns the net client, the scene, and the input loop.

import { TICK_RATE, type PlayerId } from '@mydrunner/shared';
import { initInput, sampleInput } from './input.js';
import { NetClient } from './net.js';
import { Scene } from './scene.js';

function getServerUrl(): string {
  const explicit = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (explicit) return explicit;
  // Default: same host as the page, port 2567.
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

const net = new NetClient(getServerUrl(), `player-${Math.floor(Math.random() * 1000)}`, {
  onOpen() {
    connected = true;
  },
  onWelcome(id, _serverTimeMs) {
    localId = id;
    scene.setLocalPlayer(id);
  },
  onSnapshot(snap, recvAtMs) {
    lastSnapTick = snap.tick;
    scene.pushSnapshot(snap, recvAtMs);
  },
  onClose(reason) {
    connected = false;
    hud.textContent = `disconnected: ${reason}`;
  },
});
net.connect();

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
    hud.textContent = `connected · id=${localId?.slice(0, 8) ?? '?'} · tick=${lastSnapTick}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
