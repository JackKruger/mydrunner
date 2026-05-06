// Client entry point. Owns the net client, the scene, the input loop, and
// the local prediction sim.

import { Physics, FIXED_DT, type PlayerId } from '@mydrunner/shared';

import { EngineAudio } from './engineAudio.js';
import { loadSavedJoin, saveJoin, showJoinScreen, type JoinChoice } from './joinScreen.js';
import { initChat } from './chat.js';
import { isDebugUser, initDebugPanel, updateAxleDebug } from './debugPanel.js';

const SURFACE_LABELS: Record<number, string> = {
  [Physics.Surface.Road]: 'road',
  [Physics.Surface.Dirt]: 'dirt',
  [Physics.Surface.Mud]: 'mud',
  [Physics.Surface.DeepMud]: 'deep mud',
  [Physics.Surface.Grass]: 'grass',
  [Physics.Surface.Gravel]: 'gravel',
  [Physics.Surface.Concrete]: 'concrete',
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
// Stamp the build version into the bottom-right badge. Vite's `define`
// inlines the literal at build time; the deploy workflow sets
// APP_VERSION to "<commit-count>.<sha>" so the number ticks up each
// push to main. Local dev builds show "dev".
const versionEl = document.getElementById('version');
if (versionEl) versionEl.textContent = __APP_VERSION__;

initInput();
initTouchInput();
const scene = new Scene(app);
const engineAudio = new EngineAudio();

// Network diagnostics: snapshot arrival jitter + reconcile pop magnitude.
// Cheap counters, flushed every 5s. Tells us whether the "everyone glitches
// out" symptom is jitter exceeding the interp buffer (gaps > 100ms),
// outright stalls (gaps > 200ms), or large prediction divergence (pos
// errors > 1m / cap hits).
const NET_DIAG_WINDOW_MS = 5000;
const netDiag = {
  windowStart: 0,
  prevRecvMs: 0,
  snaps: 0,
  gapSumMs: 0,
  gapMaxMs: 0,
  gapOver100: 0,  // jitter buffer underrun risk
  gapOver200: 0,  // outright stall - remote players visibly freeze
  popSum: 0,
  popMax: 0,
  popOver1m: 0,
  capped: 0,
  queueLenSum: 0,
  queueLenMax: 0,
};
function netDiagOnSnapshot(recvAtMs: number, stats: { posErr: number; capped: boolean; queueLen: number } | null): void {
  if (netDiag.windowStart === 0) netDiag.windowStart = recvAtMs;
  if (netDiag.prevRecvMs > 0) {
    const gap = recvAtMs - netDiag.prevRecvMs;
    netDiag.gapSumMs += gap;
    if (gap > netDiag.gapMaxMs) netDiag.gapMaxMs = gap;
    if (gap > 100) netDiag.gapOver100 += 1;
    if (gap > 200) netDiag.gapOver200 += 1;
  }
  netDiag.prevRecvMs = recvAtMs;
  netDiag.snaps += 1;
  if (stats) {
    netDiag.popSum += stats.posErr;
    if (stats.posErr > netDiag.popMax) netDiag.popMax = stats.posErr;
    if (stats.posErr > 1.0) netDiag.popOver1m += 1;
    if (stats.capped) netDiag.capped += 1;
    netDiag.queueLenSum += stats.queueLen;
    if (stats.queueLen > netDiag.queueLenMax) netDiag.queueLenMax = stats.queueLen;
  }
  if (recvAtMs - netDiag.windowStart >= NET_DIAG_WINDOW_MS) {
    const n = netDiag.snaps || 1;
    const meanGap = netDiag.gapSumMs / Math.max(1, netDiag.snaps - 1);
    const meanPop = netDiag.popSum / n;
    const meanQueue = netDiag.queueLenSum / n;
    const elapsedS = (recvAtMs - netDiag.windowStart) / 1000;
    console.log(
      `[mydrunner-client] net ${elapsedS.toFixed(1)}s snaps=${netDiag.snaps} ` +
        `gap mean=${meanGap.toFixed(1)}ms max=${netDiag.gapMaxMs.toFixed(1)}ms ` +
        `over100=${netDiag.gapOver100} over200=${netDiag.gapOver200} ` +
        `pop mean=${meanPop.toFixed(2)}m max=${netDiag.popMax.toFixed(2)}m ` +
        `over1m=${netDiag.popOver1m} capped=${netDiag.capped} ` +
        `queueLen mean=${meanQueue.toFixed(1)} max=${netDiag.queueLenMax}`,
    );
    netDiag.windowStart = recvAtMs;
    netDiag.snaps = 0;
    netDiag.gapSumMs = 0;
    netDiag.gapMaxMs = 0;
    netDiag.gapOver100 = 0;
    netDiag.gapOver200 = 0;
    netDiag.popSum = 0;
    netDiag.popMax = 0;
    netDiag.popOver1m = 0;
    netDiag.capped = 0;
    netDiag.queueLenSum = 0;
    netDiag.queueLenMax = 0;
  }
}
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

// Browsers block AudioContext until a user gesture - start audio on
// any pointer / key event. We don't unbind: iOS Safari can re-suspend
// the context whenever the tab loses focus, the screen sleeps, or
// headphones are unplugged, and `start()` is idempotent + cheap, so
// every subsequent gesture also acts as a resume. `pointerdown` covers
// mouse + touch + pen on every modern browser; `touchstart` is kept
// for older mobile Safari that doesn't dispatch pointer events for
// every input path.
const resumeAudio = (): void => engineAudio.start();
window.addEventListener('keydown', resumeAudio);
window.addEventListener('pointerdown', resumeAudio);
window.addEventListener('touchstart', resumeAudio, { passive: true });

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
// Snapshot deferred from the WebSocket handler so reconcile (which replays
// up to MAX_REPLAY physics steps) runs inside requestAnimationFrame where
// we control the budget, not on an async message callback that interrupts
// the render loop mid-frame.
let pendingSnap: { snap: import('@mydrunner/shared').WorldSnapshot; recvAtMs: number } | null = null;

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

  // Debug panel: only for the player named "jack" (case-insensitive).
  // Lets them twist physics tunables in flight and copy the result to
  // clipboard so the values can be baked as new defaults.
  if (isDebugUser(choice.name)) initDebugPanel();

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
      // Defer reconcile to the render loop — see pendingSnap declaration above.
      pendingSnap = { snap, recvAtMs };
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

  // Pointer-drag camera: drag anywhere on the canvas (i.e. not on a UI
  // element) to orbit yaw / pitch around the car. Releasing springs the
  // camera back to the chase pose. Works for both touch and mouse via
  // pointer events.
  const canvas = scene.renderer.domElement;
  let dragId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  // Tunable: pixels of drag → radians of camera motion.
  const PX_PER_RAD = 220;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target !== canvas) return;
    e.preventDefault();
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    scene.cameraDragBegin();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // Inverted "natural" feel: dragging the world tugs it under your
    // finger, which is the same as the camera moving the opposite way.
    scene.cameraDrag(-dx / PX_PER_RAD, dy / PX_PER_RAD);
  });
  const endDrag = (e: PointerEvent): void => {
    if (e.pointerId !== dragId) return;
    dragId = null;
    scene.cameraDragEnd();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

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

  // Input + prediction stepping is driven from the render loop with a
  // fixed-step accumulator. Earlier this lived on a setInterval timer
  // independent of requestAnimationFrame; the two ran at the same rate
  // but drifted in phase, which made the visual sometimes a tick stale
  // (visible as stutter when driving). Now each render frame catches
  // up the prediction sim by however many fixed steps fit.
  let predictAcc = 0;
  // Cap the steps run per frame so a single pause (tab switch / GC)
  // doesn't trigger a spiral-of-death.
  const MAX_STEPS_PER_FRAME = 5;

  // Render loop.
  function frame(): void {
    const now = performance.now();
    const frameDt = Math.min(0.25, (now - lastFrameTimeMs) / 1000);
    lastFrameTimeMs = now;

    // Process deferred reconcile before stepping inputs. Doing this at the
    // top of the frame (inside rAF) keeps the heavy replay work inside our
    // frame budget instead of interrupting the render mid-frame via a
    // WebSocket callback. The snap was already pushed to scene.pushSnapshot
    // in the handler, so interpolation is unaffected by the one-frame delay.
    if (pendingSnap && prediction && localId) {
      const { snap, recvAtMs } = pendingSnap;
      pendingSnap = null;
      const stats = prediction.reconcile(snap, localId);
      netDiagOnSnapshot(recvAtMs, stats);
    }

    if (connected && prediction) {
      predictAcc += frameDt;
      prediction.beginFrame();
      let steps = 0;
      while (predictAcc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        const input = sampleInput();
        net.sendInput(input);
        prediction.pushAndStep(input);
        predictAcc -= FIXED_DT;
        steps += 1;
      }
      if (steps >= MAX_STEPS_PER_FRAME) predictAcc = 0;
    }
    // Fractional time left over in the accumulator becomes the alpha
    // for state interpolation. But since beginFrame() captures prev
    // every frame, alpha should always be 1.0 — we want to
    // render at the current body position. The old alpha oscillation
    // (0.41, 0.83, 0.24, 0.65...) was causing stutter
    // on high-refresh-rate displays (144Hz+).
    const alpha = 1.0;

    // Override the local vehicle pose with the predicted state so the local
    // car is responsive instead of 100ms behind. alpha lerps between
    // the start-of-step and end-of-step body poses for smoothness.
    let predState: ReturnType<Prediction['state']> | null = null;
    if (prediction) {
      predState = prediction.state(alpha);
      scene.setLocalVehiclePose(predState.position, predState.rotation, predState.wheels, predState.axles);
      // Update debug axle overlay for debug users.
      updateAxleDebug(predState.axles[0], predState.axles[1]);
    }

    scene.render(now);
    if (connected) {
      const kmh = (lastSpeed * 3.6).toFixed(0);
      let surfaceLabel = '';
      if (terrainData && predState) {
        const p = predState.position;
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
