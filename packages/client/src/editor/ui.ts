// The editor's side panel. A view over ToolState plus the file actions.
//
// The DOM vocabulary it is built from lives in dom.ts; this file is only
// the layout and the bindings.

import { Physics } from '@mydrunner/shared';
import {
  button, caption, checkbox, el, numberField, section, select, slider, textField,
  type NumberHandle, type SelectHandle, type SliderHandle,
} from './dom.js';
import {
  TOOL_KEYS, isSculpt, paintableSurfaces, placeableKinds, type ToolId, type ToolState,
} from './tools.js';

export interface UiCallbacks {
  onToolChange(tool: ToolId): void;
  onNew(): void;
  onOpenFile(file: File): void;
  onSaveJson(): void;
  onCopyModule(): void;
  onPreview(): void;
  onBakeChange(bake: boolean): void;
  onUndo(): void;
  onRedo(): void;
  onNameChange(name: string): void;
  onIdChange(id: string): void;
  /** The kind changed: the caller reseeds the dimension defaults and
   *  rebuilds the placement ghost. The panel does not do it itself because
   *  the same reseed happens from the keyboard. */
  onObjectKindChange(kind: Physics.ObstacleKind): void;
  /** Placement mode/value changed: re-seat the ghost immediately. */
  onObjectPlacementChange(): void;
  /** Derive the whole flow field from the water surface's slope. */
  onAutoFlow(): void;
}

export class EditorUi {
  readonly root: HTMLElement;
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  private statusEl: HTMLElement;
  private fileInput: HTMLInputElement;
  private idInput: HTMLInputElement;
  private nameInput: HTMLInputElement;
  private brushSection: HTMLElement;
  private paintSection: HTMLElement;
  private waterSection: HTMLElement;
  private objectSection: HTMLElement;
  private spawnSection: HTMLElement;
  private deleteSection: HTMLElement;
  private radiusSlider: SliderHandle;
  private strengthSlider: SliderHandle;
  private hardnessSlider: SliderHandle;
  private kindSelect: SelectHandle;
  private sizeSlider: SliderHandle;
  private heightSlider: SliderHandle;
  private lengthSlider: SliderHandle;
  private yawSlider: SliderHandle;
  private placementModeSelect: SelectHandle;
  private placementYInput: NumberHandle;
  private dimsCaption: { set(t: string): void };

  constructor(parent: HTMLElement, private state: ToolState, private cb: UiCallbacks) {
    this.root = el('div', 'ed-panel');

    // --- Identity ---
    const idRow = section(this.root, 'Map');
    this.idInput = textField(idRow, 'id', '', (v) => this.cb.onIdChange(v));
    this.nameInput = textField(idRow, 'name', '', (v) => this.cb.onNameChange(v));

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
    this.brushSection = section(this.root, 'Brush');
    this.radiusSlider = slider(this.brushSection, 'radius', 1, 60, 0.5, state.radius,
      (v) => { this.state.radius = v; });
    this.strengthSlider = slider(this.brushSection, 'strength', 0.2, 30, 0.2, state.strength,
      (v) => { this.state.strength = v; });
    this.hardnessSlider = slider(this.brushSection, 'hardness', 0, 1, 0.05, state.hardness,
      (v) => { this.state.hardness = v; });

    // --- Paint ---
    const paint = this.paintSection = section(this.root, 'Surface');
    select(
      paint,
      'surface',
      paintableSurfaces().map((s) => ({ value: String(s.id), label: s.label })),
      String(state.surface),
      (v) => { this.state.surface = Number(v) as Physics.Surface; },
    );

    // --- Water ---
    const water = this.waterSection = section(this.root, 'Water');
    select(
      water,
      'mode',
      [
        { value: 'raise', label: 'raise' },
        { value: 'erase', label: 'erase' },
        { value: 'flow', label: 'flow (drag to aim)' },
      ],
      state.waterMode,
      (v) => { this.state.waterMode = v as ToolState['waterMode']; },
    );
    slider(water, 'depth', 0.1, 4, 0.05, state.waterDepth,
      (v) => { this.state.waterDepth = v; });
    slider(water, 'flow m/s', 0, 6, 0.1, state.waterSpeed,
      (v) => { this.state.waterSpeed = v; });
    water.appendChild(button('Auto-flow from slope', () => this.cb.onAutoFlow()));
    caption(water).set('depth is measured from the ground under the stroke centre');

    // --- Objects ---
    const objects = this.objectSection = section(this.root, 'Object');
    this.kindSelect = select(
      objects,
      'kind',
      placeableKinds().map((g) => ({
        label: g.label,
        options: g.kinds.map((k) => ({ value: k, label: Physics.objectInfo(k).label })),
      })),
      state.objectKind,
      (v) => this.cb.onObjectKindChange(v as Physics.ObstacleKind),
    );
    this.sizeSlider = slider(objects, 'size', 0.3, 8, 0.1, state.objectSize,
      (v) => { this.state.objectSize = v; });
    this.heightSlider = slider(objects, 'height', 0.3, 20, 0.1, state.objectHeight,
      (v) => { this.state.objectHeight = v; });
    this.lengthSlider = slider(objects, 'length', 1, 12, 0.1, state.objectLength,
      (v) => { this.state.objectLength = v; });
    this.yawSlider = slider(objects, 'yaw', -Math.PI, Math.PI, 0.02, state.objectYaw,
      (v) => { this.state.objectYaw = v; });
    this.placementModeSelect = select(
      objects,
      'placement',
      [
        { value: 'ground', label: 'snap to ground' },
        { value: 'offset', label: 'above ground' },
        { value: 'absolute', label: 'absolute world Y' },
      ],
      state.objectPlacementMode,
      (v) => {
        this.state.objectPlacementMode = v as ToolState['objectPlacementMode'];
        this.syncPlacement();
        this.cb.onObjectPlacementChange();
      },
    );
    this.placementYInput = numberField(objects, 'offset above ground', state.objectYOffset, (v) => {
      if (this.state.objectPlacementMode === 'offset') this.state.objectYOffset = v;
      else if (this.state.objectPlacementMode === 'absolute') this.state.objectWorldY = v;
      this.cb.onObjectPlacementChange();
    });
    this.dimsCaption = caption(objects);

    // --- Spawn ---
    const spawn = this.spawnSection = section(this.root, 'Spawn');
    slider(spawn, 'yaw', -Math.PI, Math.PI, 0.05, state.spawnYaw, (v) => { this.state.spawnYaw = v; });

    // --- Delete ---
    const remove = this.deleteSection = section(this.root, 'Delete');
    select(
      remove,
      'mode',
      [
        { value: 'single', label: 'single item' },
        { value: 'radius', label: 'within radius' },
      ],
      state.deleteMode,
      (v) => { this.state.deleteMode = v as ToolState['deleteMode']; },
    );

    // --- File ---
    const file = section(this.root, 'File');
    const row = el('div', 'ed-row');
    file.appendChild(row);
    row.appendChild(button('New', () => this.cb.onNew()));
    row.appendChild(button('Open', () => this.fileInput.click()));
    row.appendChild(button('Save .json', () => this.cb.onSaveJson()));
    row.appendChild(button('Copy .ts', () => this.cb.onCopyModule()));
    checkbox(file, 'bake on save', false, (v) => this.cb.onBakeChange(v));

    const previewRow = el('div', 'ed-row');
    file.appendChild(previewRow);
    const previewBtn = button('▶ Preview in game', () => this.cb.onPreview());
    previewBtn.className = 'ed-primary';
    previewRow.appendChild(previewBtn);

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
    this.syncObject();
  }

  setIdentity(id: string, name: string): void {
    this.idInput.value = id;
    this.nameInput.value = name;
  }

  syncTool(): void {
    for (const [tool, b] of this.toolButtons) {
      b.classList.toggle('active', tool === this.state.tool);
    }

    const tool = this.state.tool;
    const usesRadius = isSculpt(tool) || tool === 'paint' || tool === 'water' || tool === 'delete';
    this.brushSection.hidden = !usesRadius;
    this.radiusSlider.setVisible(usesRadius);
    // Smooth and flatten have a fixed convergence rate; the strength value
    // is only consumed by the additive raise/lower brushes.
    this.strengthSlider.setVisible(tool === 'raise' || tool === 'lower');
    this.hardnessSlider.setVisible(isSculpt(tool));

    this.paintSection.hidden = tool !== 'paint';
    this.waterSection.hidden = tool !== 'water';
    this.objectSection.hidden = tool !== 'object';
    this.spawnSection.hidden = tool !== 'spawn';
    this.deleteSection.hidden = tool !== 'delete';
  }

  /** Push the object state back into the panel: after a kind change, and
   *  after the wheel or the bracket keys move the yaw. */
  syncObject(): void {
    const info = Physics.objectInfo(this.state.objectKind);
    this.kindSelect.set(this.state.objectKind);
    this.sizeSlider.retarget({
      label: info.dims.size, min: info.limits.size[0], max: info.limits.size[1],
    });
    this.sizeSlider.set(this.state.objectSize);
    this.heightSlider.retarget({
      label: info.dims.height, min: info.limits.height[0], max: info.limits.height[1],
    });
    this.heightSlider.set(this.state.objectHeight);

    // A kind with no run hides the slider outright rather than showing a
    // control that changes nothing — the editor's own version of not
    // shipping a TUNING field that no physics code reads.
    const hasLength = info.dims.length !== undefined;
    this.lengthSlider.setVisible(hasLength);
    if (hasLength && info.limits.length) {
      this.lengthSlider.retarget({
        label: info.dims.length!, min: info.limits.length[0], max: info.limits.length[1],
      });
      this.lengthSlider.set(this.state.objectLength);
    }
    this.yawSlider.set(this.state.objectYaw);
    this.syncPlacement();
  }

  private syncPlacement(): void {
    const mode = this.state.objectPlacementMode;
    this.placementModeSelect.set(mode);
    this.placementYInput.setVisible(mode !== 'ground');
    if (mode === 'offset') {
      this.placementYInput.setLabel('offset above ground');
      this.placementYInput.set(this.state.objectYOffset);
      this.dimsCaption.set('offset is relative to local terrain · wheel or [ ] to aim');
    } else if (mode === 'absolute') {
      this.placementYInput.setLabel('base world Y');
      this.placementYInput.set(this.state.objectWorldY);
      this.dimsCaption.set('world Y is the object base; geometry height stays separate · wheel or [ ] to aim');
    } else {
      this.dimsCaption.set('base snaps to terrain · wheel or [ ] to aim');
    }
  }

  status(text: string, kind: 'info' | 'error' = 'info'): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', kind === 'error');
  }
}
