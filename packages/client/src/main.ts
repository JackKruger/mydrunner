// Client entry point. Owns the net client, the scene, the input loop, and
// the local prediction sim.

import { Physics, TICK_RATE, type PlayerId } from '@mydrunner/shared';

import { EngineAudio } from './engineAudio.js';
import { loadSavedJoin, saveJoin, showJoinScreen, type JoinChoice } from './joinScreen.js';
import { initChat } from './chat.js';

const SURFACE_LABELS: Record<number, string> = {
  [Physics.Surface.Road]: 'road',
  [Physics.Surface.Dirt]: 'dirt',
  [Physics.Surface.Mud]: 'mud',
  [Physics.Surface.DeepMud]: 'deep mud',
};
import { initInput, sampleInput, clearKeys } from './input.js';
import { initTouchInput, onTouchEdge } from './touchInput.js';
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
initTouchInput();
const scene = new Scene(app);
const engineAudio = new EngineAudio();
// Chat module is created up-front; the onSubmit closure references the
// NetClient via `currentNet` which is reassigned after start() builds
// the connection. Messages typed before the connection is up are no-ops.
let currentNet: NetClient | null = null;
const chat = initChat({ onSubmit: (text) => currentNet?.sendChat(text) });

// Wrap chat.open so any held game keys are dropped when the player
// starts typing - otherwise they keep the truck moving / steering
// while they compose a message.
const wrappedOpen = chat.open;
chat.open = (): void => {
  clearKeys();
  wrappedOpen();
};

// Browsers block AudioContext until a user gesture - start audio on the
// first keypress.
const startAudioOnce = (): void => {
  engineAudio.start();
  window.removeEventListener('keydown', startAudioOnce);
  window.removeEventListener('mousedown', startAudioOnce);
  window.removeEventListener('touchstart', startAudioOnce);
};
window.addEventListener('keydown', startAudioOnce);
window.addEventListener('mousedown', startAudioOnce);
window.addEventListener('touchstart', startAudioOnce);

// Mute toggle on M (or the on-screen mute button on touch).
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') engineAudio.toggleMute();
});
onTouchEdge('mute', () => engineAudio.toggleMute());

// Expose scene + prediction for E2E diagnostics.
// Diagnostic hooks for E2E / browser debugging. Only exposed in dev (Vite
// sets DEV; production builds skip this) so production bundles do not ship
// the internals to the window object.
if (import.meta.env.DEV) {
  (window as unknown as { __scene: unknown }).__scene = scene;
}

let localId: PlayerId | null = null;
let connected = false;
let lastSnapTick = 0;
let lastSpeed = 0;
let lastRpm = 0;
let lastGear = 0;
let prediction: Prediction | null = null;
let lastFrameTimeMs = performance.now();
let terrainData: Physics.TerrainData | null = null;

async function start(): Promise<void> {
  // Rapier WASM init - prediction depends on the same physics as the server.
  await Physics.initRapier();

  // Show the name + car picker on every load so the player can pick a
  // different rig if they want; previous name + car are pre-filled from
  // localStorage so the common case is one Enter to drive. URL param
  // ?auto=1 skips the picker entirely (used by e2e tests).
  const params = new URLSearchParams(location.search);
  const auto = params.get('auto') === '1';
  const saved = loadSavedJoin();
  let choice: JoinChoice;
  if (auto) {
    choice = {
      name: params.get('name') || saved?.name || `player-${Math.floor(Math.random() * 1000)}`,
      carKind: params.get('car') === 'hilux' ? 'hilux' : (saved?.carKind ?? 'patrol'),
    };
  } else {
    choice = await showJoinScreen(saved ?? {});
    saveJoin(choice);
  }

  const net = new NetClient(getServerUrl(), choice.name, choice.carKind, {
    onOpen() {
      connected = true;
      chat.pushSystem('connected — press T to chat');
    },
    onWelcome(id, _serverTimeMs, terrain, spawn) {
      localId = id;
      scene.setLocalPlayer(id, choice.carKind);
      scene.setTerrain(terrain.seed, terrain.size, terrain.resolution);
      // Cache terrain data for surface HUD lookups (cheap - we already
      // generate it for the prediction sim).
      terrainData = Physics.generateTerrain({
        seed: terrain.seed,
        size: terrain.size,
        resolution: terrain.resolution,
      });
      // Build local prediction world with the same seed + spawn.
      prediction?.dispose();
      prediction = new Prediction(terrain.seed, terrain.size, terrain.resolution, spawn);
      if (import.meta.env.DEV) {
        (window as unknown as { __prediction: unknown }).__prediction = prediction;
      }
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
          lastRpm = me.vehicle.rpm;
          lastGear = me.vehicle.gear;
          engineAudio.set(me.vehicle.rpm, me.vehicle.throttle);
        }
      }
    },
    onRut(_version, cells) {
      scene.applyRuts(cells);
    },
    onChat(from, fromName, text) {
      chat.push(fromName, text, from === localId);
    },
    onClose(reason) {
      connected = false;
      hud.textContent = `disconnected: ${reason}`;
    },
  });
  currentNet = net;
  net.connect();

  // Camera-cycle hotkey (C) or on-screen "cam" button. Edge-triggered.
  let cPrev = false;
  window.addEventListener('keydown', (e) => {
    if (chat.isOpen()) return; // don't steal input while typing
    if (e.code === 'KeyC' && !cPrev) {
      scene.cycleCameraMode();
      cPrev = true;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyC') cPrev = false;
  });
  onTouchEdge('cam', () => scene.cycleCameraMode());

  // T opens the chat input. The chat module's own keydown handler
  // catches Enter / Escape to submit / cancel. Mobile users use the
  // on-screen "chat" button which lives in the touch UI aux row.
  window.addEventListener('keydown', (e) => {
    if (chat.isOpen()) return;
    if (e.code === 'KeyT') {
      e.preventDefault();
      chat.open();
    }
  });
  onTouchEdge('chat', () => chat.open());

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
      let surfaceLabel = '';
      if (terrainData && prediction) {
        const p = prediction.state().position;
        const s = Physics.sampleSurface(terrainData, p.x, p.z);
        surfaceLabel = ` · ${SURFACE_LABELS[s] ?? '?'}`;
      }
      const gearLabel = lastGear === -1 ? 'R' : lastGear === 0 ? 'N' : String(lastGear);
      hud.textContent =
        `connected · tick=${lastSnapTick} · ${kmh} km/h · ` +
        `${lastRpm.toFixed(0)} RPM · gear ${gearLabel}${surfaceLabel}`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  hud.textContent = 'init failed - see console';
});
