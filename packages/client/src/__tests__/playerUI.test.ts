import { beforeEach, describe, expect, it } from 'vitest';
import { formatGear, PlayerUI } from '../playerUI.js';

function makeUI(development = true): { root: HTMLElement; ui: PlayerUI } {
  const root = document.createElement('div');
  root.id = 'hud';
  document.body.appendChild(root);
  return {
    root,
    ui: new PlayerUI(root, { development }),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('gear formatting', () => {
  it('uses conventional reverse, neutral, and drive labels', () => {
    expect(formatGear(-1)).toBe('R');
    expect(formatGear(0)).toBe('N');
    expect(formatGear(1)).toBe('1');
    expect(formatGear(5)).toBe('5');
  });
});

describe('PlayerUI telemetry', () => {
  it('presents online telemetry as independent instruments', () => {
    const { root, ui } = makeUI();
    ui.setConnectionState({
      mode: 'connected',
      driverName: 'Mira',
      mapName: 'Bog Run',
    });
    ui.updateTelemetry({
      speedMps: 12.5,
      rpm: 3210.4,
      gear: 3,
      surface: 'Deep mud',
      handbrake: false,
      fps: 59,
    });

    expect(root.dataset.connection).toBe('connected');
    expect(root.querySelector('#hud-connection-text')?.textContent).toBe('connected');
    expect(root.querySelector('#hud-identity')?.textContent).toBe('DRIVER Mira');
    expect(root.querySelector('#hud-map')?.textContent).toBe('STAGE Bog Run');
    expect(root.querySelector('#hud-speed-value')?.textContent).toBe('45');
    expect(root.querySelector('#hud-rpm-value')?.textContent).toBe('3210');
    expect(root.querySelector('#hud-gear-value')?.textContent).toBe('3');
    expect(root.querySelector('#hud-surface')?.textContent).toBe('Deep mud');
    expect(root.querySelector('#hud-fps')?.textContent).toBe('59 FPS');
    expect(root.querySelector('#hud-tick')).toBeNull();
    expect(root.querySelector('#version')).toBeNull();
    expect(root.querySelector('#hud-diagnostics')).toBeNull();
    expect(root.textContent).toContain('km/h');
  });

  it('switches to explicit preview identity and offline telemetry', () => {
    const { root, ui } = makeUI();
    ui.setConnectionState({ mode: 'preview', mapName: 'Workshop Pass' });
    ui.updateTelemetry({
      speedMps: 5,
      rpm: 1800,
      gear: -1,
      surface: 'Gravel',
    });

    expect(root.querySelector('#hud-connection-text')?.textContent).toBe('PREVIEW');
    expect(root.querySelector('#hud-identity')?.textContent).toBe('OFFLINE RUN');
    expect(root.querySelector('#hud-speed-value')?.textContent).toBe('18');
    expect(root.querySelector('#hud-gear-value')?.textContent).toBe('R');
  });

  it('announces and clears the handbrake indication', () => {
    const { root, ui } = makeUI();
    const warning = root.querySelector('#hud-handbrake') as HTMLElement;

    ui.updateTelemetry({ handbrake: true });
    expect(warning.classList.contains('active')).toBe(true);
    expect(warning.textContent).toBe('HANDBRAKE');
    expect(warning.getAttribute('aria-hidden')).toBe('false');

    ui.updateTelemetry({ handbrake: false });
    expect(warning.classList.contains('active')).toBe(false);
    expect(warning.textContent).toBe('');
    expect(warning.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows current tyre PSI, fitted range, and adjustment refusal', () => {
    const { root, ui } = makeUI();
    ui.updateTelemetry({
      pressure: {
        currentPsi: 17.5,
        nominalPsi: 24,
        minPsi: 6,
        maxPsi: 28,
        adjusting: -1,
        reason: 'Release the throttle to adjust tyre pressure.',
      },
    });
    const status = root.querySelector('#hud-pressure')!;
    expect(status.textContent).toContain('17.5 PSI');
    expect(status.textContent).toContain('6–28');
    expect(status.textContent).toContain('Release the throttle');
    expect(status.classList.contains('active')).toBe(true);
  });
});

describe('H-pattern transmission selector', () => {
  it('selects manual gears and parks the stick in A for automatic', () => {
    const selections: Array<number | null> = [];
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ui = new PlayerUI(root, {
      development: false,
      onGearSelection: (gear) => selections.push(gear),
    });
    ui.updateTelemetry({ gear: 2 });
    expect(root.querySelector('#transmission-mode')).toBeNull();
    expect(root.querySelector('.hud-shifter-header > .hud-field-label')).toBeNull();
    expect(root.querySelector('.transfer-label')).toBeNull();
    expect(root.querySelector('[data-gear="auto"]')?.textContent).toBe('A');
    expect(root.querySelector('#gear-knob')?.textContent).toBe('A');
    expect(root.querySelector('#gear-mode-hint')?.textContent).toBe('');

    (root.querySelector('[data-gear="3"]') as HTMLButtonElement).click();
    expect(selections).toEqual([3]);
    expect((root.querySelector('#hud-shifter') as HTMLElement).dataset.mode).toBe('manual');
    expect(root.querySelector('#gear-mode-hint')?.textContent).toBe('3 SELECTED');
    expect(root.querySelector('#gear-knob')?.textContent).toBe('3');

    (root.querySelector('[data-gear="auto"]') as HTMLButtonElement).click();
    expect(selections).toEqual([3, null]);
    expect(root.querySelector('#gear-knob')?.textContent).toBe('A');

    ui.updateTelemetry({ gear: 4 });
    expect(root.querySelector('#gear-knob')?.textContent).toBe('A');
    expect(root.querySelector('[data-gear="auto"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('operates a separate 2H, 4H, and 4L transfer-case stick', () => {
    const selections: string[] = [];
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ui = new PlayerUI(root, {
      development: false,
      onTransferCaseSelection: (mode) => selections.push(mode),
    });
    expect(root.querySelector('#transfer-mode-hint')?.textContent).toBe('');

    (root.querySelector('[data-transfer="2h"]') as HTMLButtonElement).click();
    expect(selections).toEqual(['2h']);
    expect(root.querySelector('#transfer-knob')?.textContent).toBe('2H');
    expect(root.querySelector('#transfer-mode-hint')?.textContent).toBe('2WD HIGH');

    ui.updateTelemetry({ transferCase: '4l' });
    expect(root.querySelector('#transfer-knob')?.textContent).toBe('4L');
    expect(root.querySelector('#hud-drivetrain')?.textContent).toContain('4L');
  });

  it('replaces transfer-case interaction with a fixed-RWD indicator', () => {
    const selections: string[] = [];
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ui = new PlayerUI(root, {
      development: false,
      onTransferCaseSelection: (mode) => selections.push(mode),
    });
    ui.updateTelemetry({ fixedRwd: true, transferCase: '2h' });
    const gate = root.querySelector('#transfer-gate') as HTMLElement;
    expect(gate.dataset.fixed).toBe('true');
    expect(gate.getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelector('#transfer-mode-hint')?.textContent).toBe('RWD · FIXED HIGH');
    expect(root.querySelector('#hud-drivetrain')?.textContent).toBe('RWD · FIXED HIGH');
    expect([...root.querySelectorAll<HTMLButtonElement>('[data-transfer]')].every((button) => button.disabled)).toBe(true);
    (root.querySelector('[data-transfer="4l"]') as HTMLButtonElement).click();
    expect(selections).toEqual([]);
  });
});

describe('PlayerUI connection states', () => {
  it('keeps telemetry mounted through reconnect and fatal transitions', () => {
    const { root, ui } = makeUI();
    const cluster = root.querySelector('.hud-cluster');
    const alert = root.querySelector('#hud-alert') as HTMLElement;

    ui.setConnectionState({ mode: 'connected' });
    expect(alert.hidden).toBe(true);

    ui.setConnectionState({
      mode: 'reconnecting',
      message: 'disconnected: socket closed — reconnecting in 2s',
    });
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('socket closed');
    expect(alert.getAttribute('aria-live')).toBe('polite');
    expect(root.querySelector('.hud-cluster')).toBe(cluster);

    ui.setConnectionState({ mode: 'fatal', message: 'protocol mismatch: update client' });
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('protocol mismatch');
    expect(root.querySelector('.hud-cluster')).toBe(cluster);

    ui.setConnectionState({ mode: 'connected' });
    expect(alert.hidden).toBe(true);
    expect(root.textContent).not.toContain('protocol mismatch');
  });

  it('keeps the FPS readout out of production presentation', () => {
    const { root } = makeUI(false);
    expect((root.querySelector('#hud-fps') as HTMLElement).hidden).toBe(true);
  });
});
