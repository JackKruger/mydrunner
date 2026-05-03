// Live tuning panel. Activated only when the player's saved name matches
// "jack" (case-insensitive). Renders a side panel of sliders bound to
// the shared TUNING object so changes apply to the local prediction sim
// on the next physics tick. The server keeps its compiled defaults, so
// expect some reconcile drift while tuning - the point is to find the
// numbers that feel right by hand, not to ship via this panel.
//
// "Copy settings" serialises TUNING as a TypeScript snippet so the
// values can be pasted into constants.ts as new defaults.

import { TUNING } from '@mydrunner/shared';

interface Slider {
  label: string;
  min: number;
  max: number;
  step: number;
  /** Read the current value from TUNING. */
  get: () => number;
  /** Write a new value back into TUNING. */
  set: (v: number) => void;
}

const SLIDERS: Slider[] = [
  // Tyre-grip headline numbers.
  { label: 'tireBaseGrip', min: 0.5, max: 6, step: 0.05, get: () => TUNING.tireBaseGrip, set: (v) => (TUNING.tireBaseGrip = v) },
  { label: 'inclineAssistMax', min: 0, max: 3, step: 0.05, get: () => TUNING.inclineAssistMax, set: (v) => (TUNING.inclineAssistMax = v) },
  { label: 'frontGripMult', min: 0.4, max: 1.4, step: 0.02, get: () => TUNING.frontGripMult, set: (v) => (TUNING.frontGripMult = v) },
  { label: 'rearGripMult', min: 0.4, max: 1.4, step: 0.02, get: () => TUNING.rearGripMult, set: (v) => (TUNING.rearGripMult = v) },
  // Per-surface friction.
  { label: 'surf.road', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.road, set: (v) => (TUNING.surfaceFriction.road = v) },
  { label: 'surf.dirt', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.dirt, set: (v) => (TUNING.surfaceFriction.dirt = v) },
  { label: 'surf.mud', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.mud, set: (v) => (TUNING.surfaceFriction.mud = v) },
  { label: 'surf.deepMud', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.deepMud, set: (v) => (TUNING.surfaceFriction.deepMud = v) },
  { label: 'surf.grass', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.grass, set: (v) => (TUNING.surfaceFriction.grass = v) },
  { label: 'surf.gravel', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.gravel, set: (v) => (TUNING.surfaceFriction.gravel = v) },
  // Suspension feel — solid-axle per-axle knobs.
  { label: 'axleF.rideStiff', min: 20000, max: 200000, step: 1000, get: () => TUNING.axleFront.rideStiffness, set: (v) => (TUNING.axleFront.rideStiffness = v) },
  { label: 'axleF.rideDamp', min: 2000, max: 40000, step: 500, get: () => TUNING.axleFront.rideDamping, set: (v) => (TUNING.axleFront.rideDamping = v) },
  { label: 'axleF.rollStiff', min: 5000, max: 80000, step: 1000, get: () => TUNING.axleFront.rollStiffness, set: (v) => (TUNING.axleFront.rollStiffness = v) },
  { label: 'axleF.maxArtic', min: 0.1, max: 1.0, step: 0.02, get: () => TUNING.axleFront.maxArticulation, set: (v) => (TUNING.axleFront.maxArticulation = v) },
  { label: 'axleR.rideStiff', min: 20000, max: 200000, step: 1000, get: () => TUNING.axleRear.rideStiffness, set: (v) => (TUNING.axleRear.rideStiffness = v) },
  { label: 'axleR.rideDamp', min: 2000, max: 40000, step: 500, get: () => TUNING.axleRear.rideDamping, set: (v) => (TUNING.axleRear.rideDamping = v) },
  { label: 'axleR.rollStiff', min: 5000, max: 80000, step: 1000, get: () => TUNING.axleRear.rollStiffness, set: (v) => (TUNING.axleRear.rollStiffness = v) },
  { label: 'axleR.maxArtic', min: 0.1, max: 1.0, step: 0.02, get: () => TUNING.axleRear.maxArticulation, set: (v) => (TUNING.axleRear.maxArticulation = v) },
  { label: 'latStiff', min: 2000, max: 40000, step: 500, get: () => TUNING.tireLatStiffness, set: (v) => (TUNING.tireLatStiffness = v) },
  // Drivetrain.
  { label: 'brakeForce', min: 500, max: 6000, step: 50, get: () => TUNING.brakeForce, set: (v) => (TUNING.brakeForce = v) },
  { label: 'maxSteer (rad)', min: 0.1, max: 0.8, step: 0.02, get: () => TUNING.maxSteer, set: (v) => (TUNING.maxSteer = v) },
  { label: 'steerSpeed', min: 0.5, max: 6, step: 0.1, get: () => TUNING.steerSpeed, set: (v) => (TUNING.steerSpeed = v) },
  // Tyre slip curve.
  { label: 'tire.slipPeak', min: 0.05, max: 0.5, step: 0.01, get: () => TUNING.slipPeak, set: (v) => (TUNING.slipPeak = v) },
  { label: 'tire.slipFalloff', min: 1, max: 10, step: 0.1, get: () => TUNING.slipFalloff, set: (v) => (TUNING.slipFalloff = v) },
  { label: 'tire.slipFloor', min: 0, max: 1, step: 0.02, get: () => TUNING.slipFloor, set: (v) => (TUNING.slipFloor = v) },
];

const STYLE = `
#debug-panel {
  position: fixed;
  top: 8px; right: 8px;
  width: 280px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  background: rgba(10, 14, 20, 0.92);
  border: 1px solid #d9531e;
  border-radius: 6px;
  padding: 10px 12px;
  z-index: 7;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #eee;
  user-select: none;
}
#debug-panel h2 {
  font-size: 12px;
  letter-spacing: 0.08em;
  margin-bottom: 8px;
  color: #d9531e;
}
#debug-panel .row {
  display: grid;
  grid-template-columns: 100px 1fr 50px;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}
#debug-panel .row label { color: #aab; font-size: 10px; }
#debug-panel .row input[type=range] { width: 100%; }
#debug-panel .row .val { text-align: right; font-variant-numeric: tabular-nums; color: #eee; }
#debug-panel .actions { display: flex; gap: 8px; margin-top: 10px; }
#debug-panel button {
  background: #1a2030;
  color: #eee;
  border: 1px solid #2a323d;
  border-radius: 4px;
  padding: 6px 10px;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  flex: 1;
}
#debug-panel button:hover { border-color: #d9531e; }
#debug-panel .copied { color: #7adfff; font-size: 10px; align-self: center; }
`;

export function isDebugUser(name: string): boolean {
  return name.trim().toLowerCase() === 'jack';
}

let axleEl: HTMLDivElement | null = null;

export function initDebugPanel(): void {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.innerHTML = `<h2>TUNING (jack)</h2>`;
  document.body.appendChild(panel);

  // Live axle readout section.
  const axleSection = document.createElement('div');
  axleSection.id = 'debug-axles';
  axleSection.style.cssText =
    'margin-top:12px;padding-top:8px;border-top:1px solid #2a323d;font-size:10px;color:#7adfff;';
  axleSection.innerHTML =
    '<div style="color:#d9531e;margin-bottom:4px">AXLE STATE</div>' +
    '<div id="debug-axle-front">front: --</div>' +
    '<div id="debug-axle-rear">rear: --</div>';
  panel.appendChild(axleSection);
  axleEl = axleSection;

  const valueEls = new Map<string, HTMLSpanElement>();

  for (const s of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = s.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(s.min);
    input.max = String(s.max);
    input.step = String(s.step);
    input.value = String(s.get());
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = formatValue(s.get(), s.step);
    valueEls.set(s.label, val);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      s.set(v);
      val.textContent = formatValue(v, s.step);
    });
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(val);
    panel.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy settings';
  const status = document.createElement('span');
  status.className = 'copied';
  copyBtn.addEventListener('click', async () => {
    const text = serialiseTuning();
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'copied';
      setTimeout(() => (status.textContent = ''), 1500);
    } catch {
      // Fallback: drop into a textarea so the user can copy manually.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); status.textContent = 'copied (fallback)'; }
      catch { status.textContent = 'copy failed'; }
      document.body.removeChild(ta);
      setTimeout(() => (status.textContent = ''), 2000);
    }
  });
  actions.appendChild(copyBtn);
  actions.appendChild(status);
  panel.appendChild(actions);
}

function formatValue(v: number, step: number): string {
  if (step >= 1) return v.toFixed(0);
  if (step >= 0.1) return v.toFixed(2);
  return v.toFixed(3);
}

function serialiseTuning(): string {
  const t = TUNING;
  const f = (n: number, d = 3): string => Number(n.toFixed(d)).toString();
  return `// Paste into shared/src/constants.ts as new defaults.
export const TIRE_BASE_GRIP = ${f(t.tireBaseGrip)};
export const INCLINE_ASSIST_MAX = ${f(t.inclineAssistMax)};
export const SURFACE_FRICTION = {
  road: ${f(t.surfaceFriction.road)},
  dirt: ${f(t.surfaceFriction.dirt)},
  mud: ${f(t.surfaceFriction.mud)},
  deepMud: ${f(t.surfaceFriction.deepMud)},
  grass: ${f(t.surfaceFriction.grass)},
  gravel: ${f(t.surfaceFriction.gravel)},
} as const;
// AXLE.* (solid-axle per-axle suspension):
//   front: {
//     rideStiffness: ${f(t.axleFront.rideStiffness, 0)},
//     rideDamping: ${f(t.axleFront.rideDamping, 0)},
//     rollStiffness: ${f(t.axleFront.rollStiffness, 0)},
//     maxArticulation: ${f(t.axleFront.maxArticulation, 2)},
//   },
//   rear: {
//     rideStiffness: ${f(t.axleRear.rideStiffness, 0)},
//     rideDamping: ${f(t.axleRear.rideDamping, 0)},
//     rollStiffness: ${f(t.axleRear.rollStiffness, 0)},
//     maxArticulation: ${f(t.axleRear.maxArticulation, 2)},
//   },
//   tireLatStiffness: ${f(t.tireLatStiffness, 0)},
// VEHICLE.* (drive feel):
//   brakeForce: ${f(t.brakeForce, 0)},
//   maxSteer: ${f(t.maxSteer, 2)},
//   steerSpeed: ${f(t.steerSpeed, 2)},
//   frontGripMult: ${f(t.frontGripMult, 2)},
//   rearGripMult: ${f(t.rearGripMult, 2)},
// TIRE.*:
//   slipPeak: ${f(t.slipPeak, 2)},
//   slipFalloff: ${f(t.slipFalloff, 2)},
//   slipFloor: ${f(t.slipFloor, 2)},
`;
}

/** Update the live axle readout in the debug panel. Call each render frame
 *  from the main loop with the current prediction axle state. */
export function updateAxleDebug(
  front: { rideY: number; rollAngle: number },
  rear: { rideY: number; rollAngle: number },
): void {
  if (!axleEl) return;
  const fEl = document.getElementById('debug-axle-front');
  const rEl = document.getElementById('debug-axle-rear');
  if (fEl) {
    fEl.textContent =
      `front: rideY=${front.rideY.toFixed(3)}m  roll=${(front.rollAngle * 57.296).toFixed(1)}deg`;
  }
  if (rEl) {
    rEl.textContent =
      `rear:  rideY=${rear.rideY.toFixed(3)}m  roll=${(rear.rollAngle * 57.296).toFixed(1)}deg`;
  }
}
