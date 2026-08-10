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
  Maps,
  Physics,
  FIXED_DT,
  SNAPSHOT_RATE,
  BUTTON_RESET,
  createStockBuild,
  normalizeVehicleBaseId,
  type PlayerId,
  type VehicleBuild,
} from '@mydrunner/shared';

import { EngineAudio } from './engineAudio.js';
import { loadSavedJoin, saveJoin, showJoinScreen, type JoinChoice } from './joinScreen.js';
import {
  applyStartOptions,
  createGameSave,
  loadGameSaves,
  loadStartOptions,
  showStartScreen,
  touchGameSave,
  updateGameSave,
} from './startScreen.js';
import { initChat } from './chat.js';
import {
  isDebugUser,
  initDebugPanel,
  updateAxleDebug,
  updateVehicleDebug,
} from './debugPanel.js';

import {
  initInput,
  sampleInput,
  clearKeys,
  isHandbrakeOn,
  requestTransferCase,
  setDrivetrainControlsEnabled,
  setManualGear,
} from './input.js';
import { getTouchState, initTouchInput, onTouchEdge } from './touchInput.js';
import { resolveHandshakeMap } from './mapLoad.js';
import { NetClient } from './net.js';
import { PlayerUI } from './playerUI.js';
import { Scene } from './scene.js';
import { LocalSimulation } from './localSimulation.js';
import { readPreview } from './previewHandoff.js';
import { WorkshopUI } from './workshop.js';
import { WinchController } from './winchController.js';
import { activeQuality } from './quality.js';

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
  onGearSelection: setManualGear,
  onTransferCaseSelection: requestTransferCase,
});

initInput();
initTouchInput();
const scene = new Scene(app);
const engineAudio = new EngineAudio();
const workshop = new WorkshopUI();
const workshopPrompt = document.createElement('button');
workshopPrompt.id = 'workshop-prompt';
workshopPrompt.type = 'button';
workshopPrompt.textContent = 'F · OPEN WORKSHOP';
document.body.appendChild(workshopPrompt);

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
/** Draw-call and triangle counts for the frame just rendered.
 *
 *  These are the numbers the batching work is judged by — "fewer draw calls"
 *  is otherwise an assertion rather than a measurement. `renderer.info` is a
 *  live snapshot of the last render, not a window average, so this reads the
 *  most recent frame rather than a mean; the counts are static enough between
 *  frames for that to be the useful figure.
 *
 *  Dev-only, like `window.__scene`: production bundles do not carry it. */
function drawStatsSuffix(): string {
  if (!import.meta.env.DEV) return '';
  const info = scene.renderer.info.render;
  return ` | draws=${info.calls} tris=${info.triangles}`;
}

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
        `render mean=${meanRenderMs.toFixed(2)}ms max=${frameDiag.renderMsMax.toFixed(2)}ms` +
        drawStatsSuffix(),
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
window.addEventListener('game-menu-mute', () => engineAudio.toggleMute());

// Diagnostic hooks for E2E / browser debugging. Only exposed in dev (Vite
// sets DEV; production builds skip this) so production bundles do not ship
// the internals to the window object.
if (import.meta.env.DEV) {
  const devWindow = window as unknown as {
    __scene: unknown;
    __playerUI: PlayerUI;
    __workshop: WorkshopUI;
  };
  devWindow.__scene = scene;
  devWindow.__playerUI = playerUI;
  devWindow.__workshop = workshop;
}

let localId: PlayerId | null = null;
let connected = false;
let isDebug = false;
let lastSnapTick = 0;
let lastSpeed = 0;
let lastRpm = 0;
let lastGear = 0;
let lastTransferCase: '2h' | '4h' | '4l' = '4h';
let lastFrontLocked = false;
let lastRearLocked = false;
let lastBodyCondition = 1;
let lastEngineCondition = 1;
let lastSteeringCondition = 1;
let lastStoppedCause: 'none' | 'collision' | 'flooding' = 'none';
let drivetrainNotice = '';
let drivetrainNoticeUntil = 0;
let lastFrameTimeMs = performance.now();
let mapWorld: Maps.MapWorld | null = null;
/** The menu uses the shipped map before networking starts. If the welcome
 *  selects that same document, reuse the composition instead of generating
 *  the terrain and hundreds of obstacle placements a second time. */
let stagedMenuWorld: Maps.MapWorld | null = null;
let localSimulation: LocalSimulation | null = null;
let currentBuild: VehicleBuild = createStockBuild();
let currentBuildRevision = 1;
let nearbyBayId: string | null = null;
let workshopLeaseId: string | null = null;
let workshopPose: { position: { x: number; y: number; z: number }; yaw: number } | null = null;
let workshopEntryPending = false;
/** Driving a map handed over by the editor, with no server and no socket.
 *  Set before any NetClient exists, and never unset. */
let previewMode = false;
let previewMapName = '';
let stateUploadReady = false;
let rutSyncReady = false;
let rutGlobalSequence = 0;
let stateUploadAcc = 0;
let stateSeq = 0;

// The owner simulation advances at a fixed 60 Hz cadence. The accumulator
// is decoupled from rendering so a 30 FPS display still gets two physics
// steps per frame and the truck's handling does not change with frame rate.
let inputAcc = 0;
const HARD_STEP_CAP = 12; // catastrophic-stall safety net

let fps = 0;
let frameCount = 0;
let lastFpsUpdate = performance.now();

const winchController = new WinchController(scene, {
  simulation: () => localSimulation,
  net: () => currentNet,
  online: () => connected && !previewMode,
  blocked: () => chat.isOpen() || workshop.isOpen,
});
if (import.meta.env.DEV) {
  (window as unknown as { __winchController: WinchController }).__winchController = winchController;
}
onTouchEdge('winch', () => winchController.touchHook());

/** Compose a map, install it everywhere, and build the local sim.
 *
 *  One function for both ways in — the welcome handshake and the offline
 *  preview. It used to live inside the onWelcome closure, which is why
 *  there was no way to enter a world without a server telling you to. */
function enterWorld(
  doc: Maps.MapDoc,
  spawn: { position: { x: number; y: number; z: number }; yaw?: number },
  build: VehicleBuild,
  id: PlayerId,
): void {
  localId = id;
  currentBuild = build;
  configureDrivetrainControls(build);
  currentBuildRevision = 1;
  scene.setLocalPlayer(id, build, currentBuildRevision);
  // Compose the map ONCE and share it everywhere it's needed: the terrain
  // mesh, obstacles, landmarks, the surface-name HUD lookup, and the
  // local sim. It used to be regenerated five times from the same seed
  // at every (re)connect.
  const reuseMenuWorld = stagedMenuWorld?.doc === doc;
  mapWorld = reuseMenuWorld ? stagedMenuWorld! : Maps.applyMapDoc(doc);
  stagedMenuWorld = null;
  if (!reuseMenuWorld) scene.setWorld(mapWorld);
  // Build the local sim. Same map + spawn as the server when there is one,
  // so the local Rapier world integrates against an identical heightmap and
  // obstacle set and starts at the same pose.
  localSimulation?.dispose();
  localSimulation = new LocalSimulation(mapWorld, spawn, build, id);
  winchController.reset(id, build);
  inputAcc = 0;
  stateUploadAcc = 0;
  stateSeq = 0;
  if (import.meta.env.DEV) {
    (window as unknown as { __localSimulation: unknown }).__localSimulation = localSimulation;
  }
}

function configureDrivetrainControls(build: VehicleBuild): void {
  const fixedRwd = Physics.geomFor(build).spec.drivetrain === 'fixed-rwd';
  setDrivetrainControlsEnabled(!fixedRwd);
  for (const id of ['range-btn', 'rear-locker-btn', 'front-locker-btn']) {
    const control = document.getElementById(id);
    if (control) control.hidden = fixedRwd;
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
function startPreview(params: URLSearchParams, savedBuild: VehicleBuild | undefined): void {
  const payload = readPreview();
  if (!payload) {
    playerUI.setConnectionState({ mode: 'missing-preview' });
    return;
  }
  previewMode = true;
  previewMapName = payload.doc.name || payload.doc.id;
  playerUI.setConnectionState({ mode: 'preview', mapName: previewMapName });
  const carParam = params.get('car');
  const build = carParam
    ? createStockBuild(normalizeVehicleBaseId(carParam))
    : (savedBuild ?? createStockBuild(normalizeVehicleBaseId(payload.carKind)));

  // Composed once here purely to resolve the spawn, then again inside
  // enterWorld. The alternative is threading a half-built world through,
  // which costs more clarity than the ~50 ms buys back on a page that has
  // just loaded a WASM blob.
  const world = Maps.applyMapDoc(payload.doc);
  const spawn = Maps.resolveSpawn(world, 0, build);
  enterWorld(payload.doc, spawn, build, 'preview');

  installPreviewControls(spawn, build);
  wireCameraControls();
  requestAnimationFrame(frame);
}

/** Esc closes the tab; Shift+R re-seats the truck upright where it stands.
 *
 *  Plain R already respawns at the start via the reset button, which is
 *  useless when the thing you are testing is 300 m out and you have just
 *  rolled onto the roof beside it. */
function installPreviewControls(spawn: Maps.SpawnPose, build: VehicleBuild): void {
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
      winchController.detach();
      const p = scene.localPosition();
      if (!p || !mapWorld) {
        localSimulation.resetTo(spawn);
        return;
      }
      const idx = Physics.worldToTerrainIndex(mapWorld.terrain, p.x, p.z);
      const ground = idx >= 0 ? (mapWorld.terrain.heights[idx] ?? 0) : 0;
      localSimulation.resetTo({
        position: { x: p.x, y: ground + Physics.spawnYAboveGround(build), z: p.z },
        yaw: spawn.yaw,
      });
    }
  });
}

async function start(): Promise<void> {
  // Resolve startup UI before compiling Rapier's WASM. This gets the menu on
  // screen immediately on cold/mobile loads instead of showing a blank HUD
  // while the physics runtime initialises. ?auto=1 remains the direct path
  // used by e2e tests.
  const params = new URLSearchParams(location.search);
  const saved = loadSavedJoin();
  const startOptions = loadStartOptions();
  applyStartOptions(startOptions);
  engineAudio.setMuted(!startOptions.engineAudio);

  // Previewing a map the editor handed over. Checked before the join
  // screen and before any NetClient exists: there is no server in this
  // mode, so there is nothing to join and no name to pick.
  if (params.get('preview') === '1') {
    isDebug = params.has('dev');
    if (isDebug) {
      initDebugPanel();
      scene.setVehicleDebugEnabled(true);
    }
    await Physics.initRapier();
    startPreview(params, saved?.build);
    return;
  }

  const auto = params.get('auto') === '1';
  let choice: JoinChoice;
  let activeSaveId: string | null = null;
  if (auto) {
    const carParam = params.get('car');
    choice = {
      name: params.get('name') || saved?.name || `player-${Math.floor(Math.random() * 1000)}`,
      build: carParam ? createStockBuild(normalizeVehicleBaseId(carParam)) : (saved?.build ?? createStockBuild()),
      carKind: carParam ? normalizeVehicleBaseId(carParam) : (saved?.build.baseId ?? 'ridgeback'),
    };
  } else {
    const launchPromise = showStartScreen({
      saves: loadGameSaves(saved),
      // Authoring links are normally a development-build feature, but a
      // deployed build can opt in explicitly with /?dev.
      development: import.meta.env.DEV || params.has('dev'),
      options: startOptions,
      onOptionsChanged(options) {
        engineAudio.setMuted(!options.engineAudio);
      },
    });
    // Build the real shipped world only after showStartScreen has synchronously
    // mounted its UI. That preserves the instant first paint on cold/mobile
    // loads while giving the menu a live terrain, water, foliage and sky view.
    let menuPanoramaFrame = 0;
    let menuPanoramaRunning = true;
    try {
      const menuDoc = Maps.getMap(Maps.DEFAULT_MAP_ID);
      if (menuDoc) {
        stagedMenuWorld = Maps.applyMapDoc(menuDoc);
        scene.setWorld(stagedMenuWorld);
        const startedAtMs = performance.now();
        const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        // Capped at the low tier. This renders the whole world behind the
        // start menu, which on a phone means thermal throttling sets in
        // before the player has pressed anything. It is a slow camera pan
        // along a spline, so it survives a lower rate with nothing visible
        // lost. Skipped entirely while the tab is hidden — rAF usually
        // stops there anyway, but not on every browser.
        const panoramaIntervalMs = 1000 / activeQuality().menuPanoramaHz;
        let lastPanoramaMs = 0;
        const drawMenuPanorama = (nowMs: number): void => {
          if (!menuPanoramaRunning) return;
          menuPanoramaFrame = requestAnimationFrame(drawMenuPanorama);
          if (document.visibilityState === 'hidden') return;
          if (nowMs - lastPanoramaMs < panoramaIntervalMs) return;
          lastPanoramaMs = nowMs;
          scene.renderMenuPanorama(nowMs, startedAtMs, animate);
        };
        menuPanoramaFrame = requestAnimationFrame(drawMenuPanorama);
      }
    } catch (error) {
      // The CSS treatment remains a complete fallback if a future authored
      // map cannot be composed. Startup should still let the player connect
      // and surface the normal map-handshake error there.
      console.warn('[mydrunner-client] menu panorama unavailable', error);
      stagedMenuWorld = null;
    }

    const launch = await launchPromise;
    if (launch.type === 'play') {
      activeSaveId = launch.save.id;
      const played = touchGameSave(launch.save.id) ?? launch.save;
      choice = { name: played.name, build: played.build, carKind: played.build.baseId };
    } else {
      // A new slot starts with the previous rig as a convenience, but leaves
      // the driver name blank so it cannot silently overwrite an identity.
      choice = await showJoinScreen(saved?.build ? { build: saved.build, carKind: saved.build.baseId } : {});
      const created = createGameSave(choice);
      activeSaveId = created.id;
    }
    menuPanoramaRunning = false;
    if (menuPanoramaFrame) cancelAnimationFrame(menuPanoramaFrame);
    saveJoin(choice);
  }

  // Needed before a LocalSimulation can be constructed by the welcome
  // handshake. The menu gesture has already happened on the interactive path.
  await Physics.initRapier();
  playerUI.setConnectionState({
    mode: 'connecting',
    message: 'connecting to rally control…',
    driverName: choice.name,
  });

  // `?dev` is the explicit physics-lab switch. Keep the old saved-name
  // shortcut so existing local tuning saves still behave as before.
  isDebug = params.has('dev') || isDebugUser(choice.name);
  if (isDebug) {
    initDebugPanel();
    scene.setVehicleDebugEnabled(true);
  }

  // Auto-reconnect with exponential backoff. The welcome handshake
  // rebuilds everything session-scoped (id, terrain, local physics world),
  // so reconnecting is just "connect again": the server treats us as a
  // fresh player. Backoff resets once a connection sticks.
  let reconnectDelayMs = 1000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const net = new NetClient(getServerUrl(), choice.name, choice.build, {
    onOpen() {
      connected = true;
      stateUploadReady = false;
      rutSyncReady = false;
      rutGlobalSequence = 0;
      reconnectDelayMs = 1000;
      playerUI.setConnectionState({ mode: 'connected', driverName: choice.name });
      chat.pushSystem('connected — press T to chat');
    },
    onWelcome(id, _serverTimeMs, map, spawn, build) {
      // The server names a map; this build supplies it. A map it does not
      // have, or has at a different revision, means the two bundles
      // disagree about the ground — refuse rather than drive on it.
      const resolved = resolveHandshakeMap(map);
      if (!resolved.ok) {
        net.abort(resolved.reason);
        return;
      }
      enterWorld(resolved.doc, spawn, build, id);
      stateUploadReady = false;
      playerUI.setConnectionState({
        mode: 'connected',
        driverName: choice.name,
        mapName: resolved.doc.name || resolved.doc.id,
      });
    },
    onSnapshot(snap, recvAtMs) {
      lastSnapTick = snap.tick;
      scene.pushSnapshot(snap, recvAtMs);
      winchController.setLinks(snap.winches ?? []);
      netDiagOnSnapshot(recvAtMs);
      if (localId) {
        const me = snap.players.find((player) => player.id === localId);
        if (me && workshop.isOpen && !me.workshopMode && workshopLeaseId) {
          workshop.setStatus('Workshop lease expired.', true);
          workshop.close();
          localSimulation?.exitWorkshop();
          workshopLeaseId = null;
          workshopPose = null;
        }
      }
      // Owner physics is intentionally untouched. The snapshot exists for
      // remote-player interpolation and membership only.
    },
    onRutSyncStart() {
      rutSyncReady = false;
      stateUploadReady = false;
    },
    onRutTile(msg) {
      localSimulation?.applyRutTile(msg.tile);
      scene.applyRutTile(msg.tile);
    },
    onRutSyncEnd(msg) {
      rutGlobalSequence = msg.globalSequence;
      rutSyncReady = true;
      stateUploadReady = true;
    },
    onRutBatch(msg) {
      const ordered = [...msg.stamps]
        .sort((a, b) => a.globalSequence - b.globalSequence)
        .filter((stamp) => stamp.globalSequence > rutGlobalSequence);
      if (ordered.length === 0) return;
      rutGlobalSequence = ordered[ordered.length - 1]!.globalSequence;
      localSimulation?.applyRutStamps(ordered);
      scene.applyRutStamps(ordered);
    },
    onRutResult(msg) {
      localSimulation?.resolveRutStamp(msg.ownerSequence, msg.accepted, msg.globalSequence);
      scene.resolveRutStamp(msg.ownerSequence, msg.accepted, msg.globalSequence);
    },
    onChat(from, fromName, text) {
      chat.push(fromName, text, from === localId);
    },
    onClose(reason, fatal) {
      connected = false;
      stateUploadReady = false;
      rutSyncReady = false;
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
    onWorkshopAck(msg) {
      if (msg.action === 'enter') workshopEntryPending = false;
      if (!msg.ok) {
        workshop.setBusy(false);
        workshop.setStatus(msg.reason ?? 'Workshop request rejected.', true);
        if (msg.action === 'enter') chat.pushSystem(msg.reason ?? 'workshop entry rejected');
        return;
      }
      if (msg.action === 'enter' && msg.leaseId && msg.pose && msg.build) {
        winchController.detach();
        workshopLeaseId = msg.leaseId;
        workshopPose = msg.pose;
        localSimulation?.enterWorkshop(msg.pose);
        workshop.open(msg.build, {
          onApply: (nextBuild) => net.applyBuild(msg.leaseId!, nextBuild),
          onExit: () => net.exitWorkshop(msg.leaseId!),
          onRepair: () => localSimulation?.repair(),
        });
        return;
      }
      if (msg.action === 'apply' && msg.build && msg.pose && msg.buildRevision !== undefined) {
        currentBuild = msg.build;
        configureDrivetrainControls(msg.build);
        winchController.setBuild(msg.build);
        currentBuildRevision = msg.buildRevision;
        workshopPose = msg.pose;
        workshop.confirmApplied(msg.build);
        localSimulation?.applyBuild(msg.build, msg.pose);
        if (localId) scene.setLocalPlayer(localId, msg.build, msg.buildRevision);
        choice.build = msg.build;
        choice.carKind = msg.build.baseId;
        saveJoin(choice);
        if (activeSaveId) updateGameSave(activeSaveId, choice);
        if (workshopLeaseId) net.exitWorkshop(workshopLeaseId);
        return;
      }
      if (msg.action === 'exit') {
        localSimulation?.exitWorkshop();
        workshop.close();
        workshopLeaseId = null;
        workshopPose = null;
      }
    },
    onWinchAck(msg) {
      winchController.onAck(msg);
    },
    onWinchEvent(msg) {
      winchController.onEvent(msg.linkId, msg.reason);
    },
  });
  currentNet = net;
  net.connect();

  wireCameraControls();

  const requestWorkshop = (): void => {
    if (!nearbyBayId || workshopEntryPending || workshop.isOpen) return;
    workshopEntryPending = true;
    winchController.detach();
    workshopPrompt.classList.remove('visible');
    net.enterWorkshop(nearbyBayId);
  };
  workshopPrompt.addEventListener('click', requestWorkshop);
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyF' && !event.repeat && !chat.isOpen()) {
      event.preventDefault();
      requestWorkshop();
    }
  });

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
  const touch = getTouchState();
  winchController.update(touch.winchIn > 0, touch.winchOut > 0);
  if (localSimulation && !previewMode) {
    localSimulation.syncRemoteVehicles(scene.remoteCollisionStates(), now);
  }
  if ((connected && rutSyncReady) || previewMode) {
    inputAcc += frameDt;
    let steps = 0;
    while (inputAcc >= FIXED_DT && steps < HARD_STEP_CAP) {
      const input = sampleInput();
      if ((input.buttons & BUTTON_RESET) !== 0) winchController.detach();
      if (localSimulation) localSimulation.step(input);
      const rutStamp = !previewMode ? localSimulation?.createRutStampCandidate() : null;
      if (rutStamp) {
        scene.predictRutStamp(rutStamp);
        currentNet?.sendRutStamp(rutStamp);
      }
      winchController.afterStep();
      inputAcc -= FIXED_DT;
      steps += 1;
    }
    if (steps >= HARD_STEP_CAP) inputAcc = 0;
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
    if (isDebug) {
      const debugTelemetry = localSimulation.debugTelemetry();
      if (debugTelemetry) {
        updateVehicleDebug(debugTelemetry);
        scene.updateVehicleDebug(debugTelemetry);
      }
    }
    lastSpeed = telemetry.speed;
    lastRpm = telemetry.rpm;
    lastGear = telemetry.gear;
    lastTransferCase = telemetry.drivetrain.transferCase;
    lastFrontLocked = telemetry.drivetrain.frontLocked;
    lastRearLocked = telemetry.drivetrain.rearLocked;
    lastBodyCondition = telemetry.damage.body;
    lastEngineCondition = telemetry.damage.engine;
    lastSteeringCondition = telemetry.damage.steering;
    lastStoppedCause = telemetry.damage.stoppedCause;
    if (telemetry.notice) {
      drivetrainNotice = telemetry.notice;
      drivetrainNoticeUntil = now + 2600;
    }
    engineAudio.set(telemetry.rpm, telemetry.throttle);
    const winchAudio = winchController.audioState();
    engineAudio.setWinch(winchAudio.motor, winchAudio.load, winchAudio.status);
    if (winchController.consumeBreakCue()) engineAudio.playWinchBreak();

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
          winch: winchController.runtime(),
        });
      }
    }
  }

  updateWorkshopPrompt();

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
  if (lastStoppedCause === 'collision') return 'ENGINE STOPPED — COLLISION DAMAGE';
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
      transferCase: t?.drivetrain.transferCase ?? '4h',
      frontLocked: t?.drivetrain.frontLocked ?? false,
      rearLocked: t?.drivetrain.rearLocked ?? false,
      fixedRwd: Physics.geomFor(currentBuild).spec.drivetrain === 'fixed-rwd',
      bodyCondition: t?.damage.body ?? 1,
      engineCondition: t?.damage.engine ?? 1,
      steeringCondition: t?.damage.steering ?? 1,
      drivetrainNotice: performance.now() < drivetrainNoticeUntil ? drivetrainNotice : '',
      winchStatus: winchController.statusText(),
      pressure: localSimulation?.pressureStatus(),
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
    transferCase: lastTransferCase,
    frontLocked: lastFrontLocked,
    rearLocked: lastRearLocked,
    fixedRwd: Physics.geomFor(currentBuild).spec.drivetrain === 'fixed-rwd',
    bodyCondition: lastBodyCondition,
    engineCondition: lastEngineCondition,
    steeringCondition: lastSteeringCondition,
    drivetrainNotice: performance.now() < drivetrainNoticeUntil ? drivetrainNotice : '',
    winchStatus: winchController.statusText(),
    pressure: localSimulation?.pressureStatus(),
  });
}

function updateWorkshopPrompt(): void {
  nearbyBayId = null;
  if (!connected || previewMode || workshop.isOpen || workshopLeaseId || workshopEntryPending || !mapWorld || !localSimulation) {
    workshopPrompt.classList.remove('visible');
    return;
  }
  const state = localSimulation.vehicleState();
  const speed = Math.hypot(state.linVel.x, state.linVel.y, state.linVel.z);
  const upY = 1 - 2 * (state.rotation.x ** 2 + state.rotation.z ** 2);
  if (speed > 0.8 || upY < 0.65) {
    workshopPrompt.classList.remove('visible');
    return;
  }
  for (const marker of mapWorld.markers) {
    if (marker.kind !== 'garageBay') continue;
    if (Math.hypot(state.position.x - marker.x, state.position.z - marker.z) <= marker.radius) {
      nearbyBayId = marker.id;
      workshopPrompt.textContent = `F · OPEN ${marker.label.toUpperCase()}`;
      workshopPrompt.classList.add('visible');
      return;
    }
  }
  workshopPrompt.classList.remove('visible');
}

start().catch((err) => {
  console.error(err);
  playerUI.setConnectionState({ mode: 'init-failed' });
});
