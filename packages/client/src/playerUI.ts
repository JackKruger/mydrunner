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
}

export interface PlayerHudState extends PlayerTelemetry {
  connection: PlayerConnectionState;
  version: string;
}

interface PlayerUIOptions {
  development: boolean;
  version: string;
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

  constructor(root: HTMLElement, options: PlayerUIOptions) {
    this.root = root;
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
    this.surfaceText.textContent = this.state.surface || '—';

    const engineStatus = this.state.engineStatus || '';
    this.engineStatusText.classList.toggle('active', engineStatus !== '');
    this.engineStatusText.textContent = engineStatus;
    this.engineStatusText.setAttribute('aria-hidden', String(engineStatus === ''));

    this.handbrakeText.classList.toggle('active', this.state.handbrake);
    this.handbrakeText.textContent = this.state.handbrake ? 'HANDBRAKE' : '';
    this.handbrakeText.setAttribute('aria-hidden', String(!this.state.handbrake));

    this.tickText.textContent = `tick=${this.state.tick ?? 0}`;
    this.fpsText.textContent = `${this.state.fps ?? 0} FPS`;
    this.previewDiagnosticText.textContent = this.state.previewDiagnostic ?? '';
  }
}
