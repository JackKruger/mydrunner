import { afterEach, describe, expect, it, vi } from 'vitest';
import { Physics, TUNING } from '@mydrunner/shared';
import { initDebugPanel, updateVehicleDebug } from '../debugPanel.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function telemetry(): Physics.VehicleDebugTelemetry {
  const wheel = (contact: boolean): Physics.WheelDebugTelemetry => ({
    contact,
    contactPoint: { x: 0, y: 0, z: 0 },
    contactNormal: { x: 0, y: 1, z: 0 },
    surface: Physics.Surface.Mud,
    waterDepth: 0,
    normalLoad: contact ? 4_000 : 0,
    gripCoefficient: contact ? 0.8 : 0,
    gripLimit: contact ? 3_200 : 0,
    longitudinalForce: 2_000,
    relaxedLongitudinalForce: 1_900,
    lateralForce: 1_000,
    force: { x: 1_000, y: 0, z: 2_000 },
    slipRatio: 0.12,
    slipAngle: 0.08,
    utilization: contact ? 0.72 : 0,
    suspensionCompression: 0.09,
    suspensionOrigin: { x: 0, y: 1, z: 0 },
    suspensionEnd: { x: 0, y: 0, z: 0 },
    wheelCenter: { x: 0, y: 0.4, z: 0 },
    suspensionRestLength: 0.5,
    droopMax: 0.2,
    bumpMax: 0.15,
    angularVelocity: 10,
    driveTorque: 300,
    brakeTorque: 0,
    groundTorque: -250,
    contactZone: contact ? 'tread' : 'air',
    treadFraction: contact ? 1 : 0,
    suspensionAxisAlignment: contact ? 1 : 0,
    carcassDeflection: contact ? 0.016 : 0,
    suspensionForce: contact ? 4_000 : 0,
    carcassForce: contact ? 4_000 : 0,
    sinkDepth: contact ? 0.04 : 0,
    soilDrag: contact ? 250 : 0,
    slipWork: contact ? 120 : 0,
  });
  return {
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    centerOfMassLocal: { x: 0, y: -0.2, z: 0 },
    centerOfMassWorld: { x: 0, y: 0.8, z: 0 },
    massKg: 1_800,
    wheelbase: 2.7,
    track: 1.6,
    wheelRadius: 0.4,
    pressurePsi: 24,
    rollAngle: 0.1,
    pitchAngle: -0.05,
    staticRollLimit: 0.7,
    staticPitchLimit: 0.8,
    linearVelocity: { x: 0, y: 0, z: 5 },
    angularVelocity: { x: 0, y: 0.2, z: 0 },
    accelerationWorld: { x: 1, y: 0, z: 2 },
    longitudinalG: 0.2,
    lateralG: 0.1,
    yawRate: 0.2,
    driveline: {
      rpm: 2200,
      gear: 2,
      throttle: 0.8,
      transferCase: '4h',
      frontLocked: false,
      rearLocked: true,
      outputTorque: 900,
      drivenCarrierRpm: 800,
      differentialReactionTorque: 120,
    },
    water: {
      submerged: 0,
      buoyancyForce: { x: 0, y: 0, z: 0 },
      buoyancyPoint: { x: 0, y: 0, z: 0 },
      dragForce: { x: 0, y: 0, z: 0 },
      dragPoint: { x: 0, y: 0, z: 0 },
      dragTorque: { x: 0, y: 0, z: 0 },
    },
    axles: [
      { iterationResidual: 0, tubeContact: false, housingContact: false },
      { iterationResidual: 0, tubeContact: false, housingContact: false },
    ],
    wheels: [wheel(true), wheel(true), wheel(true), wheel(true)],
  };
}

describe('physics debug panel', () => {
  it('is idempotent and renders live tire telemetry', () => {
    initDebugPanel();
    initDebugPanel();
    updateVehicleDebug(telemetry());

    expect(document.querySelectorAll('#debug-panel')).toHaveLength(1);
    expect(document.querySelectorAll('#debug-tuning-card')).toHaveLength(1);
    expect(document.querySelector('#debug-panel')?.contains(document.querySelector('#debug-tuning-card'))).toBe(false);
    const tuningRows = [...document.querySelectorAll<HTMLElement>('#debug-tuning-card .row')];
    expect(tuningRows.length).toBeGreaterThan(20);
    expect(tuningRows.every((row) => Boolean(row.dataset.help && row.title))).toBe(true);
    tuningRows[0]!.querySelector('input')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.querySelector('#debug-tuning-help')?.textContent).toContain('front axle friction budget');
    expect(document.querySelector('[data-debug="tip-state"]')?.textContent).toContain('STABLE');
    expect(document.querySelector('[data-wheel="0"] [data-field="surface"]')?.textContent).toContain('mud');
    expect((document.querySelector('[data-wheel="0"] [data-field="bar"]') as HTMLElement).style.width).toBe('72%');
    expect(document.querySelector('[data-debug="drive-head"]')?.textContent).toContain('2200 rpm');
    expect(document.querySelector('[data-drive-wheel="0"]')?.textContent).toContain('drive 300');
    expect(document.querySelector('[data-trace="lat"]')?.getAttribute('points')).not.toBe('');
    expect(document.querySelector('[data-mini="roll"]')?.getAttribute('points')).not.toBe('');
    expect(document.querySelector('[data-mini="speed"]')?.getAttribute('points')).not.toBe('');
    expect(document.querySelector('[data-mini="rpm"]')?.getAttribute('points')).not.toBe('');
    expect(document.querySelector('[data-mini="wheel0"]')?.getAttribute('points')).not.toBe('');
    expect(document.querySelector('[data-debug="speed"]')?.textContent).toBe('18.0 km/h');
    expect(document.querySelector('[data-wheel="0"]')?.getAttribute('title')).toContain('front-left friction circle');
    expect(document.querySelector('#debug-export')?.getAttribute('title')).toContain('Download every recorded run');

    const torqueRow = tuningRows.find((row) => row.querySelector('label')?.textContent === 'engineTorque×');
    const savedTorque = TUNING.engineTorqueMult;
    const torqueInput = torqueRow?.querySelector<HTMLInputElement>('input');
    expect(torqueInput).toBeTruthy();
    torqueInput!.value = '1.25';
    torqueInput!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(TUNING.engineTorqueMult).toBe(1.25);
    expect(torqueRow?.title).toContain('engine torque');
    TUNING.engineTorqueMult = savedTorque;

    const newTireControls = [
      'carcassCompliance×',
      'radialDamping×',
      'sidewallCorrection×',
      'sidewallFriction×',
      'visualBagging×',
      'shoulderBulge×',
    ];
    for (const label of newTireControls) {
      expect(tuningRows.some((row) => row.querySelector('label')?.textContent === label)).toBe(true);
    }
    const baggingRow = tuningRows.find((row) => row.querySelector('label')?.textContent === 'visualBagging×');
    const savedBagging = TUNING.tireVisualDeformationMult;
    const baggingInput = baggingRow?.querySelector<HTMLInputElement>('input');
    expect(baggingInput).toBeTruthy();
    baggingInput!.value = '2.5';
    baggingInput!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(TUNING.tireVisualDeformationMult).toBe(2.5);
    TUNING.tireVisualDeformationMult = savedBagging;

    const record = document.querySelector<HTMLButtonElement>('#debug-record')!;
    record.click();
    updateVehicleDebug(telemetry());
    expect(document.querySelector('#debug-record-status')?.textContent).toContain('recording run 1');
    record.click();
    expect(document.querySelector('#debug-record-status')?.textContent).toContain('run 1 saved');

    const createObjectUrl = vi.fn(() => 'blob:tuning-run');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    document.querySelector<HTMLButtonElement>('#debug-export')!.click();
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(document.querySelector('#debug-record-status')?.textContent).toContain('exported 1 runs');
  });
});
