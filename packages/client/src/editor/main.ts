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
import { BrushCursor, SpawnMarkers } from './gizmos.js';
import { Picker } from './pick.js';
import {
  defaultToolState, isContinuous, isSculpt, TOOL_KEYS, type ToolId,
} from './tools.js';
import { EditorUi } from './ui.js';

const app = document.getElementById('app')!;
const panelHost = document.getElementById('panel')!;

const view = new WorldView(app);
const camera = new FlyCamera(window.innerWidth / window.innerHeight, { x: 0, y: 60, z: 120 });
const picker = new Picker();
const cursor = new BrushCursor();
const spawnMarkers = new SpawnMarkers();
view.scene.add(cursor.object);
view.scene.add(spawnMarkers.group);

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
  ui.status(`tool: ${tool}`);
}

const canvas = view.renderer.domElement;
let painting = false;
let lastPointer: { x: number; y: number } | null = null;
/** Ground point under the cursor, refreshed on move. The stroke is
 *  applied from the render loop rather than from the pointermove
 *  handler: a brush is a rate, so it has to advance with elapsed time.
 *  Applying per event instead made the strength depend on how fast the
 *  mouse reported — a 120 Hz pointer sculpted twice as hard as a 60 Hz
 *  one — and holding the button still did nothing at all. */
let hoverHit: { x: number; y: number; z: number } | null = null;

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
  hoverHit = groundAt(e);
  if (!hoverHit) {
    cursor.hide();
    return;
  }
  cursor.update(hoverHit.x, hoverHit.z, tools.radius, (x, z) => view.heightAt(x, z));
});

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
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function groundAt(e: PointerEvent): { x: number; y: number; z: number } | null {
  const mesh = view.terrainMesh;
  if (!mesh) return null;
  return picker.ground(canvas, camera.camera, mesh.mesh, e.clientX, e.clientY);
}

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
    if (rect) mesh.updateHeights(rect);
  } else if (tools.tool === 'paint') {
    const rect = session.paint(hit.x, hit.z, { radius: tools.radius, surface: tools.surface });
    if (rect) mesh.updateSurfaces(rect);
  }
}

function applyClick(hit: { x: number; z: number }, e: PointerEvent): void {
  switch (tools.tool) {
    case 'object': {
      session.addObject({
        kind: tools.objectKind,
        x: hit.x,
        z: hit.z,
        size: tools.objectSize,
        height: tools.objectHeight,
        yaw: Math.random() * Math.PI * 2,
      });
      view.refreshObstacles(session.world.obstacles);
      ui.status(`placed ${tools.objectKind}`);
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
    view,
    camera,
    THREE,
  };
}
