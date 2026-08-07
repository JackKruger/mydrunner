// Live tuning panel. Activated only when the player's saved name matches
// "jack" (case-insensitive). Renders a side panel of sliders bound to
// the shared TUNING object. LocalSimulation reads TUNING directly, so a
// slider change is authoritative immediately. Copy settings to bake the
// chosen values into constants for every newly loaded client.
//
// "Copy settings" serialises TUNING as a TypeScript snippet so the
// values can be pasted into constants.ts as new defaults.

import { AXLE, TUNING, WATER } from '@mydrunner/shared';

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
  { label: 'surf.concrete', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.concrete, set: (v) => (TUNING.surfaceFriction.concrete = v) },
  // Suspension feel — per-axle SCALARS on the compile-time rates in
  // AXLE / vehicleGeom. 1.0 = the constants as shipped. They scale rather
  // than replace so per-kind geometry (the Hilux's softer rear) survives.
  { label: 'axleF.rideStiff×', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleFront.rideStiffnessMult, set: (v) => (TUNING.axleFront.rideStiffnessMult = v) },
  { label: 'axleF.rideDamp×', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleFront.rideDampingMult, set: (v) => (TUNING.axleFront.rideDampingMult = v) },
  { label: 'axleF.rollStiff×', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleFront.rollStiffnessMult, set: (v) => (TUNING.axleFront.rollStiffnessMult = v) },
  { label: 'axleF.maxArtic×', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleFront.maxArticulationMult, set: (v) => (TUNING.axleFront.maxArticulationMult = v) },
  { label: 'axleR.rideStiff×', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleRear.rideStiffnessMult, set: (v) => (TUNING.axleRear.rideStiffnessMult = v) },
  { label: 'axleR.rideDamp×', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleRear.rideDampingMult, set: (v) => (TUNING.axleRear.rideDampingMult = v) },
  { label: 'axleR.rollStiff×', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleRear.rollStiffnessMult, set: (v) => (TUNING.axleRear.rollStiffnessMult = v) },
  { label: 'axleR.maxArtic×', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleRear.maxArticulationMult, set: (v) => (TUNING.axleRear.maxArticulationMult = v) },
  { label: 'latStiff', min: 2000, max: 40000, step: 500, get: () => TUNING.tireLatStiffness, set: (v) => (TUNING.tireLatStiffness = v) },
  // Drivetrain.
  { label: 'brakeForce', min: 500, max: 6000, step: 50, get: () => TUNING.brakeForce, set: (v) => (TUNING.brakeForce = v) },
  { label: 'maxSteer (rad)', min: 0.1, max: 0.8, step: 0.02, get: () => TUNING.maxSteer, set: (v) => (TUNING.maxSteer = v) },
  { label: 'steerSpeed', min: 0.5, max: 6, step: 0.1, get: () => TUNING.steerSpeed, set: (v) => (TUNING.steerSpeed = v) },
  // Water. These three interact strongly - more buoyancy means less tyre
  // load means the current carries you further - so a crossing gets tuned
  // on all three at once, live, while driving it.
  { label: 'waterBuoyancy×', min: 0, max: 2, step: 0.05, get: () => TUNING.waterBuoyancy, set: (v) => (TUNING.waterBuoyancy = v) },
  { label: 'waterDrag×', min: 0, max: 3, step: 0.05, get: () => TUNING.waterDrag, set: (v) => (TUNING.waterDrag = v) },
  { label: 'waterFlow×', min: 0, max: 3, step: 0.05, get: () => TUNING.waterFlowScale, set: (v) => (TUNING.waterFlowScale = v) },
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
  // The axle sliders are multipliers, so resolve them against the shipped
  // constants: what you paste into AXLE has to be an absolute rate. These
  // are the PATROL numbers (AXLE.front / AXLE.rear); other kinds derive
  // their own rates in vehicleGeom.ts and scale by the same factor.
  const ax = (base: number, mult: number, d = 0): string => f(base * mult, d);
  return `// Paste into shared/src/constants.ts as new defaults.
export const INCLINE_ASSIST_MAX = ${f(t.inclineAssistMax)};
export const SURFACE_FRICTION = {
  road: ${f(t.surfaceFriction.road)},
  dirt: ${f(t.surfaceFriction.dirt)},
  mud: ${f(t.surfaceFriction.mud)},
  deepMud: ${f(t.surfaceFriction.deepMud)},
  grass: ${f(t.surfaceFriction.grass)},
  gravel: ${f(t.surfaceFriction.gravel)},
  concrete: ${f(t.surfaceFriction.concrete)},
} as const;
// AXLE.* (solid-axle per-axle suspension), resolved for Patrol:
//   front: {
//     rideStiffness: ${ax(AXLE.front.rideStiffness, t.axleFront.rideStiffnessMult)},   // x${f(t.axleFront.rideStiffnessMult, 2)}
//     rideDamping: ${ax(AXLE.front.rideDamping, t.axleFront.rideDampingMult)},     // x${f(t.axleFront.rideDampingMult, 2)}
//     rollStiffness: ${ax(AXLE.front.rollStiffness, t.axleFront.rollStiffnessMult)},   // x${f(t.axleFront.rollStiffnessMult, 2)}
//     maxArticulation: ${ax(AXLE.front.maxArticulation, t.axleFront.maxArticulationMult, 2)}, // x${f(t.axleFront.maxArticulationMult, 2)}
//   },
//   rear: {
//     rideStiffness: ${ax(AXLE.rear.rideStiffness, t.axleRear.rideStiffnessMult)},   // x${f(t.axleRear.rideStiffnessMult, 2)}
//     rideDamping: ${ax(AXLE.rear.rideDamping, t.axleRear.rideDampingMult)},     // x${f(t.axleRear.rideDampingMult, 2)}
//     rollStiffness: ${ax(AXLE.rear.rollStiffness, t.axleRear.rollStiffnessMult)},   // x${f(t.axleRear.rollStiffnessMult, 2)}
//     maxArticulation: ${ax(AXLE.rear.maxArticulation, t.axleRear.maxArticulationMult, 2)}, // x${f(t.axleRear.maxArticulationMult, 2)}
//   },
// TIRE_LATERAL.stiffness: ${f(t.tireLatStiffness, 0)},
// VEHICLE.* (drive feel):
//   brakeForce: ${f(t.brakeForce, 0)},
//   maxSteer: ${f(t.maxSteer, 2)},
//   steerSpeed: ${f(t.steerSpeed, 2)},
//   frontGripMult: ${f(t.frontGripMult, 2)},
//   rearGripMult: ${f(t.rearGripMult, 2)},
// WATER.* multipliers - resolve against the WATER block before pasting:
//   buoyancy x${f(t.waterBuoyancy, 2)}  (hullVolume ${f(WATER.hullVolume * t.waterBuoyancy, 2)})
//   drag     x${f(t.waterDrag, 2)}  (long ${f(WATER.dragLong * t.waterDrag, 0)}, lat ${f(WATER.dragLat * t.waterDrag, 0)}, vert ${f(WATER.dragVert * t.waterDrag, 0)})
//   flow     x${f(t.waterFlowScale, 2)}
`;
}

/** Update the live axle readout in the debug panel. Call each render frame
 *  with the most recent snapshot-interpolated axle state. */
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
