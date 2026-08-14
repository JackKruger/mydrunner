import * as THREE from 'three';
import { activeQuality } from './quality.js';
import {
  MAX_SAVED_BUILDS,
  VEHICLE_BASE_IDS,
  VEHICLE_PART_CATALOGS,
  createStockBuild,
  decodeVehicleGarage,
  normalizeVehicleBuild,
  normalizeVehicleBuildDetailed,
  partCompatibility,
  resolveVehicleSpec,
  type NamedVehicleBuild,
  type VehicleBaseId,
  type VehicleBuild,
  type VehicleGarage,
  type VehiclePartOption,
  type VehiclePartSlot,
} from '@mydrunner/shared';
import { buildCarMesh } from './carMesh.js';
import { disposeObject3D } from './three/dispose.js';

const GARAGE_KEY = 'mydrunner.garage.v1';

export interface WorkshopCallbacks {
  onApply(build: VehicleBuild): void;
  onExit(): void;
  onRepair(): void;
}

const CATEGORY_SLOTS: ReadonlyArray<{
  label: string;
  slot: VehiclePartSlot;
  catalog: keyof typeof VEHICLE_PART_CATALOGS.ridgeback;
}> = [
  { label: 'Suspension', slot: 'suspensionId', catalog: 'suspension' },
  { label: 'Axles', slot: 'axleId', catalog: 'axles' },
  { label: 'Tyres', slot: 'tireId', catalog: 'tires' },
  { label: 'Wheels', slot: 'wheelId', catalog: 'wheels' },
  { label: 'Front bar', slot: 'frontBarId', catalog: 'frontBars' },
  { label: 'Winch', slot: 'winchId', catalog: 'winches' },
  { label: 'Snorkel', slot: 'snorkelId', catalog: 'snorkels' },
  { label: 'Roof', slot: 'roofId', catalog: 'roofs' },
  { label: 'Rear body', slot: 'rearBodyId', catalog: 'rearBodies' },
];

export class WorkshopUI {
  private root: HTMLElement | null = null;
  private content: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private selected = createStockBuild();
  private applied = createStockBuild();
  private callbacks: WorkshopCallbacks | null = null;
  private activeCategory = 'Vehicles';
  private garage: VehicleGarage = { version: 1, builds: [] };
  private renderer: THREE.WebGLRenderer | null = null;
  private previewScene: THREE.Scene | null = null;
  private previewCamera: THREE.PerspectiveCamera | null = null;
  private previewVehicle: THREE.Group | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private orbitYaw = 0.65;
  private orbitPitch = 0.24;
  private animationToken = 0;
  private previewWidth = 0;
  private previewHeight = 0;

  get isOpen(): boolean { return this.root !== null; }

  /** Deterministic dev/E2E review hook. The production UI still changes a
   * build through its controls; this avoids dozens of synchronous WebGL
   * rebuilds when generating the visual placement matrix. */
  setReviewBuild(build: VehicleBuild): void {
    if (!this.root) throw new Error('Workshop must be open before setting a review build.');
    this.selected = normalizeVehicleBuild(build);
    this.root.querySelector('.workshop-title')!.textContent = resolveVehicleSpec(this.selected).displayName;
    this.rebuildPreview();
  }

  /** Exact orbit companion to setReviewBuild, used only by deterministic
   * browser screenshots. */
  setReviewOrbit(yaw: number, pitch: number): void {
    this.orbitYaw = yaw;
    this.orbitPitch = Math.max(-0.1, Math.min(0.65, pitch));
  }

  open(build: VehicleBuild, callbacks: WorkshopCallbacks): void {
    this.close(false);
    this.applied = normalizeVehicleBuild(build);
    this.selected = { ...this.applied };
    this.callbacks = callbacks;
    this.garage = loadGarage();
    const root = document.createElement('div');
    root.id = 'workshop-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Vehicle workshop');
    root.innerHTML = `
      <aside class="workshop-nav">
        <div class="workshop-kicker">THREE-BAY SERVICE</div>
        <h2>Workshop</h2>
        <div class="workshop-categories"></div>
        <button class="workshop-category" data-category="Lockers">Lockers</button>
        <button class="workshop-category" data-category="Paint">Paint</button>
        <button class="workshop-category" data-category="Saved builds">Saved builds</button>
      </aside>
      <main class="workshop-main">
        <header><div><strong class="workshop-title"></strong><span>ALL PARTS FREE</span></div><p class="workshop-status" role="status"></p></header>
        <div class="workshop-stage"><canvas class="workshop-preview"></canvas><div class="workshop-orbit-hint">Drag to orbit</div></div>
        <section class="workshop-content"></section>
        <section class="workshop-compare"></section>
        <footer>
          <button data-action="repair">Repair · FREE</button>
          <button data-action="cancel">Cancel</button>
          <button class="primary" data-action="apply">Apply &amp; exit</button>
        </footer>
      </main>`;
    document.body.appendChild(root);
    this.root = root;
    this.content = root.querySelector('.workshop-content');
    this.status = root.querySelector('.workshop-status');
    this.previewCanvas = root.querySelector('.workshop-preview');
    const categories = root.querySelector('.workshop-categories')!;
    const baseButton = document.createElement('button');
    baseButton.className = 'workshop-category'; baseButton.dataset.category = 'Vehicles'; baseButton.textContent = 'Vehicles';
    categories.appendChild(baseButton);
    for (const item of CATEGORY_SLOTS) {
      const button = document.createElement('button');
      button.className = 'workshop-category'; button.dataset.category = item.label; button.textContent = item.label;
      categories.appendChild(button);
    }
    root.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((button) => {
      button.addEventListener('click', () => {
        this.activeCategory = button.dataset.category!;
        this.renderControls();
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="repair"]')!.addEventListener('click', () => {
      callbacks.onRepair();
      this.setStatus('Front, engine, steering and body condition fully repaired.');
    });
    root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.addEventListener('click', () => callbacks.onExit());
    root.querySelector<HTMLButtonElement>('[data-action="apply"]')!.addEventListener('click', () => {
      this.setBusy(true);
      callbacks.onApply(this.selected);
    });
    this.initPreview();
    this.renderControls();
  }

  setStatus(message: string, error = false): void {
    if (!this.status) return;
    this.status.textContent = message;
    this.status.classList.toggle('error', error);
  }

  setBusy(busy: boolean): void {
    this.root?.querySelectorAll<HTMLButtonElement>('footer button').forEach((button) => { button.disabled = busy; });
  }

  confirmApplied(build: VehicleBuild): void {
    this.applied = normalizeVehicleBuild(build);
    this.selected = { ...this.applied };
    this.setStatus('Build confirmed. Rebuilding vehicle…');
  }

  close(notify = false): void {
    if (!this.root) return;
    if (notify) this.callbacks?.onExit();
    this.animationToken += 1;
    if (this.previewVehicle) disposeObject3D(this.previewVehicle);
    this.renderer?.dispose();
    this.root.remove();
    this.root = null;
    this.content = null;
    this.status = null;
    this.renderer = null;
    this.previewScene = null;
    this.previewCamera = null;
    this.previewVehicle = null;
    this.previewCanvas = null;
    this.callbacks = null;
  }

  /** Commit a selection change and re-render.
   *
   *  `partCompatibility` only gates the dependent end of a requirement — it
   *  refuses 37s without the lift — but says nothing about removing a
   *  prerequisite while its dependant is fitted. Those clicks are legal and
   *  reach `normalizeVehicleBuildDetailed`, which resolves them by reverting
   *  the dependant to stock. Show the reason it gives: dropping the lift used
   *  to swap the player's tyres back with nothing on screen to say why. */
  private applySelection(next: unknown): void {
    const result = normalizeVehicleBuildDetailed(next);
    this.selected = result.build;
    this.renderControls();
    if (result.issues.length > 0) this.setStatus(result.issues[0]!, true);
    else this.setStatus('');
  }

  private renderControls(): void {
    if (!this.root || !this.content) return;
    const catalog = VEHICLE_PART_CATALOGS[this.selected.baseId];
    for (const item of CATEGORY_SLOTS) {
      const button = this.root.querySelector<HTMLButtonElement>(`[data-category="${item.label}"]`);
      if (!button) continue;
      button.hidden = catalog[item.catalog].length <= 1;
      button.textContent = this.selected.baseId === 'dustback-rs'
        ? item.slot === 'frontBarId' ? 'Front equipment'
          : item.slot === 'roofId' ? 'Roof equipment'
          : item.slot === 'rearBodyId' ? 'Rear equipment'
          : item.label
        : item.label;
    }
    const drivetrainButton = this.root.querySelector<HTMLButtonElement>('[data-category="Lockers"]')!;
    drivetrainButton.textContent = this.selected.baseId === 'dustback-rs' ? 'Drivetrain' : 'Lockers';
    this.root.querySelectorAll('[data-category]').forEach((el) => el.classList.toggle('active', (el as HTMLElement).dataset.category === this.activeCategory));
    this.root.querySelector('.workshop-title')!.textContent = resolveVehicleSpec(this.selected).displayName;
    this.content.replaceChildren();
    if (this.activeCategory === 'Vehicles') this.renderVehicles();
    else if (this.activeCategory === 'Paint') this.renderPaint();
    else if (this.activeCategory === 'Lockers') this.renderLockers();
    else if (this.activeCategory === 'Saved builds') this.renderSaved();
    else {
      const category = CATEGORY_SLOTS.find((item) => item.label === this.activeCategory);
      if (category) this.renderParts(category.slot, category.catalog);
    }
    this.renderComparison();
    this.rebuildPreview();
  }

  private renderVehicles(): void {
    for (const baseId of VEHICLE_BASE_IDS) {
      const spec = resolveVehicleSpec(createStockBuild(baseId));
      this.addChoice(baseId, spec.displayName, spec.character, this.selected.baseId === baseId, true, undefined, () => {
        const paintColor = this.selected.paintColor;
        const paintFinish = this.selected.paintFinish;
        this.selected = { ...createStockBuild(baseId), paintColor, paintFinish };
        this.renderControls();
      });
    }
  }

  private renderParts(slot: VehiclePartSlot, catalogKey: keyof typeof VEHICLE_PART_CATALOGS.ridgeback): void {
    const list = VEHICLE_PART_CATALOGS[this.selected.baseId][catalogKey] as readonly VehiclePartOption[];
    for (const option of list) {
      const compatibility = partCompatibility(this.selected, slot, option.id);
      this.addChoice(option.id, option.name, option.description, this.selected[slot] === option.id, compatibility.enabled, compatibility.reason, () => {
        this.applySelection({ ...this.selected, [slot]: option.id });
      });
    }
  }

  private renderLockers(): void {
    if (this.selected.baseId === 'dustback-rs') {
      this.addToggle('Rear limited-slip differential', 'Moderately couples rear wheel speeds continuously; no runtime locker switch.', this.selected.rearLocker, (checked) => {
        this.applySelection({ ...this.selected, rearLocker: checked, frontLocker: false });
      });
      return;
    }
    this.addToggle('Rear locker', 'Improves traction when one rear wheel lifts; increases firm-surface understeer.', this.selected.rearLocker, (checked) => {
      this.selected.rearLocker = checked; this.renderControls();
    });
    this.addToggle('Front locker', 'Maximum crawl traction with a tighter safe-speed limit and wider turning circle.', this.selected.frontLocker, (checked) => {
      this.selected.frontLocker = checked; this.renderControls();
    });
  }

  private renderPaint(): void {
    const wrap = document.createElement('label'); wrap.className = 'workshop-paint'; wrap.textContent = 'Paint colour · FREE';
    const input = document.createElement('input'); input.type = 'color'; input.value = this.selected.paintColor;
    input.addEventListener('input', () => { this.selected.paintColor = input.value; this.rebuildPreview(); });
    wrap.appendChild(input); this.content!.appendChild(wrap);
    for (const finish of ['gloss', 'satin', 'matte'] as const) {
      this.addChoice(finish, `${finish[0]!.toUpperCase()}${finish.slice(1)} finish`, 'PBR paint finish · FREE', this.selected.paintFinish === finish, true, undefined, () => {
        this.selected.paintFinish = finish; this.renderControls();
      });
    }
  }

  private renderSaved(): void {
    const actions = document.createElement('div'); actions.className = 'workshop-save-actions';
    const save = document.createElement('button'); save.textContent = `Save current (${this.garage.builds.length}/${MAX_SAVED_BUILDS})`;
    save.disabled = this.garage.builds.length >= MAX_SAVED_BUILDS;
    save.addEventListener('click', () => {
      const name = window.prompt('Build name', resolveVehicleSpec(this.selected).displayName)?.trim();
      if (!name) return;
      const entry: NamedVehicleBuild = {
        id: `build-${Date.now().toString(36)}`,
        name: name.slice(0, 32),
        build: normalizeVehicleBuild(this.selected),
        updatedAt: Date.now(),
      };
      this.garage.builds.push(entry); saveGarage(this.garage); this.renderControls();
    });
    actions.appendChild(save); this.content!.appendChild(actions);
    for (const saved of this.garage.builds) {
      const row = document.createElement('div'); row.className = 'workshop-saved';
      const load = document.createElement('button'); load.innerHTML = `<strong>${escapeHtml(saved.name)}</strong><span>${resolveVehicleSpec(saved.build).displayName}</span>`;
      load.addEventListener('click', () => { this.applySelection(saved.build); });
      const rename = document.createElement('button'); rename.textContent = 'Rename';
      rename.addEventListener('click', () => {
        const name = window.prompt('Build name', saved.name)?.trim();
        if (name) { saved.name = name.slice(0, 32); saved.updatedAt = Date.now(); saveGarage(this.garage); this.renderControls(); }
      });
      const remove = document.createElement('button'); remove.textContent = 'Delete';
      remove.addEventListener('click', () => { this.garage.builds = this.garage.builds.filter((entry) => entry.id !== saved.id); saveGarage(this.garage); this.renderControls(); });
      row.append(load, rename, remove); this.content!.appendChild(row);
    }
  }

  private addChoice(id: string, name: string, description: string, selected: boolean, enabled: boolean, reason: string | undefined, choose: () => void): void {
    const button = document.createElement('button'); button.className = 'workshop-choice'; button.dataset.id = id;
    button.classList.toggle('selected', selected); button.disabled = !enabled;
    button.innerHTML = `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(reason ?? description)}</span><b>FREE</b>`;
    button.addEventListener('click', choose); this.content!.appendChild(button);
  }

  private addToggle(name: string, description: string, checked: boolean, change: (checked: boolean) => void): void {
    const label = document.createElement('label'); label.className = 'workshop-toggle';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', () => change(input.checked));
    label.append(input);
    const copy = document.createElement('span'); copy.innerHTML = `<strong>${name}</strong><small>${description}</small><b>FREE</b>`;
    label.append(copy); this.content!.appendChild(label);
  }

  private renderComparison(): void {
    const target = this.root?.querySelector('.workshop-compare');
    if (!target) return;
    const before = resolveVehicleSpec(this.applied); const after = resolveVehicleSpec(this.selected);
    const rows = [
      ['Clearance', `${before.groundClearance.toFixed(2)} m`, `${after.groundClearance.toFixed(2)} m`],
      ['Track width', `${before.track.toFixed(2)} m`, `${after.track.toFixed(2)} m`],
      ['Tyre size', `${Math.round(before.wheelRadius * 2 / 0.0254)} in`, `${Math.round(after.wheelRadius * 2 / 0.0254)} in`],
      ['Tyre width', `${Math.round(before.wheelWidth * 1000)} mm`, `${Math.round(after.wheelWidth * 1000)} mm`],
      ['Mass', `${Math.round(before.massKg)} kg`, `${Math.round(after.massKg)} kg`],
      ['Wading', `${before.wadingDepth.toFixed(2)} m`, `${after.wadingDepth.toFixed(2)} m`],
      ['Mud grip', before.grip.mud.toFixed(2), after.grip.mud.toFixed(2)],
      ['Gravel grip', before.grip.gravel.toFixed(2), after.grip.gravel.toFixed(2)],
      ['Road grip', before.grip.road.toFixed(2), after.grip.road.toFixed(2)],
      ['Stability', `${Math.round(before.stability * 100)}`, `${Math.round(after.stability * 100)}`],
    ];
    target.innerHTML = `<h3>Applied → preview</h3><div class="workshop-stats">${rows.map(([label, a, b]) => `<span>${label}</span><em>${a}</em><strong>${b}</strong>`).join('')}</div>`;
  }

  private initPreview(): void {
    const canvas = this.previewCanvas!;
    // A SECOND WebGL context, live at the same time as the game's. Follow
    // the same tier as the main renderer rather than its own cap of 2 —
    // uncapped it was rendering at a higher pixel ratio than the game.
    const quality = activeQuality();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
    this.previewScene = new THREE.Scene();
    this.previewCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.previewScene.add(new THREE.HemisphereLight(0xe7f0ff, 0x342d24, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(4, 7, 6); this.previewScene.add(key);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(7, 48), new THREE.MeshStandardMaterial({ color: 0x252a2c, roughness: 0.92 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -1.02; this.previewScene.add(floor);
    let pointer: { id: number; x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (event) => { pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointermove', (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      this.orbitYaw += (event.clientX - pointer.x) * 0.008;
      this.orbitPitch = Math.max(-0.1, Math.min(0.65, this.orbitPitch + (event.clientY - pointer.y) * 0.006));
      pointer.x = event.clientX; pointer.y = event.clientY;
    });
    canvas.addEventListener('pointerup', () => { pointer = null; });
    const token = ++this.animationToken;
    const draw = (): void => {
      if (token !== this.animationToken || !this.renderer || !this.previewCamera || !this.previewScene) return;
      // Resize only when it actually changed. getBoundingClientRect forces a
      // layout flush, and this ran every frame beside the game's own loop.
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width)); const height = Math.max(1, Math.round(rect.height));
      if (width !== this.previewWidth || height !== this.previewHeight) {
        this.previewWidth = width; this.previewHeight = height;
        this.renderer.setSize(width, height, false); this.previewCamera.aspect = width / height; this.previewCamera.updateProjectionMatrix();
      }
      const radius = 7.2; const flat = Math.cos(this.orbitPitch) * radius;
      this.previewCamera.position.set(Math.sin(this.orbitYaw) * flat, 1.2 + Math.sin(this.orbitPitch) * radius, Math.cos(this.orbitYaw) * flat);
      this.previewCamera.lookAt(0, 0.25, 0); this.renderer.render(this.previewScene, this.previewCamera);
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  private rebuildPreview(): void {
    if (!this.previewScene) return;
    if (this.previewVehicle) { this.previewScene.remove(this.previewVehicle); disposeObject3D(this.previewVehicle); }
    const built = buildCarMesh(this.selected, true, 0);
    this.previewVehicle = built.group; this.previewVehicle.position.y = 0.15; this.previewScene.add(this.previewVehicle);
  }
}

function loadGarage(): VehicleGarage {
  try { return decodeVehicleGarage(localStorage.getItem(GARAGE_KEY)); }
  catch { return { version: 1, builds: [] }; }
}

function saveGarage(garage: VehicleGarage): void {
  try { localStorage.setItem(GARAGE_KEY, JSON.stringify(garage)); } catch { /* storage unavailable */ }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
