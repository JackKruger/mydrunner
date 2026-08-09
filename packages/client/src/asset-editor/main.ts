import * as THREE from 'three';
import {
  blankDocument,
  cloneDocument,
  createPart,
  decodeAssetDocument,
  fileSafeName,
  nextPartId,
  type AssetDocument,
  type AssetPart,
  type PartGeometry,
  type PrimitiveKind,
} from './document.js';
import { LIBRARY_ASSETS, loadLibraryAsset } from './library.js';
import { AssetViewport, type TransformMode } from './viewport.js';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app');

root.innerHTML = `
  <main class="forge">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">A</div>
        <div class="brand-copy"><strong>Asset Forge</strong><span>low-poly workshop</span></div>
      </div>
      <div class="top-actions">
        <button class="icon-btn" id="new-btn" title="New asset">＋</button>
        <button class="icon-btn" id="open-btn" title="Open JSON">↥</button>
        <button class="icon-btn" id="save-btn" title="Save JSON">↓</button>
        <div class="divider"></div>
        <button class="icon-btn" id="undo-btn" title="Undo (Ctrl+Z)">↶</button>
        <button class="icon-btn" id="redo-btn" title="Redo (Ctrl+Shift+Z)">↷</button>
      </div>
      <div class="top-spacer"></div>
      <input class="asset-name" id="asset-name" value="Untitled asset" aria-label="Asset name" />
      <div class="top-spacer"></div>
      <div class="top-actions">
        <button class="btn" id="copy-btn">Copy JSON</button>
        <button class="btn primary" id="export-btn">Export asset</button>
      </div>
    </header>

    <aside class="sidebar left">
      <div class="panel-head">
        <div class="eyebrow">Starting assets</div>
        <input class="search" id="library-search" type="search" placeholder="Search buildings, props, cars…" />
      </div>
      <div class="library" id="library"></div>
    </aside>

    <section class="viewport" id="viewport">
      <div class="viewport-tools">
        <button class="icon-btn active" data-mode="translate" title="Move (W)">↔</button>
        <button class="icon-btn" data-mode="rotate" title="Rotate (E)">⟳</button>
        <button class="icon-btn" data-mode="scale" title="Scale (R)">⌗</button>
        <div class="divider"></div>
        <button class="btn active" id="space-btn" title="Toggle local/world space">Local</button>
        <button class="btn" id="snap-btn" title="Snap to 0.1 m / 15°">Snap</button>
        <button class="btn" id="frame-btn" title="Frame all (F)">Frame</button>
      </div>
      <div class="viewport-hint">Click a part to select · drag background to orbit · wheel to zoom</div>
    </section>

    <aside class="sidebar right">
      <section class="section">
        <div class="section-title"><span>Add primitive</span></div>
        <div class="add-grid" id="add-grid">
          <button class="btn" data-add="box">Box</button>
          <button class="btn" data-add="cylinder">Cylinder</button>
          <button class="btn" data-add="cone">Cone</button>
          <button class="btn" data-add="sphere">Low sphere</button>
          <button class="btn" data-add="torus">Torus</button>
          <button class="btn" data-add="plane">Plane</button>
        </div>
      </section>
      <section class="section">
        <div class="section-title"><span>Parts</span><span id="part-count">0</span></div>
        <div class="outliner" id="outliner"></div>
      </section>
      <div id="inspector"></div>
    </aside>

    <footer class="statusbar">
      <span class="status" id="status">Ready</span>
      <span><span class="kbd">W</span> move</span>
      <span><span class="kbd">E</span> rotate</span>
      <span><span class="kbd">R</span> scale</span>
      <span><span class="kbd">Del</span> remove</span>
    </footer>
    <input class="hidden" id="file-input" type="file" accept=".json,application/json" />
  </main>
`;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id) as T | null;
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

const libraryEl = byId<HTMLElement>('library');
const outlinerEl = byId<HTMLElement>('outliner');
const inspectorEl = byId<HTMLElement>('inspector');
const statusEl = byId<HTMLElement>('status');
const nameEl = byId<HTMLInputElement>('asset-name');
const partCountEl = byId<HTMLElement>('part-count');
const fileInput = byId<HTMLInputElement>('file-input');

let doc = blankDocument();
let selectedId: string | null = null;
let activeTemplateId = 'blank';
let mode: TransformMode = 'translate';
let localSpace = true;
let snap = false;
let dirty = false;
let undoStack: AssetDocument[] = [];
let redoStack: AssetDocument[] = [];
let transformSnapshot: AssetDocument | null = null;

const viewport = new AssetViewport(byId('viewport'), {
  select: (id) => selectPart(id),
  transformStart: () => { transformSnapshot = cloneDocument(doc); },
  transformChange: (id, transform) => {
    const part = doc.parts.find((entry) => entry.id === id);
    if (!part) return;
    part.transform = transform;
    dirty = true;
    renderInspector();
    setStatus(`Moving ${part.name}`);
  },
  transformEnd: () => {
    if (transformSnapshot && JSON.stringify(transformSnapshot) !== JSON.stringify(doc)) {
      undoStack.push(transformSnapshot);
      if (undoStack.length > 80) undoStack.shift();
      redoStack = [];
      updateHistoryButtons();
      setStatus('Transform applied');
    }
    transformSnapshot = null;
  },
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function setStatus(message: string, error = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', error);
}

function checkpoint(): void {
  undoStack.push(cloneDocument(doc));
  if (undoStack.length > 80) undoStack.shift();
  redoStack = [];
  dirty = true;
  updateHistoryButtons();
}

function refreshScene(frame = false): void {
  viewport.setDocument(doc);
  viewport.setSelected(selectedId);
  renderOutliner();
  renderInspector();
  nameEl.value = doc.name;
  partCountEl.textContent = String(doc.parts.length);
  if (frame) requestAnimationFrame(() => viewport.frameAll());
}

function loadDocument(next: AssetDocument, templateId = ''): void {
  checkpoint();
  doc = next;
  selectedId = doc.parts[0]?.id ?? null;
  activeTemplateId = templateId;
  dirty = templateId === '';
  renderLibrary();
  refreshScene(true);
  setStatus(`${doc.name} loaded · ${doc.parts.length} editable parts`);
}

function selectPart(id: string | null): void {
  selectedId = id && doc.parts.some((part) => part.id === id) ? id : null;
  viewport.setSelected(selectedId);
  renderOutliner();
  renderInspector();
}

function selectedPart(): AssetPart | null {
  return doc.parts.find((part) => part.id === selectedId) ?? null;
}

function renderLibrary(): void {
  const query = byId<HTMLInputElement>('library-search').value.trim().toLowerCase();
  const filtered = LIBRARY_ASSETS.filter((asset) =>
    !query || asset.label.toLowerCase().includes(query) || asset.group.toLowerCase().includes(query));
  const groups = new Map<string, typeof filtered>();
  for (const asset of filtered) {
    const entries = groups.get(asset.group) ?? [];
    entries.push(asset);
    groups.set(asset.group, entries);
  }
  libraryEl.innerHTML = [...groups].map(([group, assets]) => `
    <div class="library-group">
      <div class="library-label">${escapeHtml(group)}</div>
      ${assets.map((asset) => `
        <button class="library-item ${asset.id === activeTemplateId ? 'active' : ''}" data-library="${escapeHtml(asset.id)}">
          <span class="library-thumb">${asset.id === 'blank' ? '+' : asset.group === 'Vehicles' ? '4×4' : 'PLY'}</span>
          <span class="library-copy"><strong>${escapeHtml(asset.label)}</strong><span>Open as editable copy</span></span>
        </button>
      `).join('')}
    </div>
  `).join('') || '<div class="empty">No matching assets.</div>';
  for (const button of libraryEl.querySelectorAll<HTMLButtonElement>('[data-library]')) {
    button.addEventListener('click', () => {
      try { loadDocument(loadLibraryAsset(button.dataset.library!), button.dataset.library); }
      catch (error) { setStatus(error instanceof Error ? error.message : 'Could not load asset', true); }
    });
  }
}

function renderOutliner(): void {
  outlinerEl.innerHTML = doc.parts.length ? doc.parts.map((part) => `
    <button class="part-row ${part.id === selectedId ? 'active' : ''}" data-part="${escapeHtml(part.id)}">
      <span class="part-dot" style="--part-color:${part.material.color}"></span>
      <span class="part-label">${escapeHtml(part.name)}</span>
    </button>
  `).join('') : '<div class="empty">No parts yet. Add a primitive or choose a starting asset.</div>';
  for (const button of outlinerEl.querySelectorAll<HTMLButtonElement>('[data-part]')) {
    button.addEventListener('click', () => selectPart(button.dataset.part ?? null));
  }
}

function numberField(label: string, value: number, key: string, step = '0.01'): string {
  return `<div class="vector-cell"><span style="--axis:${label === 'X' ? '#ef7770' : label === 'Y' ? '#79bf77' : '#70a6e8'}">${label}</span>`
    + `<input class="number-input" type="number" step="${step}" value="${Number(value.toFixed(4))}" data-number="${key}" /></div>`;
}

function vectorField(title: string, prefix: string, values: readonly number[], degrees = false): string {
  const shown = degrees ? values.map((value) => THREE.MathUtils.radToDeg(value)) : values;
  return `<div class="field"><label>${title}</label><div class="vector">`
    + numberField('X', shown[0]!, `${prefix}.0`, degrees ? '1' : '0.05')
    + numberField('Y', shown[1]!, `${prefix}.1`, degrees ? '1' : '0.05')
    + numberField('Z', shown[2]!, `${prefix}.2`, degrees ? '1' : '0.05')
    + '</div></div>';
}

function geometryFields(spec: PartGeometry): string {
  if (spec.kind === 'box') return vectorField('Dimensions', 'geometry.size', spec.size);
  if (spec.kind === 'cylinder') return `
    <div class="field"><label>Radius top</label><input class="number-input" type="number" min="0" step="0.05" value="${spec.radiusTop}" data-number="geometry.radiusTop" /></div>
    <div class="field"><label>Radius bottom</label><input class="number-input" type="number" min="0" step="0.05" value="${spec.radiusBottom}" data-number="geometry.radiusBottom" /></div>
    <div class="field"><label>Height</label><input class="number-input" type="number" min="0.01" step="0.05" value="${spec.height}" data-number="geometry.height" /></div>
    <div class="field"><label>Sides</label><input class="number-input" type="number" min="3" max="64" step="1" value="${spec.segments}" data-number="geometry.segments" /></div>`;
  if (spec.kind === 'cone') return `
    <div class="field"><label>Radius</label><input class="number-input" type="number" min="0.01" step="0.05" value="${spec.radius}" data-number="geometry.radius" /></div>
    <div class="field"><label>Height</label><input class="number-input" type="number" min="0.01" step="0.05" value="${spec.height}" data-number="geometry.height" /></div>
    <div class="field"><label>Sides</label><input class="number-input" type="number" min="3" max="64" step="1" value="${spec.segments}" data-number="geometry.segments" /></div>`;
  if (spec.kind === 'sphere') return `
    <div class="field"><label>Radius</label><input class="number-input" type="number" min="0.01" step="0.05" value="${spec.radius}" data-number="geometry.radius" /></div>
    <div class="field"><label>Detail (0 is lowest-poly)</label><input class="number-input" type="number" min="0" max="4" step="1" value="${spec.detail}" data-number="geometry.detail" /></div>`;
  if (spec.kind === 'torus') return `
    <div class="field"><label>Ring radius</label><input class="number-input" type="number" min="0.01" step="0.05" value="${spec.radius}" data-number="geometry.radius" /></div>
    <div class="field"><label>Tube radius</label><input class="number-input" type="number" min="0.01" step="0.02" value="${spec.tube}" data-number="geometry.tube" /></div>`;
  return `<div class="field"><label>Dimensions</label><div class="vector">`
    + numberField('X', spec.size[0], 'geometry.size.0')
    + numberField('Y', spec.size[1], 'geometry.size.1')
    + '<div></div></div></div>';
}

function setNestedNumber(part: AssetPart, path: string, value: number): void {
  const keys = path.split('.');
  let target: unknown = part;
  for (const key of keys.slice(0, -1)) target = (target as Record<string, unknown>)[key];
  const last = keys.at(-1)!;
  if (Array.isArray(target)) target[Number(last)] = value;
  else (target as Record<string, unknown>)[last] = value;
}

function renderInspector(): void {
  const part = selectedPart();
  if (!part) {
    inspectorEl.innerHTML = `<section class="section"><div class="section-title"><span>Inspector</span></div><div class="empty">Select a part in the viewport or parts list to edit it.</div></section>`;
    return;
  }
  inspectorEl.innerHTML = `
    <section class="section">
      <div class="section-title"><span>Selected part</span><span>${escapeHtml(part.geometry.kind)}</span></div>
      <div class="field"><label>Name</label><input class="text-input" id="part-name" value="${escapeHtml(part.name)}" /></div>
      <div class="selection-actions"><button class="btn" id="duplicate-btn">Duplicate</button><button class="btn danger" id="delete-btn">Delete</button></div>
    </section>
    <section class="section">
      <div class="section-title"><span>Transform</span><span>metres / degrees</span></div>
      ${vectorField('Position', 'transform.position', part.transform.position)}
      ${vectorField('Rotation', 'transform.rotation', part.transform.rotation, true)}
      ${vectorField('Scale', 'transform.scale', part.transform.scale)}
    </section>
    <section class="section">
      <div class="section-title"><span>Geometry</span><span>${escapeHtml(part.geometry.kind)}</span></div>
      ${geometryFields(part.geometry)}
    </section>
    <section class="section">
      <div class="section-title"><span>Material</span><span>standard</span></div>
      <div class="field"><label>Colour</label><div class="material-row"><input class="color-input" id="part-color" type="color" value="${part.material.color}" /><input class="text-input" id="part-color-text" value="${part.material.color}" /></div></div>
      <div class="field"><label>Roughness</label><div class="range-row"><input id="roughness" type="range" min="0" max="1" step="0.01" value="${part.material.roughness}" /><span class="range-value">${part.material.roughness.toFixed(2)}</span></div></div>
      <div class="field"><label>Metalness</label><div class="range-row"><input id="metalness" type="range" min="0" max="1" step="0.01" value="${part.material.metalness}" /><span class="range-value">${part.material.metalness.toFixed(2)}</span></div></div>
      <div class="field"><label>Opacity</label><div class="range-row"><input id="opacity" type="range" min="0.05" max="1" step="0.01" value="${part.material.opacity}" /><span class="range-value">${part.material.opacity.toFixed(2)}</span></div></div>
    </section>`;

  byId<HTMLInputElement>('part-name').addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLInputElement).value.trim();
    if (!value || value === part.name) return;
    checkpoint(); part.name = value; refreshScene(); setStatus('Part renamed');
  });
  byId('duplicate-btn').addEventListener('click', duplicateSelected);
  byId('delete-btn').addEventListener('click', deleteSelected);
  for (const input of inspectorEl.querySelectorAll<HTMLInputElement>('[data-number]')) {
    input.addEventListener('change', () => {
      let value = Number(input.value);
      if (!Number.isFinite(value)) return renderInspector();
      const path = input.dataset.number!;
      if (path.startsWith('transform.rotation')) value = THREE.MathUtils.degToRad(value);
      if (path.includes('scale') || path.includes('size') || /radius|height|tube/.test(path)) value = Math.max(0.001, value);
      if (/segments|detail/.test(path)) value = Math.round(value);
      checkpoint(); setNestedNumber(part, path, value); refreshScene(); setStatus('Part updated');
    });
  }
  const color = byId<HTMLInputElement>('part-color');
  const colorText = byId<HTMLInputElement>('part-color-text');
  const applyColor = (value: string): void => {
    if (!/^#[0-9a-f]{6}$/i.test(value) || value.toLowerCase() === part.material.color) return;
    checkpoint(); part.material.color = value.toLowerCase(); refreshScene(); setStatus('Material updated');
  };
  color.addEventListener('change', () => applyColor(color.value));
  colorText.addEventListener('change', () => applyColor(colorText.value));
  for (const key of ['roughness', 'metalness', 'opacity'] as const) {
    byId<HTMLInputElement>(key).addEventListener('change', (event) => {
      const value = Number((event.currentTarget as HTMLInputElement).value);
      if (!Number.isFinite(value) || value === part.material[key]) return;
      checkpoint(); part.material[key] = value; refreshScene(); setStatus('Material updated');
    });
  }
}

function addPrimitive(kind: PrimitiveKind): void {
  checkpoint();
  const part = createPart(doc, kind);
  doc.parts.push(part);
  selectedId = part.id;
  activeTemplateId = '';
  renderLibrary();
  refreshScene();
  setStatus(`${part.name} added`);
}

function duplicateSelected(): void {
  const source = selectedPart();
  if (!source) return;
  checkpoint();
  const copy = structuredClone(source);
  copy.id = nextPartId(doc);
  copy.name = `${source.name} copy`;
  copy.transform.position[0] += 0.25;
  copy.transform.position[2] += 0.25;
  doc.parts.push(copy);
  selectedId = copy.id;
  refreshScene();
  setStatus(`${copy.name} created`);
}

function deleteSelected(): void {
  const index = doc.parts.findIndex((part) => part.id === selectedId);
  if (index < 0) return;
  checkpoint();
  const [removed] = doc.parts.splice(index, 1);
  selectedId = doc.parts[Math.min(index, doc.parts.length - 1)]?.id ?? null;
  refreshScene();
  setStatus(`${removed?.name ?? 'Part'} removed`);
}

function undo(): void {
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack.push(cloneDocument(doc));
  doc = previous;
  selectedId = doc.parts.some((part) => part.id === selectedId) ? selectedId : doc.parts[0]?.id ?? null;
  dirty = true;
  refreshScene(); updateHistoryButtons(); setStatus('Undone');
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(cloneDocument(doc));
  doc = next;
  selectedId = doc.parts.some((part) => part.id === selectedId) ? selectedId : doc.parts[0]?.id ?? null;
  dirty = true;
  refreshScene(); updateHistoryButtons(); setStatus('Redone');
}

function updateHistoryButtons(): void {
  (byId<HTMLButtonElement>('undo-btn')).disabled = undoStack.length === 0;
  (byId<HTMLButtonElement>('redo-btn')).disabled = redoStack.length === 0;
}

function download(): void {
  const json = JSON.stringify(doc, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileSafeName(doc.name)}.asset.json`;
  link.click();
  URL.revokeObjectURL(url);
  dirty = false;
  setStatus(`${link.download} exported`);
}

function setMode(next: TransformMode): void {
  mode = next;
  viewport.setMode(mode);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    button.classList.toggle('active', button.dataset.mode === mode);
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-add]')) {
  button.addEventListener('click', () => addPrimitive(button.dataset.add as PrimitiveKind));
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.addEventListener('click', () => setMode(button.dataset.mode as TransformMode));
}
byId<HTMLInputElement>('library-search').addEventListener('input', renderLibrary);
byId('new-btn').addEventListener('click', () => loadDocument(blankDocument(), 'blank'));
byId('open-btn').addEventListener('click', () => fileInput.click());
byId('save-btn').addEventListener('click', download);
byId('export-btn').addEventListener('click', download);
byId('undo-btn').addEventListener('click', undo);
byId('redo-btn').addEventListener('click', redo);
byId('frame-btn').addEventListener('click', () => viewport.frameAll());
byId('space-btn').addEventListener('click', (event) => {
  localSpace = !localSpace;
  viewport.setSpace(localSpace ? 'local' : 'world');
  const button = event.currentTarget as HTMLButtonElement;
  button.textContent = localSpace ? 'Local' : 'World';
  button.classList.toggle('active', localSpace);
});
byId('snap-btn').addEventListener('click', (event) => {
  snap = !snap;
  viewport.setSnap(snap);
  (event.currentTarget as HTMLButtonElement).classList.toggle('active', snap);
});
byId('copy-btn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(doc, null, 2)); setStatus('Asset JSON copied'); }
  catch { setStatus('Clipboard access was blocked', true); }
});
nameEl.addEventListener('change', () => {
  const value = nameEl.value.trim();
  if (!value || value === doc.name) { nameEl.value = doc.name; return; }
  checkpoint(); doc.name = value.slice(0, 100); dirty = true; setStatus('Asset renamed');
});
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    loadDocument(decodeAssetDocument(parsed));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not open asset', true);
  }
});

window.addEventListener('keydown', (event) => {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); download(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && !typing) { event.preventDefault(); duplicateSelected(); return; }
  if (typing) return;
  if (event.key.toLowerCase() === 'w') setMode('translate');
  else if (event.key.toLowerCase() === 'e') setMode('rotate');
  else if (event.key.toLowerCase() === 'r') setMode('scale');
  else if (event.key.toLowerCase() === 'f') viewport.frameAll();
  else if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
});

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
});

renderLibrary();
refreshScene(true);
updateHistoryButtons();
