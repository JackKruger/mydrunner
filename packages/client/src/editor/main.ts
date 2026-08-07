// Level editor entry point.
//
// Renders through the same WorldView the game uses, so the ground you
// sculpt is lit and textured exactly as it will be when someone drives
// it. Everything authoring-specific — fly camera, brushes, gizmos, the
// panel — lives beside this file and never leaks into the shared view.
//
// The editor never calls initRapier: it edits a document, it does not
// simulate one, so it skips instantiating the WASM entirely. The module
// still rides along in the shared chunk, because the map layer's
// obstacle and landmark helpers sit beside the collider builders that do
// import it — that is bundle weight, not startup cost.

import * as THREE from 'three';
import { Maps, Physics } from '@mydrunner/shared';

import { WorldView } from '../worldView.js';
import {
  copyToClipboard, downloadJson, moduleIdentifier, moduleSource, readMapFile,
} from './documentIo.js';
import { EditSession } from './editSession.js';
import { FlyCamera } from './flyCamera.js';
import { ObjectGhost } from './ghost.js';
import { BrushCursor, SpawnMarkers } from './gizmos.js';
import { Picker } from './pick.js';
import {
  applyKindDefaults, defaultToolState, isContinuous, isSculpt, stepYaw,
  TOOL_KEYS, type ToolId,
} from './tools.js';
import { EditorUi } from './ui.js';
import { writePreview } from '../previewHandoff.js';
import { loadSavedJoin } from '../joinScreen.js';

const app = document.getElementById('app')!;
const panelHost = document.getElementById('panel')!;

const view = new WorldView(app);
const camera = new FlyCamera(window.innerWidth / window.innerHeight, { x: 0, y: 60, z: 120 });
const picker = new Picker();
const cursor = new BrushCursor();
const spawnMarkers = new SpawnMarkers();
const ghost = new ObjectGhost();
view.scene.add(cursor.object);
view.scene.add(spawnMarkers.group);
view.scene.add(ghost.group);

const tools = defaultToolState();
let session: EditSession;
/** The document as opened. Kept so a save carries forward the fields the
 *  editor does not edit (base, roads, bogs, pad, markers). */
let openedDoc: Maps.MapDoc;
let bakeOnSave = false;

const ui = new EditorUi(panelHost, tools, {
  onToolChange: setTool,
  onNew: () => loadDoc(Maps.proceduralDoc(), 'new map from the procedural base'),
  onOpenFile: openFile,
  onSaveJson: saveJson,
  onCopyModule: copyModule,
  onPreview: previewInGame,
  onObjectKindChange: (kind) => {
    applyKindDefaults(tools, kind);
    ui.syncObject();
    setTool('object');
  },
  onAutoFlow: () => {
    const rect = session.autoFlow(tools.waterSpeed);
    if (!rect) {
      ui.status('no water to flow — paint some first');
      return;
    }
    syncWater(rect);
    ui.status(`flow derived from slope at ${tools.waterSpeed.toFixed(1)} m/s`);
  },
  onBakeChange: (v) => { bakeOnSave = v; },
  onUndo: () => applyHistory(session.undo(), 'undo'),
  onRedo: () => applyHistory(session.redo(), 'redo'),
  onIdChange: (v) => { openedDoc = { ...openedDoc, id: v.trim() || openedDoc.id }; },
  onNameChange: (v) => { openedDoc = { ...openedDoc, name: v }; },
});

loadDoc(Maps.proceduralDoc(), 'procedural base loaded');

// --- Document lifecycle ----------------------------------------------

function loadDoc(doc: Maps.MapDoc, message: string): void {
  try {
    session = EditSession.open(doc);
  } catch (err) {
    ui.status(`could not open: ${(err as Error).message}`, 'error');
    return;
  }
  openedDoc = doc;
  view.setWorld(session.world);
  camera.setGroundSampler((x, z) => view.heightAt(x, z));
  camera.lookAtPoint(0, view.heightAt(0, 0), 0, 140);
  refreshSpawnMarkers();
  ui.setIdentity(doc.id, doc.name);
  ui.status(message);
}

async function openFile(file: File): Promise<void> {
  try {
    loadDoc(await readMapFile(file), `opened ${file.name}`);
  } catch (err) {
    ui.status(`could not open ${file.name}: ${(err as Error).message}`, 'error');
  }
}

function currentDoc(): Maps.MapDoc {
  return session.toDoc(openedDoc, { bake: bakeOnSave });
}

function saveJson(): void {
  const name = downloadJson(currentDoc());
  ui.status(`saved ${name}${bakeOnSave ? ' (baked)' : ''}`);
}

async function copyModule(): Promise<void> {
  const doc = currentDoc();
  const ok = await copyToClipboard(moduleSource(doc));
  ui.status(
    ok ? `copied ${moduleIdentifier(doc.id)} module to clipboard`
       : 'clipboard blocked — use Save .json instead',
    ok ? 'info' : 'error',
  );
}

/** Hand the live document to the game page and open it in a new tab.
 *
 *  Baked, not raw. applyMapDoc refuses a document whose base has drifted
 *  under its edits, and the editor is precisely where drifted maps live —
 *  an unbaked handoff would refuse to preview the map you are repairing.
 *  A baked document also composes independently of the generator, so what
 *  you drive is exactly the ground you were just looking at.
 *
 *  A new tab, not a navigation: the editor has no autosave and the session
 *  lives only in memory, so navigating away would bin the user's work. */
function previewInGame(): void {
  const doc = session.toDoc(openedDoc, { bake: true });
  const written = writePreview(doc, loadSavedJoin()?.carKind ?? 'patrol');
  if (!written.ok) {
    ui.status(written.reason, 'error');
    return;
  }
  // No `noopener`: it would give the new tab a blank sessionStorage and the
  // document would never arrive.
  const tab = window.open('./index.html?preview=1', '_blank');
  ui.status(
    tab ? 'previewing in a new tab' : 'popup blocked — allow popups for this site',
    tab ? 'info' : 'error',
  );
}

function applyHistory(changed: boolean, what: string): void {
  if (!changed) {
    ui.status(`nothing to ${what}`);
    return;
  }
  // Undo can move any cell, so the whole grid is re-uploaded rather than
  // tracking which rect a reverted stroke covered.
  const mesh = view.terrainMesh;
  if (mesh) {
    mesh.updateHeights(Physics.fullGridRect(session.world.terrain));
    mesh.updateSurfaces(Physics.fullGridRect(session.world.terrain));
  }
  // Full rebuild rather than updateWater: an undo can take the map from
  // wet back to dry (or the reverse), and only refreshWater creates or
  // drops the mesh. Without this, undoing the first water stroke leaves
  // the river on screen.
  view.refreshWater(session.world.terrain);
  view.refreshObstacles(session.world.obstacles);
  refreshSpawnMarkers();
  ui.status(what);
}

function refreshSpawnMarkers(): void {
  spawnMarkers.set(session.spawnPoints, (x, z) => view.heightAt(x, z));
}

// --- Input ------------------------------------------------------------

function setTool(tool: ToolId): void {
  tools.tool = tool;
  ui.syncTool();
  if (tool !== 'object') ghost.hide();
  ui.status(`tool: ${tool}`);
}

const canvas = view.renderer.domElement;
let painting = false;
let lastPointer: { x: number; y: number } | null = null;
/** Ground point under the cursor. The stroke is applied from the render
 *  loop rather than from the pointermove handler: a brush is a rate, so it
 *  has to advance with elapsed time. Applying per event instead made the
 *  strength depend on how fast the mouse reported — a 120 Hz pointer
 *  sculpted twice as hard as a 60 Hz one — and holding the button still
 *  did nothing at all. */
let hoverHit: { x: number; y: number; z: number } | null = null;
/** Last pointer pixel over the canvas, kept until the pointer leaves.
 *
 *  Separate from `lastPointer`, which only exists to give the look-drag its
 *  delta and is cleared on pointerup. The gizmos need the pixel to survive
 *  that, because they are re-raycast from the render loop: they used to
 *  update only on pointermove, so flying the camera left the brush ring
 *  sitting where the ground *used* to be — and a placement ghost with that
 *  bug hangs visibly in mid-air. */
let hoverPx: { x: number; y: number } | null = null;
/** Re-raycasting the 128² terrain mesh is not free, so it only happens when
 *  the pointer or the camera actually moved. */
let gizmosDirty = true;
const lastCamPos = new THREE.Vector3();
const lastCamQuat = new THREE.Quaternion();

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 2) {
    camera.beginLook();
    return;
  }
  if (e.button !== 0) return;
  const hit = groundAt(e);
  if (!hit) return;
  hoverHit = hit;
  hoverPx = { x: e.clientX, y: e.clientY };
  if (isContinuous(tools.tool)) {
    session.beginStroke();
    painting = true;
  } else {
    applyClick(hit, e);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (camera.isLooking) {
    if (lastPointer) camera.look(e.clientX - lastPointer.x, e.clientY - lastPointer.y);
    lastPointer = { x: e.clientX, y: e.clientY };
    return;
  }
  lastPointer = { x: e.clientX, y: e.clientY };
  hoverPx = { x: e.clientX, y: e.clientY };
  gizmosDirty = true;
});

canvas.addEventListener('pointerleave', () => {
  hoverPx = null;
  hoverHit = null;
  cursor.hide();
  ghost.hide();
});

// Wheel aims the object about to be placed. The fly camera is keyboard-only
// so there is nothing to steal the gesture from, and preventDefault keeps
// the page from scrolling under the canvas.
canvas.addEventListener('wheel', (e) => {
  if (tools.tool !== 'object') return;
  e.preventDefault();
  tools.objectYaw = stepYaw(tools.objectYaw, e.deltaY > 0 ? 1 : -1);
  ui.syncObject();
  gizmosDirty = true;
}, { passive: false });

const endPointer = (e: PointerEvent): void => {
  if (e.button === 2 || camera.isLooking) camera.endLook();
  if (painting) {
    painting = false;
    session.endStroke();
    // Re-seat objects once, at the end: a rock on ground you just
    // lowered would otherwise hang in the air, and re-running the
    // generator per pointermove is far too slow to do inline.
    if (isSculpt(tools.tool)) {
      session.rebuildObjects();
      view.refreshObstacles(session.world.obstacles);
      refreshSpawnMarkers();
    }
  }
  lastPointer = null;
  // A fresh stroke must not inherit the last one's aim, or the flow
  // brush stamps a direction the player never dragged.
  lastStrokePoint = null;
  gizmosDirty = true;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function groundAt(e: { clientX: number; clientY: number }): { x: number; y: number; z: number } | null {
  const mesh = view.terrainMesh;
  if (!mesh) return null;
  return picker.ground(canvas, camera.camera, mesh.mesh, e.clientX, e.clientY);
}

/** Re-seat the brush ring and the placement ghost under the cursor.
 *  Driven from the render loop, so they track a moving camera. */
function updateGizmos(): void {
  if (!hoverPx) return;
  hoverHit = groundAt({ clientX: hoverPx.x, clientY: hoverPx.y });
  if (!hoverHit) {
    cursor.hide();
    ghost.hide();
    return;
  }
  cursor.update(hoverHit.x, hoverHit.z, tools.radius, (x, z) => view.heightAt(x, z));
  if (tools.tool === 'object') {
    const info = Physics.objectInfo(tools.objectKind);
    ghost.show(
      {
        id: session.previewId(),
        kind: tools.objectKind,
        size: tools.objectSize,
        height: tools.objectHeight,
        ...(info.dims.length !== undefined ? { length: tools.objectLength } : {}),
      },
      hoverHit.x, hoverHit.y, hoverHit.z, tools.objectYaw,
    );
  } else {
    ghost.hide();
  }
}

/** Push a water edit to the GPU.
 *
 *  Goes through refreshWater when the mesh does not exist yet: a dry map
 *  builds none, so the first stroke on one has nothing to update. */
function syncWater(rect: Physics.GridRect | null): void {
  if (!rect) return;
  const mesh = view.waterMesh;
  if (mesh) mesh.updateWater(rect);
  else view.refreshWater(session.world.terrain);
}

/** Previous stroke point, for the flow brush's drag direction. Cleared
 *  on pointer-up so a new stroke does not inherit the last one's aim. */
let lastStrokePoint: { x: number; z: number } | null = null;

function applyStroke(hit: { x: number; z: number }, dt: number): void {
  const mesh = view.terrainMesh;
  if (!mesh) return;
  if (isSculpt(tools.tool)) {
    const rect = session.sculpt(hit.x, hit.z, {
      radius: tools.radius,
      strength: tools.strength,
      hardness: tools.hardness,
      mode: tools.tool,
      dt,
    });
    if (rect) {
      mesh.updateHeights(rect);
      // Depth is level minus ground, so sculpting under standing water
      // changes the water without touching the water grid.
      if (view.waterMesh) view.waterMesh.updateWater(rect);
    }
  } else if (tools.tool === 'paint') {
    const rect = session.paint(hit.x, hit.z, { radius: tools.radius, surface: tools.surface });
    if (rect) mesh.updateSurfaces(rect);
  } else if (tools.tool === 'water') {
    applyWaterStroke(hit);
  }
  lastStrokePoint = { x: hit.x, z: hit.z };
}

function applyWaterStroke(hit: { x: number; z: number }): void {
  if (tools.waterMode === 'erase') {
    syncWater(session.eraseWater(hit.x, hit.z, { radius: tools.radius }));
    return;
  }
  if (tools.waterMode === 'flow') {
    // Direction comes from the drag itself, so aiming a river is the
    // same gesture as drawing it. A stationary pointer has no direction
    // and must not stamp one - it would freeze the last aim into every
    // cell the brush sat over.
    const prev = lastStrokePoint;
    if (!prev) return;
    const dx = hit.x - prev.x;
    const dz = hit.z - prev.z;
    if (Math.hypot(dx, dz) < 0.25) return;
    syncWater(session.paintFlow(hit.x, hit.z, {
      radius: tools.radius,
      dirX: dx,
      dirZ: dz,
      speed: tools.waterSpeed,
    }));
    return;
  }
  syncWater(session.paintWater(hit.x, hit.z, {
    radius: tools.radius,
    depth: tools.waterDepth,
  }));
}

/** The object the tool state currently describes, at (x, z).
 *
 *  `length` is written only for kinds that have a run: a rock carrying a
 *  meaningless length would still change the document's revision hash, and
 *  a ramp *without* one silently fell back to rampTransform's 3 m default —
 *  which is why editor-placed ramps ignored the length you dialled in. */
function placedFromTools(x: number, z: number): Omit<Maps.PlacedObject, 'id'> {
  const info = Physics.objectInfo(tools.objectKind);
  return {
    kind: tools.objectKind,
    x,
    z,
    size: tools.objectSize,
    height: tools.objectHeight,
    yaw: tools.objectYaw,
    ...(info.dims.length !== undefined ? { length: tools.objectLength } : {}),
  };
}

function applyClick(hit: { x: number; z: number }, e: PointerEvent): void {
  switch (tools.tool) {
    case 'object': {
      session.addObject(placedFromTools(hit.x, hit.z));
      view.refreshObstacles(session.world.obstacles);
      ghost.invalidate();
      ui.status(`placed ${Physics.objectInfo(tools.objectKind).label}`);
      break;
    }
    case 'spawn': {
      session.addSpawn({ x: hit.x, z: hit.z, yaw: tools.spawnYaw });
      refreshSpawnMarkers();
      ui.status(`spawn at ${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}`);
      break;
    }
    case 'delete': {
      const group = view.obstacleGroup;
      const id = group
        ? picker.obstacle(canvas, camera.camera, group, e.clientX, e.clientY)
        : null;
      if (id) {
        session.deleteObject(id);
        view.refreshObstacles(session.world.obstacles);
        ui.status(`deleted ${id}`);
      } else if (session.deleteSpawnNear(hit.x, hit.z, tools.radius)) {
        refreshSpawnMarkers();
        ui.status('deleted spawn');
      } else {
        ui.status('nothing to delete there');
      }
      break;
    }
    default:
      break;
  }
}

window.addEventListener('keydown', (e) => {
  if (isTextEntry(e.target)) return;
  const bound = TOOL_KEYS.find((t) => t.code === e.code);
  if (bound) {
    setTool(bound.tool);
    return;
  }
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    tools.objectYaw = stepYaw(tools.objectYaw, e.code === 'BracketRight' ? 1 : -1);
    ui.syncObject();
    gizmosDirty = true;
    return;
  }
  if (e.code === 'KeyZ' && !e.ctrlKey && !e.metaKey) { applyHistory(session.undo(), 'undo'); return; }
  if (e.code === 'KeyY') { applyHistory(session.redo(), 'redo'); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
    e.preventDefault();
    applyHistory(e.shiftKey ? session.redo() : session.undo(), e.shiftKey ? 'redo' : 'undo');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
    e.preventDefault();
    saveJson();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyP') {
    e.preventDefault();
    previewInGame();
    return;
  }
  camera.onKey(e.code, true);
});

window.addEventListener('keyup', (e) => camera.onKey(e.code, false));
// A window that loses focus mid-move never sees the keyup, so the camera
// would keep flying while the tab sat in the background.
window.addEventListener('blur', () => camera.clearKeys());

window.addEventListener('resize', () => {
  camera.setAspect(window.innerWidth / window.innerHeight);
  view.setSize(window.innerWidth, window.innerHeight);
});

function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// --- Render loop ------------------------------------------------------

let lastFrameMs = performance.now();

function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrameMs) / 1000);
  lastFrameMs = now;
  camera.update(dt);

  // A camera that moved puts different ground under a stationary cursor, so
  // the gizmos have to be re-seated even when no pointer event arrived.
  const cam = camera.camera;
  if (!cam.position.equals(lastCamPos) || !cam.quaternion.equals(lastCamQuat)) {
    lastCamPos.copy(cam.position);
    lastCamQuat.copy(cam.quaternion);
    gizmosDirty = true;
  }
  if (gizmosDirty) {
    updateGizmos();
    gizmosDirty = false;
  }

  if (painting && hoverHit) applyStroke(hoverHit, dt);
  view.render(camera.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Diagnostic hook for the e2e suite, dev-only like the game's __scene.
if (import.meta.env.DEV) {
  (window as unknown as { __editor: unknown }).__editor = {
    session: () => session,
    doc: () => currentDoc(),
    tools,
    setTool,
    ghost,
    view,
    camera,
    THREE,
  };
}
