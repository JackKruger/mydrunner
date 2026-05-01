// Client entry point. Owns the net client, the scene, the input loop, and
// the local prediction sim.

import { Physics, TICK_RATE, type PlayerId } from '@mydrunner/shared';
import { initInput, sampleInput } from './input.js';
import { NetClient } from './net.js';
import { Scene } from './scene.js';
import { Prediction } from './prediction.js';

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
let prediction: Prediction | null = null;
let lastFrameTimeMs = performance.now();

async function start(): Promise<void> {
  // Rapier WASM init - prediction depends on the same physics as the server.
  await Physics.initRapier();

  const net = new NetClient(getServerUrl(), `player-${Math.floor(Math.random() * 1000)}`, {
    onOpen() {
      connected = true;
    },
    onWelcome(id, _serverTimeMs, terrain, spawn) {
      localId = id;
      scene.setLocalPlayer(id);
      scene.setTerrain(terrain.seed, terrain.size, terrain.resolution);
      // Build local prediction world with the same seed + spawn.
      prediction?.dispose();
      prediction = new Prediction(terrain.seed, terrain.size, terrain.resolution, spawn);
      scene.markLocalOverridden();
    },
    onSnapshot(snap, recvAtMs) {
      lastSnapTick = snap.tick;
      scene.pushSnapshot(snap, recvAtMs);
      if (prediction && localId) prediction.reconcile(snap, localId);
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

  // Input + prediction loop. Sample at TICK_RATE; each sample also drives
  // exactly one local physics step so prediction and server stay locked.
  const inputIntervalMs = 1000 / TICK_RATE;
  setInterval(() => {
    if (!connected) return;
    const input = sampleInput();
    net.sendInput(input);
    if (prediction) prediction.pushAndStep(input);
  }, inputIntervalMs);

  // Render loop.
  function frame(): void {
    const now = performance.now();
    const frameDt = (now - lastFrameTimeMs) / 1000;
    lastFrameTimeMs = now;
    // Keep the local sim alive between input samples (mostly redundant at
    // 60Hz input but matters under tab throttling).
    if (prediction) prediction.advance(frameDt);

    // Override the local vehicle pose with the predicted state so the local
    // car is responsive instead of 100ms behind.
    if (prediction) {
      const s = prediction.state();
      scene.setLocalVehiclePose(s.position, s.rotation, s.wheels);
    }

    scene.render(now);
    if (connected) {
      const kmh = (lastSpeed * 3.6).toFixed(0);
      hud.textContent = `connected · id=${localId?.slice(0, 8) ?? '?'} · tick=${lastSnapTick} · ${kmh} km/h`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  hud.textContent = 'init failed - see console';
});
