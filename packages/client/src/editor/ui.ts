// The editor's side panel. A view over ToolState plus the file actions.
//
// Built imperatively, like the rest of the client's DOM (joinScreen,
// chat, debugPanel) — there is no framework here and adding one for one
// panel would be the largest dependency in the app.

import { Physics } from '@mydrunner/shared';
import {
  OBJECT_KINDS, TOOL_KEYS, paintableSurfaces, type ToolId, type ToolState,
} from './tools.js';

export interface UiCallbacks {
  onToolChange(tool: ToolId): void;
  onNew(): void;
  onOpenFile(file: File): void;
  onSaveJson(): void;
  onCopyModule(): void;
  onBakeChange(bake: boolean): void;
  onUndo(): void;
  onRedo(): void;
  onNameChange(name: string): void;
  onIdChange(id: string): void;
}

export class EditorUi {
  readonly root: HTMLElement;
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  private statusEl: HTMLElement;
  private fileInput: HTMLInputElement;

  constructor(parent: HTMLElement, private state: ToolState, private cb: UiCallbacks) {
    this.root = el('div', 'ed-panel');

    // --- Identity ---
    const idRow = section(this.root, 'Map');
    const idInput = textField(idRow, 'id', '', (v) => this.cb.onIdChange(v));
    const nameInput = textField(idRow, 'name', '', (v) => this.cb.onNameChange(v));
    this.idInput = idInput;
    this.nameInput = nameInput;

    // --- Tools ---
    const tools = section(this.root, 'Tool');
    const grid = el('div', 'ed-tools');
    tools.appendChild(grid);
    for (const { tool, label, code } of TOOL_KEYS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${label} (${code.replace('Digit', '')})`;
      b.addEventListener('click', () => this.cb.onToolChange(tool));
      grid.appendChild(b);
      this.toolButtons.set(tool, b);
    }

    // --- Brush ---
    const brush = section(this.root, 'Brush');
    slider(brush, 'radius', 1, 60, 0.5, state.radius, (v) => { this.state.radius = v; });
    slider(brush, 'strength', 0.2, 30, 0.2, state.strength, (v) => { this.state.strength = v; });
    slider(brush, 'hardness', 0, 1, 0.05, state.hardness, (v) => { this.state.hardness = v; });

    // --- Paint ---
    const paint = section(this.root, 'Surface');
    select(
      paint,
      'surface',
      paintableSurfaces().map((s) => ({ value: String(s.id), label: s.label })),
      String(state.surface),
      (v) => { this.state.surface = Number(v) as Physics.Surface; },
    );

    // --- Objects ---
    const objects = section(this.root, 'Object');
    select(
      objects,
      'kind',
      OBJECT_KINDS.map((k) => ({ value: k, label: k })),
      state.objectKind,
      (v) => { this.state.objectKind = v as Physics.ObstacleKind; },
    );
    slider(objects, 'size', 0.3, 8, 0.1, state.objectSize, (v) => { this.state.objectSize = v; });
    slider(objects, 'height', 0.3, 20, 0.1, state.objectHeight, (v) => { this.state.objectHeight = v; });

    // --- Spawn ---
    const spawn = section(this.root, 'Spawn');
    slider(spawn, 'yaw', -Math.PI, Math.PI, 0.05, state.spawnYaw, (v) => { this.state.spawnYaw = v; });

    // --- File ---
    const file = section(this.root, 'File');
    const row = el('div', 'ed-row');
    file.appendChild(row);
    row.appendChild(button('New', () => this.cb.onNew()));
    row.appendChild(button('Open', () => this.fileInput.click()));
    row.appendChild(button('Save .json', () => this.cb.onSaveJson()));
    row.appendChild(button('Copy .ts', () => this.cb.onCopyModule()));
    checkbox(file, 'bake on save', false, (v) => this.cb.onBakeChange(v));

    const undoRow = el('div', 'ed-row');
    file.appendChild(undoRow);
    undoRow.appendChild(button('Undo (Z)', () => this.cb.onUndo()));
    undoRow.appendChild(button('Redo (Y)', () => this.cb.onRedo()));

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      if (f) this.cb.onOpenFile(f);
      // Cleared so re-opening the same file fires change again.
      this.fileInput.value = '';
    });
    this.root.appendChild(this.fileInput);

    this.statusEl = el('div', 'ed-status');
    this.root.appendChild(this.statusEl);

    parent.appendChild(this.root);
    this.syncTool();
  }

  private idInput: HTMLInputElement;
  private nameInput: HTMLInputElement;

  setIdentity(id: string, name: string): void {
    this.idInput.value = id;
    this.nameInput.value = name;
  }

  syncTool(): void {
    for (const [tool, b] of this.toolButtons) {
      b.classList.toggle('active', tool === this.state.tool);
    }
  }

  status(text: string, kind: 'info' | 'error' = 'info'): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', kind === 'error');
  }
}

// --- Small DOM helpers ------------------------------------------------

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function section(parent: HTMLElement, title: string): HTMLElement {
  const s = el('div', 'ed-section');
  const h = el('h2', 'ed-title');
  h.textContent = title;
  s.appendChild(h);
  parent.appendChild(s);
  return s;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function slider(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
): void {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  const readout = el('span', 'ed-value');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const show = (): void => { readout.textContent = Number(input.value).toFixed(2); };
  show();
  name.textContent = label;
  input.addEventListener('input', () => {
    onInput(Number(input.value));
    show();
  });
  row.append(name, input, readout);
  parent.appendChild(row);
}

function select(
  parent: HTMLElement,
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
): void {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  name.textContent = label;
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  row.append(name, sel);
  parent.appendChild(row);
}

function textField(
  parent: HTMLElement,
  label: string,
  value: string,
  onChange: (v: string) => void,
): HTMLInputElement {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  row.append(name, input);
  parent.appendChild(row);
  return input;
}

function checkbox(
  parent: HTMLElement,
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
): void {
  const row = el('label', 'ed-field');
  const name = el('span', 'ed-label');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(name, input);
  parent.appendChild(row);
}
