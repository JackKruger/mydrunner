// Client entry point. Owns the net client, the scene, the client-owned
// vehicle simulation, and the input loop.
//
// Remote vehicles are owner-authoritative: their uploaded states are
// relayed at 30 Hz and Scene.render() interpolates them ~100 ms behind.
// The LOCAL truck runs a full Rapier sim stepped with input at 60 Hz. Its
// result is canonical: snapshots render remote players but never mutate the
// owner vehicle. The two most recent physics poses are interpolated at the
// display rate so fixed ticks do not show up as chassis stepping.

import {
  Maps, Physics, FIXED_DT, SNAPSHOT_RATE, normalizeCarKind, type CarKind, type PlayerId,
} from '@mydrunner/shared';

import { EngineAudio } from './engineAudio.js';
import { loadSavedJoin, saveJoin, showJoinScreen, type JoinChoice } from './joinScreen.js';
import { initChat } from './chat.js';
import { isDebugUser, initDebugPanel, updateAxleDebug } from './debugPanel.js';

import { initInput, sampleInput, clearKeys, isHandbrakeOn } from './input.js';
import { getTouchState, initTouchInput, onTouchEdge } from './touchInput.js';
import { resolveHandshakeMap } from './mapLoad.js';
import { NetClient } from './net.js';
import { PlayerUI } from './playerUI.js';
import { Scene } from './scene.js';
import { LocalSimulation } from './localSimulation.js';
import { readPreview } from './previewHandoff.js';

function getServerUrl(): string {
  const explicit = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (explicit) return explicit;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.hostname}:2567`;
}

const hud = document.getElementById('hud')!;
const app = document.getElementById('app')!;
const playerUI = new PlayerUI(hud, {
  development: import.meta.env.DEV,
  version: __APP_VERSION__,
});

initInput();
initTouchInput();
const scene = new Scene(app);
const engineAudio = new EngineAudio();

// Network + frame diagnostics: snapshot arrival jitter and per-frame
// CPU/GPU breakdown. Cheap counters, flushed every 5 s. Jitter (gaps
// over the interpolation buffer) matters for remote-vehicle smoothness;
// frame time for overall render health.
const NET_DIAG_WINDOW_MS = 5000;
const netDiag = {
  windowStart: 0,
  prevRecvMs: 0,
  snaps: 0,
  gapSumMs: 0,
  gapMaxMs: 0,
  gapOver100: 0,  // jitter buffer underrun risk
  gapOver200: 0,  // outright stall - remote players visibly freeze
};
const frameDiag = {
  frames: 0,
  totalMsSum: 0,
  totalMsMax: 0,
  renderMsSum: 0,
  renderMsMax: 0,
  simulationMsSum: 0,
  simulationMsMax: 0,
};
function netDiagOnSnapshot(recvAtMs: number): void {
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
  if (recvAtMs - netDiag.windowStart >= NET_DIAG_WINDOW_MS) {
    const meanGap = netDiag.gapSumMs / Math.max(1, netDiag.snaps - 1);
    const elapsedS = (recvAtMs - netDiag.windowStart) / 1000;
    const frames = frameDiag.frames || 1;
    const meanFrameMs = frameDiag.totalMsSum / frames;
    const meanRenderMs = frameDiag.renderMsSum / frames;
    const meanSimulationMs = frameDiag.simulationMsSum / frames;
    const fps = frameDiag.frames / Math.max(0.001, elapsedS);
    console.log(
      `[mydrunner-client] net ${elapsedS.toFixed(1)}s snaps=${netDiag.snaps} ` +
        `gap mean=${meanGap.toFixed(1)}ms max=${netDiag.gapMaxMs.toFixed(1)}ms ` +
        `over100=${netDiag.gapOver100} over200=${netDiag.gapOver200} ` +
        `| fps=${fps.toFixed(0)} ` +
        `frame mean=${meanFrameMs.toFixed(1)}ms max=${frameDiag.totalMsMax.toFixed(1)}ms ` +
        `sim mean=${meanSimulationMs.toFixed(2)}ms max=${frameDiag.simulationMsMax.toFixed(2)}ms ` +
        `render mean=${meanRenderMs.toFixed(2)}ms max=${frameDiag.renderMsMax.toFixed(2)}ms`,
    );
    frameDiag.frames = 0;
    frameDiag.totalMsSum = 0;
    frameDiag.totalMsMax = 0;
    frameDiag.renderMsSum = 0;
    frameDiag.renderMsMax = 0;
    frameDiag.simulationMsSum = 0;
    frameDiag.simulationMsMax = 0;
    netDiag.windowStart = recvAtMs;
    netDiag.snaps = 0;
    netDiag.gapSumMs = 0;
    netDiag.gapMaxMs = 0;
    netDiag.gapOver100 = 0;
    netDiag.gapOver200 = 0;
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

// Diagnostic hooks for E2E / browser debugging. Only exposed in dev (Vite
// sets DEV; production builds skip this) so production bundles do not ship
// the internals to the window object.
if (import.meta.env.DEV) {
  const devWindow = window as unknown as { __scene: unknown; __playerUI: PlayerUI };
  devWindow.__scene = scene;
  devWindow.__playerUI = playerUI;
}

let localId: PlayerId | null = null;
let connected = false;
let isDebug = false;
let lastSnapTick = 0;
let lastSpeed = 0;
let lastRpm = 0;
let lastGear = 0;
let lastFrameTimeMs = performance.now();
let mapWorld: Maps.MapWorld | null = null;
let localSimulation: LocalSimulation | null = null;
/** Driving a map handed over by the editor, with no server and no socket.
 *  Set before any NetClient exists, and never unset. */
let previewMode = false;
let previewMapName = '';
let stateUploadReady = false;
let stateUploadAcc = 0;
let stateSeq = 0;

// The owner simulation advances at a fixed 60 Hz cadence. The accumulator
// is decoupled from rendering so a 30 FPS display still gets two physics
// steps per frame and the truck's handling does not change with frame rate.
let inputAcc = 0;
/** Last sampled steer (-1..1) cached across render frames. Drives the local
 *  truck's front-wheel mesh visual override. */
let lastInputSteer = 0;
const HARD_STEP_CAP = 12; // catastrophic-stall safety net

let fps = 0;
let frameCount = 0;
let lastFpsUpdate = performance.now();

/** Compose a map, install it everywhere, and build the local sim.
 *
 *  One function for both ways in — the welcome handshake and the offline
 *  preview. It used to live inside the onWelcome closure, which is why
 *  there was no way to enter a world without a server telling you to. */
function enterWorld(
  doc: Maps.MapDoc,
  spawn: { position: { x: number; y: number; z: number }; yaw?: number },
  carKind: CarKind,
  id: PlayerId,
): void {
  localId = id;
  scene.setLocalPlayer(id, carKind);
  // Compose the map ONCE and share it everywhere it's needed: the terrain
  // mesh, obstacles, landmarks, the surface-name HUD lookup, and the
  // local sim. It used to be regenerated five times from the same seed
  // at every (re)connect.
  mapWorld = Maps.applyMapDoc(doc);
  scene.setWorld(mapWorld);
  // Build the local sim. Same map + spawn as the server when there is one,
  // so the local Rapier world integrates against an identical heightmap and
  // obstacle set and starts at the same pose.
  localSimulation?.dispose();
  localSimulation = new LocalSimulation(mapWorld, spawn, carKind);
  inputAcc = 0;
  stateUploadAcc = 0;
  stateSeq = 0;
  if (import.meta.env.DEV) {
    (window as unknown as { __localSimulation: unknown }).__localSimulation = localSimulation;
  }
}

/** Camera cycling and pointer-drag orbit. Wanted by both the online path
 *  and the preview, so it does not live inside either. */
function wireCameraControls(): void {
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
}

/** Drive the map the editor stashed, offline.
 *
 *  No socket, no join screen, no chat: those are all wired inside the
 *  online path, so preview mode gets none of them without a single
 *  suppression check. The truck uses the same standalone LocalSimulation
 *  as online play; preview simply omits state upload and remote proxies. */
function startPreview(params: URLSearchParams, savedCar: CarKind | undefined): void {
  const payload = readPreview();
  if (!payload) {
    playerUI.setConnectionState({ mode: 'missing-preview' });
    return;
  }
  previewMode = true;
  previewMapName = payload.doc.name || payload.doc.id;
  playerUI.setConnectionState({ mode: 'preview', mapName: previewMapName });
  const carParam = params.get('car');
  const carKind = carParam ? normalizeCarKind(carParam) : (savedCar ?? payload.carKind);

  // Composed once here purely to resolve the spawn, then again inside
  // enterWorld. The alternative is threading a half-built world through,
  // which costs more clarity than the ~50 ms buys back on a page that has
  // just loaded a WASM blob.
  const world = Maps.applyMapDoc(payload.doc);
  const spawn = Maps.resolveSpawn(world, 0, carKind);
  enterWorld(payload.doc, spawn, carKind, 'preview');

  installPreviewControls(spawn, carKind);
  wireCameraControls();
  requestAnimationFrame(frame);
}

/** Esc closes the tab; Shift+R re-seats the truck upright where it stands.
 *
 *  Plain R already respawns at the start via the reset button, which is
 *  useless when the thing you are testing is 300 m out and you have just
 *  rolled onto the roof beside it. */
function installPreviewControls(spawn: Maps.SpawnPose, carKind: CarKind): void {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      // Valid because the editor opened this tab with window.open.
      window.close();
      playerUI.setConnectionState({
        mode: 'preview',
        message: 'close this tab to return to the editor',
      });
      return;
    }
    if (e.code === 'KeyR' && e.shiftKey && localSimulation) {
      e.preventDefault();
      const p = scene.localPosition();
      if (!p || !mapWorld) {
        localSimulation.resetTo(spawn);
        return;
      }
      const idx = Physics.worldToTerrainIndex(mapWorld.terrain, p.x, p.z);
      const ground = idx >= 0 ? (mapWorld.terrain.heights[idx] ?? 0) : 0;
      localSimulation.resetTo({
        position: { x: p.x, y: ground + Physics.spawnYAboveGround(carKind), z: p.z },
        yaw: spawn.yaw,
      });
    }
  });
}

async function start(): Promise<void> {
  // Rapier WASM init - needed before the local simulation World can be
  // constructed (and by terrain generation helpers in the shared package).
  await Physics.initRapier();

  // Show the name + car picker on every load so the player can pick a
  // different rig if they want; previous name + car are pre-filled from
  // localStorage so the common case is one Enter to drive. URL param
  // ?auto=1 skips the picker entirely (used by e2e tests).
  const params = new URLSearchParams(location.search);
  const saved = loadSavedJoin();

  // Previewing a map the editor handed over. Checked before the join
  // screen and before any NetClient exists: there is no server in this
  // mode, so there is nothing to join and no name to pick.
  if (params.get('preview') === '1') {
    startPreview(params, saved?.carKind);
    return;
  }

  const auto = params.get('auto') === '1';
  let choice: JoinChoice;
  if (auto) {
    const carParam = params.get('car');
    choice = {
      name: params.get('name') || saved?.name || `player-${Math.floor(Math.random() * 1000)}`,
      carKind: carParam ? normalizeCarKind(carParam) : (saved?.carKind ?? 'patrol'),
    };
  } else {
    choice = await showJoinScreen(saved ?? {});
    saveJoin(choice);
  }
  playerUI.setConnectionState({
    mode: 'connecting',
    message: 'connecting to rally control…',
    driverName: choice.name,
  });

  // Debug panel: only for the player named "jack" (case-insensitive).
  // Lets them twist physics tunables in flight and copy the result to
  // clipboard so the values can be baked as new defaults.
  isDebug = isDebugUser(choice.name);
  if (isDebug) initDebugPanel();

  // Auto-reconnect with exponential backoff. The welcome handshake
  // rebuilds everything session-scoped (id, terrain, local physics world),
  // so reconnecting is just "connect again": the server treats us as a
  // fresh player. Backoff resets once a connection sticks.
  let reconnectDelayMs = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const net = new NetClient(getServerUrl(), choice.name, choice.carKind, {
    onOpen() {
      connected = true;
      stateUploadReady = false;
      reconnectDelayMs = 1000;
      playerUI.setConnectionState({ mode: 'connected', driverName: choice.name });
      chat.pushSystem('connected — press T to chat');
    },
    onWelcome(id, _serverTimeMs, map, spawn) {
      // The server names a map; this build supplies it. A map it does not
      // have, or has at a different revision, means the two bundles
      // disagree about the ground — refuse rather than drive on it.
      const resolved = resolveHandshakeMap(map);
      if (!resolved.ok) {
        net.abort(resolved.reason);
        return;
      }
      enterWorld(resolved.doc, spawn, choice.carKind, id);
      stateUploadReady = true;
      playerUI.setConnectionState({
        mode: 'connected',
        driverName: choice.name,
        mapName: resolved.doc.name || resolved.doc.id,
      });
    },
    onSnapshot(snap, recvAtMs) {
      lastSnapTick = snap.tick;
      scene.pushSnapshot(snap, recvAtMs);
      netDiagOnSnapshot(recvAtMs);
      // Owner physics is intentionally untouched. The snapshot exists for
      // remote-player interpolation and membership only.
    },
    onChat(from, fromName, text) {
      chat.push(fromName, text, from === localId);
    },
    onClose(reason, fatal) {
      connected = false;
      stateUploadReady = false;
      // A fatal close is one retrying cannot fix (protocol-version
      // mismatch). Leave the reason on screen instead of burying it under
      // a retry countdown that would never succeed.
      if (fatal) {
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        playerUI.setConnectionState({
          mode: 'fatal',
          message: reason,
          driverName: choice.name,
        });
        chat.pushSystem(reason);
        return;
      }
      if (reconnectTimer !== null) return; // attempt already queued
      const delayS = (reconnectDelayMs / 1000).toFixed(0);
      playerUI.setConnectionState({
        mode: 'reconnecting',
        message: `disconnected: ${reason} — reconnecting in ${delayS}s`,
        driverName: choice.name,
      });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        playerUI.setConnectionState({
          mode: 'reconnecting',
          message: 'reconnecting…',
          driverName: choice.name,
        });
        net.connect();
      }, reconnectDelayMs);
      reconnectDelayMs = Math.min(15_000, reconnectDelayMs * 2);
    },
  });
  currentNet = net;
  net.connect();

  wireCameraControls();

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

  requestAnimationFrame(frame);
}

// Render loop. Module scope rather than closed over a NetClient, because
// the preview path never builds one.
function frame(): void {
  const now = performance.now();
  const frameDt = Math.min(0.25, (now - lastFrameTimeMs) / 1000);
  lastFrameTimeMs = now;

  frameCount++;
  if (now - lastFpsUpdate >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastFpsUpdate = now;
  }

  // Preview drives the same accumulator with no socket on the other end.
  const simulationStart = performance.now();
  if (localSimulation && !previewMode) {
    localSimulation.syncRemoteVehicles(scene.remoteCollisionStates(), now);
  }
  if (connected || previewMode) {
    inputAcc += frameDt;
    let steps = 0;
    while (inputAcc >= FIXED_DT && steps < HARD_STEP_CAP) {
      const input = sampleInput();
      if (localSimulation) localSimulation.step(input);
      lastInputSteer = input.steer;
      inputAcc -= FIXED_DT;
      steps += 1;
    }
    if (steps >= HARD_STEP_CAP) inputAcc = 0;
    scene.setLocalInputSteer(lastInputSteer);
  }
  const simulationMs = performance.now() - simulationStart;
  // Render between the two completed fixed steps. This is one fixed tick
  // behind the canonical body but remains smooth at every display rate.
  if (localSimulation) {
    const ps = localSimulation.state(inputAcc / FIXED_DT);
    scene.setLocalVehiclePose(ps.position, ps.rotation, ps.wheels, ps.axles);
    if (previewMode) scene.setLocalVehicleState(localSimulation.vehicleState());
    updateAxleDebug(ps.axles[0], ps.axles[1]);
    const telemetry = localSimulation.telemetry();
    lastSpeed = telemetry.speed;
    lastRpm = telemetry.rpm;
    lastGear = telemetry.gear;
    engineAudio.set(telemetry.rpm, telemetry.throttle);

    // Publish canonical owner state independently of render/physics cadence.
    // At 30 Hz this matches the existing remote snapshot interpolation rate
    // without sending a redundant state on every 60 Hz simulation step.
    if (connected && stateUploadReady && !previewMode) {
      stateUploadAcc += frameDt;
      const interval = 1 / SNAPSHOT_RATE;
      if (stateUploadAcc >= interval) {
        stateUploadAcc %= interval;
        currentNet?.sendVehicleState({
          seq: ++stateSeq,
          vehicle: localSimulation.vehicleState(),
        });
      }
    }
  }

  const renderStart = performance.now();
  scene.render(now);
  const renderMs = performance.now() - renderStart;

  const frameTotalMs = performance.now() - now;
  frameDiag.frames += 1;
  frameDiag.totalMsSum += frameTotalMs;
  if (frameTotalMs > frameDiag.totalMsMax) frameDiag.totalMsMax = frameTotalMs;
  frameDiag.renderMsSum += renderMs;
  if (renderMs > frameDiag.renderMsMax) frameDiag.renderMsMax = renderMs;
  frameDiag.simulationMsSum += simulationMs;
  if (simulationMs > frameDiag.simulationMsMax) frameDiag.simulationMsMax = simulationMs;

  if (connected || previewMode) updateHud();
  requestAnimationFrame(frame);
}

function surfaceLabel(): string {
  const lp = scene.localPosition();
  if (!mapWorld || !lp) return '';
  const s = Physics.sampleSurface(mapWorld.terrain, lp.x, lp.z);
  const label = Physics.surfaceInfo(s).label;
  // The bed is still what you are driving on, so it stays the headline;
  // depth is what decides whether to commit to the crossing.
  const depth = Physics.sampleWaterDepth(mapWorld.terrain, lp.x, lp.z);
  return depth > 0.02 ? `${label} · water ${depth.toFixed(2)} m` : label;
}

/** Flooded-engine prompt. A truck that has gone silent and will not
 *  respond to the throttle needs to say why and say what to press. */
function engineStatusLabel(): string {
  const w = localSimulation?.waterStatus();
  if (!w) return '';
  if (w.drowned) return 'ENGINE FLOODED — HOLD E';
  if (w.intakeSubmerged) return 'INTAKE UNDER';
  return '';
}

function updateHud(): void {
  const handbrake = Boolean(isHandbrakeOn() || getTouchState().handbrake);
  if (previewMode) {
    // Telemetry comes off the local sim: there are no snapshots to read it
    // from, and the values the online HUD shows arrive in those.
    const t = localSimulation?.telemetry();
    playerUI.updateTelemetry({
      speedMps: t?.speed ?? 0,
      rpm: t?.rpm ?? 0,
      gear: t?.gear ?? 0,
      surface: surfaceLabel(),
      handbrake,
      engineStatus: engineStatusLabel(),
      fps,
      previewDiagnostic: 'offline physics',
    });
    return;
  }
  playerUI.updateTelemetry({
    speedMps: lastSpeed,
    rpm: lastRpm,
    gear: lastGear,
    surface: surfaceLabel(),
    handbrake,
    engineStatus: engineStatusLabel(),
    tick: lastSnapTick,
    fps,
    previewDiagnostic: '',
  });
}

start().catch((err) => {
  console.error(err);
  playerUI.setConnectionState({ mode: 'init-failed' });
});
