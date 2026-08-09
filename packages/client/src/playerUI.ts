import type { ManualGear, TransferCaseMode } from '@mydrunner/shared';

export type PlayerConnectionMode =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'fatal'
  | 'preview'
  | 'missing-preview'
  | 'init-failed';

export interface PlayerConnectionState {
  mode: PlayerConnectionMode;
  /** Human-readable detail, including reconnect and refusal reasons. */
  message?: string;
  driverName?: string;
  mapName?: string;
}

export interface PlayerTelemetry {
  speedMps: number;
  rpm: number;
  gear: number;
  surface: string;
  handbrake: boolean;
  /** Empty when the engine is fine. Otherwise the flooded / cranking
   *  prompt: a dead engine with no explanation reads as a broken game. */
  engineStatus: string;
  tick?: number;
  fps?: number;
  previewDiagnostic?: string;
  transferCase?: TransferCaseMode;
  frontLocked?: boolean;
  rearLocked?: boolean;
  fixedRwd?: boolean;
  bodyCondition?: number;
  engineCondition?: number;
  steeringCondition?: number;
  drivetrainNotice?: string;
  winchStatus?: string;
}

export interface PlayerHudState extends PlayerTelemetry {
  connection: PlayerConnectionState;
  version: string;
}

interface PlayerUIOptions {
  development: boolean;
  version: string;
  onGearSelection?: (gear: ManualGear | null) => void;
  onTransferCaseSelection?: (mode: TransferCaseMode) => void;
}

const RPM_DISPLAY_MAX = 6000;

export function formatGear(gear: number): string {
  if (gear === -1) return 'R';
  if (gear === 0) return 'N';
  return String(gear);
}

function defaultConnectionMessage(mode: PlayerConnectionMode): string {
  switch (mode) {
    case 'connected': return 'connected';
    case 'reconnecting': return 'reconnecting…';
    case 'fatal': return 'connection failed';
    case 'preview': return 'PREVIEW';
    case 'missing-preview': return 'no preview map in this tab — open one from the editor';
    case 'init-failed': return 'init failed - see console';
    case 'connecting': return 'connecting…';
  }
}

/** Owns the player-facing DOM and turns simulation state into semantic,
 * independently updateable instruments. The game loop still derives every
 * value; this class only presents them. */
export class PlayerUI {
  private state: PlayerHudState;
  private readonly root: HTMLElement;
  private readonly connectionText: HTMLElement;
  private readonly identityText: HTMLElement;
  private readonly mapText: HTMLElement;
  private readonly surfaceText: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly speedText: HTMLElement;
  private readonly rpmText: HTMLElement;
  private readonly rpmMeter: HTMLElement;
  private readonly gearText: HTMLElement;
  private readonly handbrakeText: HTMLElement;
  private readonly engineStatusText: HTMLElement;
  private readonly tickText: HTMLElement;
  private readonly fpsText: HTMLElement;
  private readonly previewDiagnosticText: HTMLElement;
  private readonly drivetrainText: HTMLElement;
  private readonly conditionText: HTMLElement;
  private readonly winchText: HTMLElement;
  private readonly shifter: HTMLElement;
  private readonly gearGate: HTMLElement;
  private readonly gearKnob: HTMLElement;
  private readonly transmissionModeButton: HTMLButtonElement;
  private readonly transferGate: HTMLElement;
  private readonly transferKnob: HTMLElement;
  private manualGear: ManualGear | null = null;
  private displayedGear: ManualGear = 0;
  private activePointer: number | null = null;
  private activeTransferPointer: number | null = null;
  private readonly onGearSelection: (gear: ManualGear | null) => void;
  private readonly onTransferCaseSelection: (mode: TransferCaseMode) => void;

  constructor(root: HTMLElement, options: PlayerUIOptions) {
    this.root = root;
    this.onGearSelection = options.onGearSelection ?? (() => {});
    this.onTransferCaseSelection = options.onTransferCaseSelection ?? (() => {});
    this.state = {
      connection: { mode: 'connecting' },
      speedMps: 0,
      rpm: 0,
      gear: 0,
      surface: '',
      handbrake: false,
      engineStatus: '',
      tick: 0,
      fps: 0,
      previewDiagnostic: '',
      transferCase: '4h', frontLocked: false, rearLocked: false,
      fixedRwd: false,
      bodyCondition: 1, engineCondition: 1, steeringCondition: 1,
      drivetrainNotice: '',
      winchStatus: '',
      version: options.version,
    };

    root.setAttribute('aria-label', 'Rally driving instruments');
    root.innerHTML = `
      <section class="hud-session instrument-panel" aria-label="Session status">
        <div class="hud-panel-kicker">SESSION</div>
        <div id="hud-connection" class="hud-connection" role="status" aria-live="polite" aria-atomic="true">
          <span class="hud-status-lamp" aria-hidden="true"></span>
          <span id="hud-connection-text">connecting…</span>
        </div>
        <div class="hud-session-meta">
          <span id="hud-identity">ONLINE</span>
          <span class="hud-meta-divider" aria-hidden="true">/</span>
          <span id="hud-map">STAGE —</span>
        </div>
        <div class="hud-surface-row">
          <span class="hud-field-label">SURFACE</span>
          <strong id="hud-surface">—</strong>
        </div>
      </section>

      <div id="hud-alert" class="hud-alert instrument-panel" role="status" aria-live="polite" aria-atomic="true">
        connecting…
      </div>

      <div id="hud-engine-status" class="hud-engine-status instrument-panel" role="status" aria-live="assertive"></div>

      <section class="hud-cluster instrument-panel" aria-label="Vehicle telemetry">
        <div class="hud-speed">
          <span id="hud-speed-value" class="hud-speed-value">0</span>
          <span class="hud-speed-unit">km/h</span>
        </div>
        <div class="hud-gear" aria-label="Current gear">
          <span class="hud-field-label">GEAR</span>
          <strong id="hud-gear-value">N</strong>
        </div>
        <div class="hud-rpm">
          <div class="hud-rpm-copy">
            <span class="hud-field-label">ENGINE</span>
            <span><strong id="hud-rpm-value">0</strong> RPM</span>
          </div>
          <div id="hud-rpm-meter" class="hud-rpm-meter" role="meter" aria-label="Engine RPM" aria-valuemin="0" aria-valuemax="6000" aria-valuenow="0">
            <span class="hud-rpm-fill"></span>
          </div>
        </div>
        <div id="hud-handbrake" class="hud-handbrake" role="status" aria-live="polite"></div>
        <div id="hud-drivetrain" class="hud-drivetrain" role="status">HIGH · LOCKERS OPEN</div>
        <div id="hud-condition" class="hud-condition" role="status"></div>
        <div id="hud-winch" class="hud-winch" role="status" aria-live="polite"></div>
      </section>

      <section id="hud-shifter" class="hud-shifter instrument-panel" aria-label="Transmission selector" data-mode="auto">
        <header class="hud-shifter-header">
          <span class="hud-field-label">TRANSMISSION</span>
          <button id="transmission-mode" type="button" aria-pressed="false">AUTO</button>
        </header>
        <div id="gear-gate" class="gear-gate" aria-label="H-pattern gear selector" role="group">
          <span class="gear-gate-line gear-gate-line-horizontal" aria-hidden="true"></span>
          <span class="gear-gate-line gear-gate-line-left" aria-hidden="true"></span>
          <span class="gear-gate-line gear-gate-line-centre" aria-hidden="true"></span>
          <span class="gear-gate-line gear-gate-line-right" aria-hidden="true"></span>
          <button class="gear-slot gear-slot-1" type="button" data-gear="1" aria-label="First gear">1</button>
          <button class="gear-slot gear-slot-2" type="button" data-gear="2" aria-label="Second gear">2</button>
          <button class="gear-slot gear-slot-3" type="button" data-gear="3" aria-label="Third gear">3</button>
          <button class="gear-slot gear-slot-4" type="button" data-gear="4" aria-label="Fourth gear">4</button>
          <button class="gear-slot gear-slot-5" type="button" data-gear="5" aria-label="Fifth gear">5</button>
          <button class="gear-slot gear-slot-r" type="button" data-gear="-1" aria-label="Reverse gear">R</button>
          <span class="gear-neutral-label" aria-hidden="true">N</span>
          <span id="gear-knob" class="gear-knob" aria-hidden="true"></span>
        </div>
        <div id="transfer-gate" class="transfer-gate" aria-label="Transfer-case selector" role="group">
          <span class="transfer-label">TRANSFER</span>
          <span class="transfer-gate-line" aria-hidden="true"></span>
          <button class="transfer-slot transfer-slot-2h" type="button" data-transfer="2h" aria-label="Two wheel drive high">2H</button>
          <button class="transfer-slot transfer-slot-4h" type="button" data-transfer="4h" aria-label="Four wheel drive high">4H</button>
          <button class="transfer-slot transfer-slot-4l" type="button" data-transfer="4l" aria-label="Four wheel drive low">4L</button>
          <span id="transfer-knob" class="transfer-knob" aria-hidden="true">4H</span>
        </div>
        <div id="gear-mode-hint" class="gear-mode-hint">AUTO SHIFT</div>
        <div id="transfer-mode-hint" class="transfer-mode-hint">4WD HIGH</div>
      </section>

      <section id="hud-diagnostics" class="hud-diagnostics instrument-panel" aria-label="Development diagnostics"${options.development ? '' : ' hidden'}>
        <span id="hud-tick">tick=0</span>
        <span id="hud-fps">0 FPS</span>
        <span id="version">build ${options.version}</span>
        <span id="hud-preview-diagnostic"></span>
      </section>
    `;

    this.connectionText = root.querySelector('#hud-connection-text')!;
    this.identityText = root.querySelector('#hud-identity')!;
    this.mapText = root.querySelector('#hud-map')!;
    this.surfaceText = root.querySelector('#hud-surface')!;
    this.alert = root.querySelector('#hud-alert')!;
    this.speedText = root.querySelector('#hud-speed-value')!;
    this.rpmText = root.querySelector('#hud-rpm-value')!;
    this.rpmMeter = root.querySelector('#hud-rpm-meter')!;
    this.gearText = root.querySelector('#hud-gear-value')!;
    this.handbrakeText = root.querySelector('#hud-handbrake')!;
    this.engineStatusText = root.querySelector('#hud-engine-status')!;
    this.tickText = root.querySelector('#hud-tick')!;
    this.fpsText = root.querySelector('#hud-fps')!;
    this.previewDiagnosticText = root.querySelector('#hud-preview-diagnostic')!;
    this.drivetrainText = root.querySelector('#hud-drivetrain')!;
    this.conditionText = root.querySelector('#hud-condition')!;
    this.winchText = root.querySelector('#hud-winch')!;
    this.shifter = root.querySelector('#hud-shifter')!;
    this.gearGate = root.querySelector('#gear-gate')!;
    this.gearKnob = root.querySelector('#gear-knob')!;
    this.transmissionModeButton = root.querySelector('#transmission-mode')!;
    this.transferGate = root.querySelector('#transfer-gate')!;
    this.transferKnob = root.querySelector('#transfer-knob')!;

    this.bindShifter();
    this.bindTransferCase();
    this.renderConnection();
    this.renderTelemetry();
  }

  setConnectionState(next: PlayerConnectionState): void {
    this.state.connection = {
      ...this.state.connection,
      ...next,
      message: next.message,
    };
    this.renderConnection();
  }

  updateTelemetry(next: Partial<PlayerTelemetry>): void {
    this.state = { ...this.state, ...next };
    this.renderTelemetry();
  }

  private renderConnection(): void {
    const connection = this.state.connection;
    const message = connection.message ?? defaultConnectionMessage(connection.mode);
    const shortLabel = connection.mode === 'preview'
      ? 'PREVIEW'
      : defaultConnectionMessage(connection.mode);

    this.root.dataset.connection = connection.mode;
    this.connectionText.textContent = shortLabel;
    this.identityText.textContent = connection.mode === 'preview'
      ? 'OFFLINE RUN'
      : (connection.driverName ? `DRIVER ${connection.driverName}` : 'ONLINE');
    this.mapText.textContent = connection.mapName ? `STAGE ${connection.mapName}` : 'STAGE —';

    const hasCustomMessage = connection.message !== undefined
      && connection.message !== defaultConnectionMessage(connection.mode);
    const showAlert = connection.mode !== 'connected' && connection.mode !== 'preview'
      || hasCustomMessage;
    this.alert.hidden = !showAlert;
    this.alert.textContent = message;
    this.alert.setAttribute('role', connection.mode === 'fatal' || connection.mode === 'init-failed' ? 'alert' : 'status');
  }

  private renderTelemetry(): void {
    const speedKmh = Math.max(0, this.state.speedMps * 3.6);
    const rpm = Math.max(0, this.state.rpm);
    const rpmRatio = Math.min(1, rpm / RPM_DISPLAY_MAX);

    this.speedText.textContent = speedKmh.toFixed(0);
    this.rpmText.textContent = rpm.toFixed(0);
    this.rpmMeter.setAttribute('aria-valuenow', rpm.toFixed(0));
    this.rpmMeter.style.setProperty('--rpm-ratio', String(rpmRatio));
    this.gearText.textContent = formatGear(this.state.gear);
    this.displayedGear = normaliseGear(this.state.gear);
    if (this.manualGear === null) this.positionGearKnob(this.displayedGear);
    this.surfaceText.textContent = this.state.surface || '—';

    const engineStatus = this.state.engineStatus || '';
    this.engineStatusText.classList.toggle('active', engineStatus !== '');
    this.engineStatusText.textContent = engineStatus;
    this.engineStatusText.setAttribute('aria-hidden', String(engineStatus === ''));

    this.handbrakeText.classList.toggle('active', this.state.handbrake);
    this.handbrakeText.textContent = this.state.handbrake ? 'HANDBRAKE' : '';
    this.handbrakeText.setAttribute('aria-hidden', String(!this.state.handbrake));

    const fixedRwd = this.state.fixedRwd === true;
    const transferCase = fixedRwd ? '2h' : this.state.transferCase ?? '4h';
    this.transferGate.dataset.fixed = String(fixedRwd);
    this.transferGate.setAttribute('aria-disabled', String(fixedRwd));
    this.transferGate.setAttribute('aria-label', fixedRwd ? 'Rear-wheel drive, fixed high range' : 'Transfer-case selector');
    for (const slot of this.transferGate.querySelectorAll<HTMLButtonElement>('[data-transfer]')) slot.disabled = fixedRwd;
    this.positionTransferKnob(transferCase);
    const locks = [this.state.rearLocked ? 'R LOCK' : '', this.state.frontLocked ? 'F LOCK' : ''].filter(Boolean).join(' · ');
    this.drivetrainText.textContent = fixedRwd ? 'RWD · FIXED HIGH' : `${transferCase.toUpperCase()} · ${locks || 'LOCKERS OPEN'}`;
    if (this.state.drivetrainNotice) this.drivetrainText.textContent = this.state.drivetrainNotice;
    const body = Math.round((this.state.bodyCondition ?? 1) * 100);
    const engine = Math.round((this.state.engineCondition ?? 1) * 100);
    const steering = Math.round((this.state.steeringCondition ?? 1) * 100);
    const damaged = body < 98 || engine < 98 || steering < 98;
    this.conditionText.textContent = damaged ? `BODY ${body} · ENGINE ${engine} · STEERING ${steering}` : '';
    this.conditionText.classList.toggle('active', damaged);
    this.winchText.textContent = this.state.winchStatus ?? '';
    this.winchText.classList.toggle('active', Boolean(this.state.winchStatus));

    this.tickText.textContent = `tick=${this.state.tick ?? 0}`;
    this.fpsText.textContent = `${this.state.fps ?? 0} FPS`;
    this.previewDiagnosticText.textContent = this.state.previewDiagnostic ?? '';
  }

  private bindShifter(): void {
    this.transmissionModeButton.addEventListener('click', () => {
      if (this.manualGear === null) this.selectManualGear(this.displayedGear);
      else this.selectAutomatic();
    });

    for (const slot of this.gearGate.querySelectorAll<HTMLElement>('[data-gear]')) {
      slot.addEventListener('click', (event) => {
        event.stopPropagation();
        this.selectManualGear(Number(slot.dataset.gear) as ManualGear);
      });
    }

    this.gearGate.addEventListener('pointerdown', (event) => {
      const e = event as PointerEvent;
      event.preventDefault();
      this.activePointer = e.pointerId;
      this.gearGate.setPointerCapture?.(e.pointerId);
      this.updateGearDrag(e.clientX, e.clientY);
    });
    this.gearGate.addEventListener('pointermove', (event) => {
      const e = event as PointerEvent;
      if (e.pointerId !== this.activePointer) return;
      this.updateGearDrag(e.clientX, e.clientY);
    });
    const finish = (event: Event): void => {
      const e = event as PointerEvent;
      if (e.pointerId !== this.activePointer) return;
      this.activePointer = null;
      this.shifter.classList.remove('dragging');
      this.positionGearKnob(this.manualGear ?? this.displayedGear);
    };
    this.gearGate.addEventListener('pointerup', finish);
    this.gearGate.addEventListener('pointercancel', finish);
  }

  private bindTransferCase(): void {
    for (const slot of this.transferGate.querySelectorAll<HTMLElement>('[data-transfer]')) {
      slot.addEventListener('click', (event) => {
        event.stopPropagation();
        this.requestTransferCase(slot.dataset.transfer as TransferCaseMode);
      });
    }

    this.transferGate.addEventListener('pointerdown', (event) => {
      if (this.state.fixedRwd) return;
      const e = event as PointerEvent;
      event.preventDefault();
      this.activeTransferPointer = e.pointerId;
      this.transferGate.setPointerCapture?.(e.pointerId);
      this.updateTransferDrag(e.clientY);
    });
    this.transferGate.addEventListener('pointermove', (event) => {
      const e = event as PointerEvent;
      if (e.pointerId !== this.activeTransferPointer) return;
      this.updateTransferDrag(e.clientY);
    });
    const finish = (event: Event): void => {
      const e = event as PointerEvent;
      if (e.pointerId !== this.activeTransferPointer) return;
      this.activeTransferPointer = null;
      this.shifter.classList.remove('transfer-dragging');
    };
    this.transferGate.addEventListener('pointerup', finish);
    this.transferGate.addEventListener('pointercancel', finish);
  }

  private updateTransferDrag(clientY: number): void {
    const rect = this.transferGate.getBoundingClientRect();
    if (rect.height <= 0) return;
    const y = clamp01((clientY - rect.top) / rect.height);
    const mode: TransferCaseMode = y < 0.34 ? '2h' : y < 0.67 ? '4h' : '4l';
    this.shifter.classList.add('transfer-dragging');
    this.requestTransferCase(mode);
  }

  private requestTransferCase(mode: TransferCaseMode): void {
    if (this.state.fixedRwd) return;
    this.positionTransferKnob(mode);
    this.onTransferCaseSelection(mode);
  }

  private positionTransferKnob(mode: TransferCaseMode): void {
    const positions: Record<TransferCaseMode, number> = { '2h': 0.2, '4h': 0.5, '4l': 0.8 };
    this.transferKnob.style.top = `${positions[mode] * 100}%`;
    this.transferKnob.textContent = mode.toUpperCase();
    this.shifter.querySelector('#transfer-mode-hint')!.textContent = transferCaseLabel(mode);
    if (this.state.fixedRwd) {
      this.transferKnob.textContent = 'RWD';
      this.shifter.querySelector('#transfer-mode-hint')!.textContent = 'RWD · FIXED HIGH';
    }
    for (const slot of this.transferGate.querySelectorAll<HTMLElement>('[data-transfer]')) {
      const selected = slot.dataset.transfer === mode;
      slot.classList.toggle('selected', selected);
      slot.setAttribute('aria-pressed', String(selected));
    }
  }

  private updateGearDrag(clientX: number, clientY: number): void {
    const rect = this.gearGate.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = clamp01((clientX - rect.left) / rect.width);
    const y = clamp01((clientY - rect.top) / rect.height);
    const columns = [0.2, 0.5, 0.8] as const;
    const column = columns.reduce((best, value) =>
      Math.abs(value - x) < Math.abs(best - x) ? value : best, columns[0]);

    // Project onto the legal H gate: the centre crossbar or one of its
    // three vertical legs, so the lever feels mechanically constrained.
    let knobX: number;
    let knobY: number;
    if (Math.abs(y - 0.5) <= Math.abs(x - column)) {
      knobX = Math.max(0.2, Math.min(0.8, x));
      knobY = 0.5;
    } else {
      knobX = column;
      knobY = Math.max(0.18, Math.min(0.82, y));
    }
    this.shifter.classList.add('dragging');
    this.positionGearKnobAt(knobX, knobY);

    let gear: ManualGear = 0;
    if (knobY < 0.36) gear = knobX < 0.35 ? 1 : knobX < 0.65 ? 3 : 5;
    else if (knobY > 0.64) gear = knobX < 0.35 ? 2 : knobX < 0.65 ? 4 : -1;
    this.selectManualGear(gear, false);
  }

  private selectAutomatic(): void {
    this.manualGear = null;
    this.shifter.dataset.mode = 'auto';
    this.transmissionModeButton.textContent = 'AUTO';
    this.transmissionModeButton.setAttribute('aria-pressed', 'false');
    this.shifter.querySelector('#gear-mode-hint')!.textContent = 'AUTO SHIFT';
    this.updateSelectedSlots();
    this.positionGearKnob(this.displayedGear);
    this.onGearSelection(null);
  }

  private selectManualGear(gear: ManualGear, snap = true): void {
    const changed = this.manualGear !== gear;
    this.manualGear = gear;
    this.shifter.dataset.mode = 'manual';
    this.transmissionModeButton.textContent = 'MANUAL';
    this.transmissionModeButton.setAttribute('aria-pressed', 'true');
    this.shifter.querySelector('#gear-mode-hint')!.textContent = `${formatGear(gear)} SELECTED`;
    this.gearKnob.textContent = formatGear(gear);
    this.updateSelectedSlots();
    if (snap) this.positionGearKnob(gear);
    if (changed) this.onGearSelection(gear);
  }

  private updateSelectedSlots(): void {
    for (const slot of this.gearGate.querySelectorAll<HTMLElement>('[data-gear]')) {
      const selected = this.manualGear !== null && Number(slot.dataset.gear) === this.manualGear;
      slot.classList.toggle('selected', selected);
      slot.setAttribute('aria-pressed', String(selected));
    }
  }

  private positionGearKnob(gear: ManualGear): void {
    const positions: Record<ManualGear, readonly [number, number]> = {
      [-1]: [0.8, 0.82], 0: [0.5, 0.5], 1: [0.2, 0.18], 2: [0.2, 0.82],
      3: [0.5, 0.18], 4: [0.5, 0.82], 5: [0.8, 0.18],
    };
    this.gearKnob.textContent = formatGear(gear);
    this.positionGearKnobAt(...positions[gear]);
  }

  private positionGearKnobAt(x: number, y: number): void {
    this.gearKnob.style.left = `${x * 100}%`;
    this.gearKnob.style.top = `${y * 100}%`;
  }
}

function normaliseGear(gear: number): ManualGear {
  if (gear === -1) return -1;
  if (gear >= 1 && gear <= 5) return Math.round(gear) as ManualGear;
  return 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function transferCaseLabel(mode: TransferCaseMode): string {
  if (mode === '2h') return '2WD HIGH';
  if (mode === '4l') return '4WD LOW';
  return '4WD HIGH';
}
