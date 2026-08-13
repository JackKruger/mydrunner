// Live tuning + owner-physics telemetry panel. Activated by `?dev` (with the
// legacy "jack" saved-name shortcut retained). Renders sliders bound to
// the shared TUNING object. LocalSimulation reads TUNING directly, so a
// slider change is authoritative immediately. Copy settings to bake the
// chosen values into constants for every newly loaded client.
//
// "Copy settings" serialises TUNING as a TypeScript snippet so the
// values can be pasted into constants.ts as new defaults.

import {
  ANTI_ROLL,
  AXLE,
  ENGINE,
  Physics,
  TIRE_LONG_FRICTION,
  TUNING,
  WATER,
  WHEEL,
} from '@mydrunner/shared';

interface Slider {
  label: string;
  description: string;
  group?: keyof typeof TUNING_GROUP_HELP;
  min: number;
  max: number;
  step: number;
  /** Read the current value from TUNING. */
  get: () => number;
  /** Write a new value back into TUNING. */
  set: (v: number) => void;
}

const TUNING_GROUP_HELP = {
  'TIRE + GRIP': 'Tyre carcass compliance and visuals, sidewall response, combined-force capacity, and lateral breakaway.',
  'TERRAIN + ROLLING': 'Surface friction and the separate energy loss caused by rolling through soft ground.',
  'SUSPENSION + ANTI-ROLL': 'Spring, damping, articulation, and cornering load-transfer controls.',
  'POWERTRAIN + STEERING': 'Brakes, engine output, off-throttle drag, steering rate, and high-speed steering authority.',
  WATER: 'Buoyancy, hull drag, and authored current strength while crossing water.',
} as const;

const SLIDERS: Slider[] = [
  // Tyre-grip headline numbers.
  { label: 'frontGripMult', description: 'Global multiplier on the front axle friction budget after tire and surface grip are resolved.', min: 0.4, max: 1.4, step: 0.02, get: () => TUNING.frontGripMult, set: (v) => (TUNING.frontGripMult = v) },
  { label: 'rearGripMult', description: 'Global multiplier on the rear axle friction budget. Lower values make power oversteer easier.', min: 0.4, max: 1.4, step: 0.02, get: () => TUNING.rearGripMult, set: (v) => (TUNING.rearGripMult = v) },
  { label: 'longGrip×', description: 'Multiplier on the base acceleration and braking grip available at every tire. Surface and axle grip still apply afterward.', min: 0.5, max: 1.5, step: 0.02, get: () => TUNING.tireLongGripMult, set: (v) => (TUNING.tireLongGripMult = v) },
  { label: 'edgeWrap×', description: 'Multiplier on pressure-dependent tread reach and corner hooking at validated ledges only.', min: 0.5, max: 1.5, step: 0.02, get: () => TUNING.tireEdgeWrapMult, set: (v) => (TUNING.tireEdgeWrapMult = v) },
  { label: 'carcassCompliance×', description: 'Tyre softness relative to the fitted carcass preset. Higher values produce more physical deflection under the same load.', min: 0.4, max: 2.5, step: 0.05, get: () => TUNING.tireCarcassComplianceMult, set: (v) => (TUNING.tireCarcassComplianceMult = v) },
  { label: 'radialDamping×', description: 'Carcass contribution to the series suspension damping. Raise it to settle tyre squash faster; excessive values can feel harsh.', min: 0.3, max: 2, step: 0.05, get: () => TUNING.tireRadialDampingMult, set: (v) => (TUNING.tireRadialDampingMult = v) },
  { label: 'sidewallCorrection×', description: 'Rate and speed of the compliant sidewall collision constraint. Higher values push out of ledges and side-rest contacts more firmly.', min: 0.25, max: 2.5, step: 0.05, get: () => TUNING.tireSidewallCorrectionMult, set: (v) => (TUNING.tireSidewallCorrectionMult = v) },
  { label: 'sidewallFriction×', description: 'Tangential scrub from a pure sidewall contact. It never adds drive or braking torque.', min: 0, max: 2.5, step: 0.05, get: () => TUNING.tireSidewallFrictionMult, set: (v) => (TUNING.tireSidewallFrictionMult = v) },
  { label: 'visualBagging×', description: 'Render-only contact-patch flattening. Use this to inspect deformation without changing tyre physics.', min: 0, max: 3, step: 0.05, get: () => TUNING.tireVisualDeformationMult, set: (v) => (TUNING.tireVisualDeformationMult = v) },
  { label: 'shoulderBulge×', description: 'Render-only shoulder expansion around a loaded patch. 0 leaves flattening on but removes the bulge.', min: 0, max: 3, step: 0.05, get: () => TUNING.tireShoulderBulgeMult, set: (v) => (TUNING.tireShoulderBulgeMult = v) },
  { label: 'lat/long grip', description: 'Lateral capacity relative to longitudinal capacity in the friction ellipse. Lower values make tires run out of cornering grip sooner.', min: 0.5, max: 1.4, step: 0.02, get: () => TUNING.tireLateralGripRatio, set: (v) => (TUNING.tireLateralGripRatio = v) },
  { label: 'latStiff', description: 'Lateral tire stiffness in force per metre/second of sideways patch velocity. Higher values give sharper turn-in.', min: 2000, max: 40000, step: 500, get: () => TUNING.tireLatStiffness, set: (v) => (TUNING.tireLatStiffness = v) },
  { label: 'slipPeak (°)', description: 'Slip angle where lateral grip begins falling. Higher values feel forgiving; lower values enter a slide earlier.', min: 4, max: 16, step: 0.25, get: () => TUNING.tireSlipAnglePeak * 180 / Math.PI, set: (v) => (TUNING.tireSlipAnglePeak = v * Math.PI / 180) },
  { label: 'slipFalloff', description: 'Sharpness of lateral grip loss after the peak slip angle. Higher values produce a more sudden breakaway.', min: 1, max: 12, step: 0.25, get: () => TUNING.tireSlipAngleFalloff, set: (v) => (TUNING.tireSlipAngleFalloff = v) },
  { label: 'slideGripFloor', description: 'Minimum fraction of lateral grip retained in a fully developed slide. Higher values make recovery easier.', min: 0.1, max: 0.9, step: 0.02, get: () => TUNING.tireSlipAngleFloor, set: (v) => (TUNING.tireSlipAngleFloor = v) },
  // Per-surface friction.
  { group: 'TERRAIN + ROLLING', label: 'surf.road', description: 'Base friction coefficient for asphalt road cells, before the fitted tire and axle multipliers.', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.road, set: (v) => (TUNING.surfaceFriction.road = v) },
  { label: 'surf.dirt', description: 'Base friction coefficient for ordinary dirt trail cells.', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.dirt, set: (v) => (TUNING.surfaceFriction.dirt = v) },
  { label: 'surf.mud', description: 'Base friction coefficient for mud. Tire-specific mud grip still multiplies this value.', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.mud, set: (v) => (TUNING.surfaceFriction.mud = v) },
  { label: 'surf.deepMud', description: 'Base friction coefficient for deep mud, alongside its higher rolling resistance.', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.deepMud, set: (v) => (TUNING.surfaceFriction.deepMud = v) },
  { label: 'surf.grass', description: 'Base friction coefficient for grass terrain cells.', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.grass, set: (v) => (TUNING.surfaceFriction.grass = v) },
  { label: 'surf.gravel', description: 'Base friction coefficient for gravel roads and loose connectors.', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.gravel, set: (v) => (TUNING.surfaceFriction.gravel = v) },
  { label: 'surf.concrete', description: 'Base friction coefficient for concrete pads and workshop surfaces.', min: 0, max: 2, step: 0.02, get: () => TUNING.surfaceFriction.concrete, set: (v) => (TUNING.surfaceFriction.concrete = v) },
  { label: 'rollingRes×', description: 'Global viscous rolling-resistance multiplier. Higher values shorten coasting distance on every surface.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.rollingResistanceMult, set: (v) => (TUNING.rollingResistanceMult = v) },
  { label: 'mudRolling×', description: 'Mud rolling-resistance factor relative to the base road value. This controls bogging drag, not tire grip.', min: 1, max: 10, step: 0.25, get: () => TUNING.rollingResistanceMudMult, set: (v) => (TUNING.rollingResistanceMudMult = v) },
  { label: 'deepMudRoll×', description: 'Deep-mud rolling-resistance factor relative to the base road value. Raise it to make deep bogs consume momentum quickly.', min: 2, max: 24, step: 0.5, get: () => TUNING.rollingResistanceDeepMudMult, set: (v) => (TUNING.rollingResistanceDeepMudMult = v) },
  // Suspension feel — per-axle SCALARS on the compile-time rates in
  // AXLE / vehicleGeom. 1.0 = the constants as shipped. They scale rather
  // than replace so per-kind geometry (the Hilux's softer rear) survives.
  { group: 'SUSPENSION + ANTI-ROLL', label: 'axleF.rideStiff×', description: 'Front spring-rate multiplier. Higher values resist compression and sharpen vertical response.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleFront.rideStiffnessMult, set: (v) => (TUNING.axleFront.rideStiffnessMult = v) },
  { label: 'axleF.rideDamp×', description: 'Front compression damping multiplier. Raise it to settle bounce faster; too high can feel harsh.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleFront.rideDampingMult, set: (v) => (TUNING.axleFront.rideDampingMult = v) },
  { label: 'axleF.rollStiff×', description: 'Front axle roll-constraint multiplier. This changes the mechanical axle response; use the dedicated bar controls for cornering load transfer.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleFront.rollStiffnessMult, set: (v) => (TUNING.axleFront.rollStiffnessMult = v) },
  { label: 'axleF.maxArtic×', description: 'Front mechanical articulation-limit multiplier. Higher values let the axle follow larger cross-axle height differences.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleFront.maxArticulationMult, set: (v) => (TUNING.axleFront.maxArticulationMult = v) },
  { label: 'axleR.rideStiff×', description: 'Rear spring-rate multiplier. Use it to balance load carrying, squat, and rear compliance.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleRear.rideStiffnessMult, set: (v) => (TUNING.axleRear.rideStiffnessMult = v) },
  { label: 'axleR.rideDamp×', description: 'Rear compression damping multiplier. Controls how quickly rear suspension motion settles.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleRear.rideDampingMult, set: (v) => (TUNING.axleRear.rideDampingMult = v) },
  { label: 'axleR.rollStiff×', description: 'Rear axle roll-constraint multiplier. This changes the mechanical axle response; use the dedicated bar controls for cornering load transfer.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleRear.rollStiffnessMult, set: (v) => (TUNING.axleRear.rollStiffnessMult = v) },
  { label: 'axleR.maxArtic×', description: 'Rear mechanical articulation-limit multiplier. Raise for more rear cross-axle travel.', min: 0.25, max: 3, step: 0.05, get: () => TUNING.axleRear.maxArticulationMult, set: (v) => (TUNING.axleRear.maxArticulationMult = v) },
  { label: 'barStiff×', description: 'Global anti-roll bar stiffness multiplier. Higher values transfer more load across each axle and resist body roll.', min: 0.1, max: 3, step: 0.05, get: () => TUNING.antiRollStiffnessMult, set: (v) => (TUNING.antiRollStiffnessMult = v) },
  { label: 'barDamp×', description: 'Anti-roll bar damping multiplier. Higher values settle rapid left-right suspension motion but can feel abrupt over offset bumps.', min: 0.1, max: 3, step: 0.05, get: () => TUNING.antiRollDampingMult, set: (v) => (TUNING.antiRollDampingMult = v) },
  { label: 'barFrontShare', description: 'Fraction of total anti-roll response assigned to the front axle. More front share generally promotes understeer; less promotes oversteer.', min: 0.1, max: 0.9, step: 0.02, get: () => TUNING.antiRollFrontShare, set: (v) => (TUNING.antiRollFrontShare = v) },
  // Drivetrain.
  { group: 'POWERTRAIN + STEERING', label: 'brakeForce', description: 'Maximum service-brake force per wheel before the tire friction budget applies its own cap.', min: 500, max: 6000, step: 50, get: () => TUNING.brakeForce, set: (v) => (TUNING.brakeForce = v) },
  { label: 'engineTorque×', description: 'Multiplier on engine torque before the selected gear and final drive. It changes acceleration and wheelspin without changing shift points.', min: 0.5, max: 1.6, step: 0.05, get: () => TUNING.engineTorqueMult, set: (v) => (TUNING.engineTorqueMult = v) },
  { label: 'engineBrake×', description: 'Multiplier on off-throttle compression and speed-based engine braking. 0 allows free coasting while in gear.', min: 0, max: 2, step: 0.05, get: () => TUNING.engineBrakeMult, set: (v) => (TUNING.engineBrakeMult = v) },
  { label: 'maxSteer (rad)', description: 'Low-speed mechanical steering-angle limit in radians. Speed and fitted parts may reduce the active limit.', min: 0.1, max: 0.8, step: 0.02, get: () => TUNING.maxSteer, set: (v) => (TUNING.maxSteer = v) },
  { label: 'steerSpeed', description: 'Maximum rate at which the steering rack moves toward requested lock, in radians per second.', min: 0.5, max: 6, step: 0.1, get: () => TUNING.steerSpeed, set: (v) => (TUNING.steerSpeed = v) },
  { label: 'steerLimit (g)', description: 'Maximum lateral acceleration requested by full keyboard steering at speed. Lower values reduce high-speed steering angle and rollover risk.', min: 0.25, max: 1.2, step: 0.05, get: () => TUNING.maxSteerLateralAccel / 9.81, set: (v) => (TUNING.maxSteerLateralAccel = v * 9.81) },
  // Water. These three interact strongly - more buoyancy means less tyre
  // load means the current carries you further - so a crossing gets tuned
  // on all three at once, live, while driving it.
  { group: 'WATER', label: 'waterBuoyancy×', description: 'Multiplier on sealed-hull displacement. Higher values unload the tires and make the vehicle float sooner.', min: 0, max: 2, step: 0.05, get: () => TUNING.waterBuoyancy, set: (v) => (TUNING.waterBuoyancy = v) },
  { label: 'waterDrag×', description: 'Multiplier on translational and angular hull drag relative to the surrounding water.', min: 0, max: 3, step: 0.05, get: () => TUNING.waterDrag, set: (v) => (TUNING.waterDrag = v) },
  { label: 'waterFlow×', description: 'Multiplier on authored current velocity before relative-water drag is calculated.', min: 0, max: 3, step: 0.05, get: () => TUNING.waterFlowScale, set: (v) => (TUNING.waterFlowScale = v) },
];

const STYLE = `
#debug-panel,
#debug-tuning-card {
  position: fixed;
  top: 8px;
  width: 340px;
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
#debug-panel { right: 8px; }
#debug-tuning-card { left: 8px; }
#debug-panel h2,
#debug-tuning-card h2 {
  font-size: 12px;
  letter-spacing: 0.08em;
  margin-bottom: 8px;
  color: #d9531e;
}
#debug-panel .debug-subtitle,
#debug-tuning-card .debug-subtitle { color: #77828d; font-size: 9px; margin: -4px 0 10px; }
#debug-panel .debug-help,
#debug-tuning-card .debug-help {
  position: sticky; top: -10px; z-index: 3;
  min-height: 28px; margin: 0 -4px 8px; padding: 6px 8px;
  color: #c6eaf4; font-size: 9px; line-height: 1.4;
  background: rgba(13, 23, 31, .97); border: 1px solid #324653; border-left: 3px solid #55e9ff;
  border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,.25);
}
#debug-panel [data-help],
#debug-tuning-card [data-help] { cursor: help; }
#debug-panel .section-title,
#debug-tuning-card summary {
  color: #d9531e;
  font-size: 10px;
  letter-spacing: .08em;
  font-weight: 700;
  margin: 8px 0 6px;
}
#debug-tuning-card summary { cursor: pointer; padding: 6px 0; border-top: 1px solid #2a323d; }
#debug-panel .attitude {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
}
#debug-panel .metric,
#debug-panel .tire {
  background: rgba(31, 39, 49, .78);
  border: 1px solid #2f3b48;
  border-radius: 4px;
  padding: 5px 6px;
}
#debug-panel .metric small,
#debug-panel .tire small { display: block; color: #77828d; font-size: 8px; letter-spacing: .06em; }
#debug-panel .metric strong { display: block; margin-top: 2px; font-size: 12px; color: #edf5f7; }
#debug-panel .mini-trace {
  width: 100%; height: 22px; display: block; margin-top: 3px;
  background: #111820; border-radius: 2px;
}
#debug-panel .mini-trace line { stroke: #2d3a44; stroke-width: .6; }
#debug-panel .mini-trace polyline { fill: none; stroke-width: 1.35; vector-effect: non-scaling-stroke; }
#debug-panel .tip-state { margin: 6px 0; padding: 5px 7px; border-left: 3px solid #45e68a; background: rgba(69,230,138,.08); }
#debug-panel .tip-state.warn { border-color: #ffd34e; background: rgba(255,211,78,.08); color: #ffd34e; }
#debug-panel .tip-state.danger { border-color: #ff4f45; background: rgba(255,79,69,.1); color: #ff726a; }
#debug-panel .tires { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
#debug-panel .tire-head { display: flex; align-items: baseline; justify-content: space-between; gap: 4px; }
#debug-panel .tire-head strong { color: #55e9ff; }
#debug-panel .tire-head span { color: #9aa7b2; font-size: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#debug-panel .traction-bar { height: 5px; margin: 5px 0 4px; border-radius: 3px; background: #111820; overflow: hidden; }
#debug-panel .traction-bar i { display: block; height: 100%; width: 0; background: #45e68a; transition: width 80ms linear; }
#debug-panel .tire-data { color: #b7c2ca; font-size: 9px; line-height: 1.35; font-variant-numeric: tabular-nums; }
#debug-panel .tire .mini-trace { margin-top: 5px; }
#debug-panel .legend { color: #66727e; font-size: 8px; line-height: 1.4; margin-top: 6px; }
#debug-panel .trace {
  width: 100%; height: 82px; display: block;
  background: #0d141b; border: 1px solid #2f3b48; border-radius: 4px;
}
#debug-panel .trace-grid { stroke: #24313b; stroke-width: .6; }
#debug-panel .trace-zero { stroke: #44515b; stroke-width: .8; }
#debug-panel .trace polyline { fill: none; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
#debug-panel .trace-legend { display: flex; gap: 10px; color: #87949e; font-size: 8px; margin: 4px 0 7px; }
#debug-panel .trace-legend b { font-weight: 500; }
#debug-panel .driveline { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
#debug-panel .drive-node { background: #111a22; border: 1px solid #2f3b48; border-radius: 4px; padding: 5px 6px; }
#debug-panel .drive-node strong { color: #e5b85c; font-size: 9px; }
#debug-panel .drive-node div { color: #aeb8bf; font-size: 8px; line-height: 1.45; white-space: pre-line; }
#debug-panel .recording { border-top: 1px solid #2a323d; margin-top: 8px; padding-top: 8px; }
#debug-panel .record-actions { display: grid; grid-template-columns: 1.2fr 1fr .7fr; gap: 5px; }
#debug-panel .record-actions button { padding: 5px; }
#debug-panel .record-actions button.active { border-color: #ff4f45; color: #ff8b84; background: rgba(255,79,69,.12); }
#debug-panel .record-status { color: #7adfff; font-size: 8px; min-height: 12px; margin-top: 4px; }
#debug-tuning-card .row {
  display: grid;
  grid-template-columns: 100px 1fr 50px;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}
#debug-tuning-card .row label { color: #aab; font-size: 10px; }
#debug-tuning-card .row input[type=range] { width: 100%; }
#debug-tuning-card .row .val { text-align: right; font-variant-numeric: tabular-nums; color: #eee; }
#debug-tuning-card .tuning-group {
  margin: 9px 0 5px; padding-top: 6px; border-top: 1px solid #2a323d;
  color: #7adfff; font-size: 9px; font-weight: 700; letter-spacing: .08em;
}
#debug-tuning-card .actions { display: flex; gap: 8px; margin-top: 10px; }
#debug-panel button,
#debug-tuning-card button {
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
#debug-panel button:hover,
#debug-tuning-card button:hover { border-color: #d9531e; }
#debug-tuning-card .copied { color: #7adfff; font-size: 10px; align-self: center; }
@media (max-width: 760px) {
  #debug-panel { max-height: calc(50vh - 12px); }
  #debug-tuning-card { top: calc(50vh + 4px); left: 8px; max-height: calc(50vh - 12px); }
}
`;

export function isDebugUser(name: string): boolean {
  return name.trim().toLowerCase() === 'jack';
}

let axleEl: HTMLDivElement | null = null;
let telemetryEl: HTMLDivElement | null = null;
const TRACE_LENGTH = 150;
const traceHistory = {
  lateral: [] as number[],
  longitudinal: [] as number[],
  yawDeg: [] as number[],
};
const sparkHistory: Record<string, number[]> = {
  roll: [],
  pitch: [],
  stability: [],
  speed: [],
  rpm: [],
  torque: [],
  grip: [],
  water: [],
  wheel0: [],
  wheel1: [],
  wheel2: [],
  wheel3: [],
};
const SPARK_CONFIG: Record<string, { range: number; signed?: boolean }> = {
  roll: { range: 45, signed: true },
  pitch: { range: 45, signed: true },
  stability: { range: 60 },
  speed: { range: 120 },
  rpm: { range: 6_000 },
  torque: { range: 10_000, signed: true },
  grip: { range: 1 },
  water: { range: 1 },
  wheel0: { range: 1 },
  wheel1: { range: 1 },
  wheel2: { range: 1 },
  wheel3: { range: 1 },
};
let lastTraceAt = 0;
let activeRunId: number | null = null;
let activeRunStartedAt = 0;
let lastRecordAt = 0;
let activeRunSamples = 0;
let runCount = 0;
type RecordedValue = string | number | boolean;
const recordedRows: Array<Record<string, RecordedValue>> = [];

function setRecorderStatus(message?: string): void {
  const el = document.getElementById('debug-record-status');
  if (el) el.textContent = message ?? `${runCount} runs · ${recordedRows.length} samples`;
}

function wireRecorder(panel: HTMLElement): void {
  const record = panel.querySelector<HTMLButtonElement>('#debug-record');
  const exportButton = panel.querySelector<HTMLButtonElement>('#debug-export');
  const clear = panel.querySelector<HTMLButtonElement>('#debug-clear');
  record?.addEventListener('click', () => {
    if (activeRunId !== null) {
      const stoppedRun = activeRunId;
      activeRunId = null;
      record.textContent = 'Start run';
      record.classList.remove('active');
      const rows = recordedRows.filter((row) => row.run === stoppedRun);
      const peakLat = rows.reduce((peak, row) => Math.max(peak, Math.abs(Number(row.lateral_g))), 0);
      const peakYaw = rows.reduce((peak, row) => Math.max(peak, Math.abs(Number(row.yaw_deg_s))), 0);
      const peakGrip = rows.reduce((peak, row) => Math.max(peak, Number(row.max_grip_use)), 0);
      setRecorderStatus(`run ${stoppedRun} saved · ${rows.length} samples · peak ${peakLat.toFixed(2)}g / ${peakYaw.toFixed(0)}°s / ${(peakGrip * 100).toFixed(0)}% grip`);
      return;
    }
    activeRunId = ++runCount;
    activeRunStartedAt = performance.now();
    lastRecordAt = -Infinity;
    activeRunSamples = 0;
    record.textContent = 'Stop run';
    record.classList.add('active');
    setRecorderStatus(`recording run ${activeRunId}…`);
  });
  exportButton?.addEventListener('click', () => exportRecordedCsv());
  clear?.addEventListener('click', () => {
    activeRunId = null;
    runCount = 0;
    recordedRows.length = 0;
    if (record) {
      record.textContent = 'Start run';
      record.classList.remove('active');
    }
    setRecorderStatus();
  });
}

function tuningRecord(): Record<string, RecordedValue> {
  return {
    tune_front_grip: TUNING.frontGripMult,
    tune_rear_grip: TUNING.rearGripMult,
    tune_long_grip_mult: TUNING.tireLongGripMult,
    tune_edge_wrap_mult: TUNING.tireEdgeWrapMult,
    tune_carcass_compliance: TUNING.tireCarcassComplianceMult,
    tune_radial_damping: TUNING.tireRadialDampingMult,
    tune_sidewall_correction: TUNING.tireSidewallCorrectionMult,
    tune_sidewall_friction: TUNING.tireSidewallFrictionMult,
    tune_visual_bagging: TUNING.tireVisualDeformationMult,
    tune_shoulder_bulge: TUNING.tireShoulderBulgeMult,
    tune_lateral_grip_ratio: TUNING.tireLateralGripRatio,
    tune_lat_stiffness: TUNING.tireLatStiffness,
    tune_slip_peak_deg: TUNING.tireSlipAnglePeak * 180 / Math.PI,
    tune_slip_falloff: TUNING.tireSlipAngleFalloff,
    tune_slide_grip_floor: TUNING.tireSlipAngleFloor,
    tune_front_spring: TUNING.axleFront.rideStiffnessMult,
    tune_front_damping: TUNING.axleFront.rideDampingMult,
    tune_front_roll_constraint: TUNING.axleFront.rollStiffnessMult,
    tune_front_articulation: TUNING.axleFront.maxArticulationMult,
    tune_rear_spring: TUNING.axleRear.rideStiffnessMult,
    tune_rear_damping: TUNING.axleRear.rideDampingMult,
    tune_rear_roll_constraint: TUNING.axleRear.rollStiffnessMult,
    tune_rear_articulation: TUNING.axleRear.maxArticulationMult,
    tune_anti_roll_stiffness: TUNING.antiRollStiffnessMult,
    tune_anti_roll_damping: TUNING.antiRollDampingMult,
    tune_anti_roll_front_share: TUNING.antiRollFrontShare,
    tune_surface_road: TUNING.surfaceFriction.road,
    tune_surface_dirt: TUNING.surfaceFriction.dirt,
    tune_surface_mud: TUNING.surfaceFriction.mud,
    tune_surface_deep_mud: TUNING.surfaceFriction.deepMud,
    tune_surface_grass: TUNING.surfaceFriction.grass,
    tune_surface_gravel: TUNING.surfaceFriction.gravel,
    tune_surface_concrete: TUNING.surfaceFriction.concrete,
    tune_rolling_resistance: TUNING.rollingResistanceMult,
    tune_mud_rolling: TUNING.rollingResistanceMudMult,
    tune_deep_mud_rolling: TUNING.rollingResistanceDeepMudMult,
    tune_brake_force: TUNING.brakeForce,
    tune_engine_torque: TUNING.engineTorqueMult,
    tune_engine_brake: TUNING.engineBrakeMult,
    tune_max_steer: TUNING.maxSteer,
    tune_steer_speed: TUNING.steerSpeed,
    tune_steer_limit_g: TUNING.maxSteerLateralAccel / 9.81,
    tune_water_buoyancy: TUNING.waterBuoyancy,
    tune_water_drag: TUNING.waterDrag,
    tune_water_flow: TUNING.waterFlowScale,
  };
}

function recordTelemetry(telemetry: Physics.VehicleDebugTelemetry, now: number): void {
  if (activeRunId === null || now - lastRecordAt < 50) return;
  lastRecordAt = now;
  const speed = Math.hypot(telemetry.linearVelocity.x, telemetry.linearVelocity.y, telemetry.linearVelocity.z);
  const loads = telemetry.wheels.map((wheel) => wheel.normalLoad);
  const totalLoad = loads.reduce((sum, load) => sum + load, 0);
  const rollBias = totalLoad > 1
    ? Math.abs((loads[1]! + loads[3]!) - (loads[0]! + loads[2]!)) / totalLoad
    : 1;
  const pitchBias = totalLoad > 1
    ? Math.abs((loads[0]! + loads[1]!) - (loads[2]! + loads[3]!)) / totalLoad
    : 1;
  const row: Record<string, RecordedValue> = {
    run: activeRunId,
    time_s: (now - activeRunStartedAt) / 1000,
    x: telemetry.position.x,
    y: telemetry.position.y,
    z: telemetry.position.z,
    speed_mps: speed,
    roll_deg: telemetry.rollAngle * 180 / Math.PI,
    pitch_deg: telemetry.pitchAngle * 180 / Math.PI,
    lateral_g: telemetry.lateralG,
    longitudinal_g: telemetry.longitudinalG,
    yaw_deg_s: telemetry.yawRate * 180 / Math.PI,
    roll_limit_deg: telemetry.staticRollLimit * 180 / Math.PI,
    pitch_limit_deg: telemetry.staticPitchLimit * 180 / Math.PI,
    load_reserve: Math.max(0, 1 - Math.max(rollBias, pitchBias)),
    contact_count: telemetry.wheels.filter((wheel) => wheel.contact).length,
    max_grip_use: Math.max(...telemetry.wheels.map((wheel) => wheel.utilization)),
    rpm: telemetry.driveline.rpm,
    gear: telemetry.driveline.gear,
    transfer_case: telemetry.driveline.transferCase,
    front_locked: telemetry.driveline.frontLocked,
    rear_locked: telemetry.driveline.rearLocked,
    submerged: telemetry.water.submerged,
    buoyancy_n: telemetry.water.buoyancyForce.y,
    drag_n: Math.hypot(telemetry.water.dragForce.x, telemetry.water.dragForce.y, telemetry.water.dragForce.z),
    ...tuningRecord(),
  };
  const names = ['fl', 'fr', 'rl', 'rr'];
  telemetry.wheels.forEach((wheel, index) => {
    const prefix = names[index]!;
    row[`${prefix}_contact`] = wheel.contact;
    row[`${prefix}_load_n`] = wheel.normalLoad;
    row[`${prefix}_grip_use`] = wheel.utilization;
    row[`${prefix}_slip_ratio`] = wheel.slipRatio;
    row[`${prefix}_slip_angle_deg`] = wheel.slipAngle * 180 / Math.PI;
    row[`${prefix}_suspension_m`] = wheel.suspensionCompression;
    row[`${prefix}_wheel_rpm`] = wheel.angularVelocity * 60 / (Math.PI * 2);
    row[`${prefix}_drive_nm`] = wheel.driveTorque;
    row[`${prefix}_ground_nm`] = wheel.groundTorque;
  });
  recordedRows.push(row);
  activeRunSamples++;
  setRecorderStatus(`recording run ${activeRunId} · ${activeRunSamples} samples`);
}

function csvCell(value: RecordedValue): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportRecordedCsv(): void {
  if (recordedRows.length === 0) {
    setRecorderStatus('nothing recorded yet');
    return;
  }
  const headers = Object.keys(recordedRows[0]!);
  const csv = [headers.join(','), ...recordedRows.map((row) => headers.map((key) => csvCell(row[key] ?? '')).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `mydrunner-tuning-runs-${new Date().toISOString().replaceAll(':', '-')}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
  setRecorderStatus(`exported ${runCount} runs · ${recordedRows.length} samples`);
}

function tracePoints(values: readonly number[], range: number): string {
  if (values.length === 0) return '';
  return values.map((value, index) => {
    const x = values.length === 1 ? 300 : index / (values.length - 1) * 300;
    const y = 40 - Math.max(-1, Math.min(1, value / range)) * 34;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function sparkPoints(values: readonly number[], range: number, signed = false): string {
  if (values.length === 0) return '';
  return values.map((value, index) => {
    const x = values.length === 1 ? 100 : index / (values.length - 1) * 100;
    const normalized = signed
      ? Math.max(-1, Math.min(1, value / range))
      : Math.max(0, Math.min(1, value / range));
    const y = signed ? 11 - normalized * 9 : 20 - normalized * 18;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function miniTrace(name: string, color: string, label: string, signed = false): string {
  const baseline = signed ? 11 : 20;
  return `<svg class="mini-trace" viewBox="0 0 100 22" preserveAspectRatio="none" aria-label="${label}">
    <line x1="0" y1="${baseline}" x2="100" y2="${baseline}"/>
    <polyline data-mini="${name}" stroke="${color}" points=""/>
  </svg>`;
}

function updateDynamicsTrace(telemetry: Physics.VehicleDebugTelemetry): void {
  const now = performance.now();
  recordTelemetry(telemetry, now);
  if (now - lastTraceAt < 33) return;
  lastTraceAt = now;
  traceHistory.lateral.push(telemetry.lateralG);
  traceHistory.longitudinal.push(telemetry.longitudinalG);
  traceHistory.yawDeg.push(telemetry.yawRate * 180 / Math.PI);
  const degrees = 180 / Math.PI;
  const speedKmh = Math.hypot(
    telemetry.linearVelocity.x,
    telemetry.linearVelocity.y,
    telemetry.linearVelocity.z,
  ) * 3.6;
  const maxGrip = Math.max(...telemetry.wheels.map((wheel) => wheel.utilization));
  sparkHistory.roll!.push(telemetry.rollAngle * degrees);
  sparkHistory.pitch!.push(telemetry.pitchAngle * degrees);
  sparkHistory.stability!.push(Math.min(telemetry.staticRollLimit, telemetry.staticPitchLimit) * degrees);
  sparkHistory.speed!.push(speedKmh);
  sparkHistory.rpm!.push(telemetry.driveline.rpm);
  sparkHistory.torque!.push(telemetry.driveline.outputTorque);
  sparkHistory.grip!.push(maxGrip);
  sparkHistory.water!.push(telemetry.water.submerged);
  telemetry.wheels.forEach((wheel, index) => sparkHistory[`wheel${index}`]!.push(wheel.utilization));
  for (const values of Object.values(traceHistory)) {
    if (values.length > TRACE_LENGTH) values.splice(0, values.length - TRACE_LENGTH);
  }
  for (const values of Object.values(sparkHistory)) {
    if (values.length > TRACE_LENGTH) values.splice(0, values.length - TRACE_LENGTH);
  }
  const paths: Array<[string, readonly number[], number]> = [
    ['lat', traceHistory.lateral, 1.2],
    ['long', traceHistory.longitudinal, 1.2],
    ['yaw', traceHistory.yawDeg, 90],
  ];
  for (const [name, values, range] of paths) {
    telemetryEl?.querySelector(`[data-trace="${name}"]`)?.setAttribute('points', tracePoints(values, range));
  }
  for (const [name, values] of Object.entries(sparkHistory)) {
    const config = SPARK_CONFIG[name]!;
    telemetryEl?.querySelector(`[data-mini="${name}"]`)
      ?.setAttribute('points', sparkPoints(values, config.range, config.signed));
  }
}

const HELP_DEFAULT = 'Hover or focus anything in the lab for an explanation.';

function applyDebugHelp(panel: HTMLElement): void {
  const set = (selector: string, description: string): void => {
    for (const element of panel.querySelectorAll<HTMLElement>(selector)) {
      element.dataset.help = description;
      element.title = description;
    }
  };
  const tuningCard = panel.id === 'debug-tuning-card';
  set('h2', tuningCard
    ? 'Live handling controls used immediately by the locally owned vehicle physics.'
    : 'Live instrumentation from the locally owned physics simulation. Nothing in this panel is sent over multiplayer snapshots.');
  set('.debug-subtitle', tuningCard
    ? 'Grouped runtime controls; defaults match the shipped constants until a slider moves.'
    : 'These values come directly from the latest fixed physics step, while the vehicle itself is rendered with interpolation.');
  set('[data-debug="roll"]', 'Chassis roll around its forward axis. Positive and negative indicate opposite lean directions.');
  set('[data-debug="pitch"]', 'Chassis pitch relative to the world horizon. Positive is nose-up and negative is nose-down.');
  set('[data-debug="limit"]', 'Estimated static rollover angle from the current CoG height and track width. Momentum and uneven contacts can tip earlier.');
  set('[data-debug="speed"]', 'Current three-dimensional chassis speed in kilometres per hour, with a short recent history.');
  set('[data-debug="rpm"]', 'Current engine speed and its recent history. Compare the shape with shifts and driveline torque.');
  set('[data-debug="max-grip"]', 'Highest friction-budget utilization across the four tires. Sustained 100% means at least one tire is saturated.');
  set('[data-debug="tip-state"]', 'Combines wheel contact count, left/right and front/rear load transfer, and remaining static angle margin into a tipping warning.');
  set('.trace', 'Rolling history: lateral G in cyan, longitudinal G in orange, and yaw rate in purple. The centre line is zero.');
  set('.mini-trace', 'Compact recent history for the value in this card. New samples enter on the right at roughly 30 Hz.');
  set('[data-debug="lat-g"]', 'Acceleration across the vehicle from left to right, expressed as a fraction of gravity.');
  set('[data-debug="long-g"]', 'Acceleration along the vehicle forward axis, expressed as a fraction of gravity.');
  set('[data-debug="yaw"]', 'Rotation rate around the vehicle up axis in degrees per second. Useful for steering-response and oversteer tuning.');
  set('[data-debug="drive-head"]', 'Engine speed and selected ratio feeding the driveline, followed by the available torque pool and differential states.');
  set('[data-debug="water-load"]', 'Mean hull submersion plus the resultant buoyancy, translational drag, and angular drag currently applied by water.');
  set('#debug-record', 'Start or stop a comparison run. Samples are captured at 20 Hz and multiple runs remain together until Clear is pressed.');
  set('#debug-export', 'Download every recorded run as CSV, including motion, tire, suspension, driveline, water, tipping, and live tuning columns.');
  set('#debug-clear', 'Discard all recorded tuning runs from memory. This does not reset any live tuning sliders.');
  set('#debug-record-status', 'Recorder state and the peak lateral G, yaw rate, and tire grip usage from the most recently completed run.');
  set('#debug-axles', 'The two solid-axle visual degrees of freedom: average vertical ride position and beam roll angle.');
  set('#debug-axle-front', 'Front axle average ride displacement and articulation angle from its left/right support depths.');
  set('#debug-axle-rear', 'Rear axle average ride displacement and articulation angle from its left/right support depths.');
  set('summary', 'Expand or collapse the sliders that mutate the local TUNING object immediately.');
  set('.actions button', 'Copy the current live values as a TypeScript constants snippet for baking the tune into the project defaults.');
  set('.copied', 'Reports whether the current tuning constants were copied to the clipboard successfully.');
  set('.legend', 'Colour key for the world-space physics overlay drawn around the local vehicle.');

  const wheelNames = ['front-left', 'front-right', 'rear-left', 'rear-right'];
  panel.querySelectorAll<HTMLElement>('[data-wheel]').forEach((card, index) => {
    const description = `${wheelNames[index] ?? 'Wheel'} friction circle: surface and water, normal load, effective friction, budget use, slip ratio/angle, and suspension compression.`;
    card.dataset.help = description;
    card.title = description;
  });
  panel.querySelectorAll<HTMLElement>('[data-drive-wheel]').forEach((value, index) => {
    const node = value.closest<HTMLElement>('.drive-node') ?? value;
    const description = `${wheelNames[index] ?? 'Wheel'} driveline state: wheel speed plus applied drive, ground-reaction, and brake torque in Nm.`;
    node.dataset.help = description;
    node.title = description;
  });
  for (const metric of panel.querySelectorAll<HTMLElement>('.metric')) {
    const child = metric.querySelector<HTMLElement>('[data-help]');
    if (child?.dataset.help) {
      metric.dataset.help = child.dataset.help;
      metric.title = child.dataset.help;
    }
  }
  const sectionHelp: Record<string, string> = {
    'ATTITUDE + TIP RESERVE': 'Vehicle orientation, estimated static stability limits, and live load-transfer warning.',
    'VEHICLE VITALS': 'Speed, engine RPM, and the most heavily loaded tire friction budget, each with a short history.',
    'TIRE FRICTION CIRCLES': 'Per-contact grip demand versus the combined longitudinal/lateral force each tire can transmit.',
    'G-FORCE + YAW HISTORY': 'Short rolling traces for transient handling response while you drive and change settings.',
    'DRIVELINE TORQUE FLOW': 'Torque and wheel-speed observability from engine and transfer case through each contact patch.',
    'TUNING RUN RECORDER': 'Capture repeatable passes with their exact tuning values, then compare them in a spreadsheet.',
  };
  for (const heading of panel.querySelectorAll<HTMLElement>('.section-title')) {
    const description = sectionHelp[heading.textContent?.trim() ?? ''];
    if (!description) continue;
    heading.dataset.help = description;
    heading.title = description;
  }

  const help = panel.querySelector<HTMLElement>('.debug-help');
  const showHelp = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-help]');
    if (target?.dataset.help && help) help.textContent = target.dataset.help;
  };
  const resetHelp = (): void => { if (help) help.textContent = HELP_DEFAULT; };
  panel.addEventListener('pointerover', showHelp);
  panel.addEventListener('focusin', showHelp);
  panel.addEventListener('pointerleave', resetHelp);
  panel.addEventListener('focusout', resetHelp);
}

export function initDebugPanel(): void {
  if (document.getElementById('debug-panel')) return;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.innerHTML = `
    <h2>PHYSICS LAB</h2>
    <div class="debug-subtitle">owner physics · live values · ?dev</div>
    <div class="debug-help" id="debug-help" role="status">Hover or focus anything in the lab for an explanation.</div>
    <div id="debug-telemetry">
      <div class="section-title">ATTITUDE + TIP RESERVE</div>
      <div class="attitude">
        <div class="metric"><small>ROLL</small><strong data-debug="roll">--</strong>${miniTrace('roll', '#55e9ff', 'roll angle history', true)}</div>
        <div class="metric"><small>PITCH</small><strong data-debug="pitch">--</strong>${miniTrace('pitch', '#ffb84d', 'pitch angle history', true)}</div>
        <div class="metric"><small>STATIC LIMIT</small><strong data-debug="limit">--</strong>${miniTrace('stability', '#45e68a', 'static stability limit history')}</div>
      </div>
      <div class="tip-state" data-debug="tip-state">waiting for support contacts…</div>
      <div class="section-title">VEHICLE VITALS</div>
      <div class="attitude">
        <div class="metric"><small>SPEED</small><strong data-debug="speed">--</strong>${miniTrace('speed', '#55e9ff', 'vehicle speed history')}</div>
        <div class="metric"><small>ENGINE</small><strong data-debug="rpm">--</strong>${miniTrace('rpm', '#e5b85c', 'engine rpm history')}</div>
        <div class="metric"><small>MAX GRIP</small><strong data-debug="max-grip">--</strong>${miniTrace('grip', '#ffd34e', 'maximum tire grip use history')}</div>
      </div>
      <div class="section-title">TIRE FRICTION CIRCLES</div>
      <div class="tires">
        ${['FL', 'FR', 'RL', 'RR'].map((name, index) => `
          <div class="tire" data-wheel="${index}">
            <div class="tire-head"><strong>${name}</strong><span data-field="surface">air</span></div>
            <div class="traction-bar"><i data-field="bar"></i></div>
            <div class="tire-data" data-field="data">no contact</div>
            ${miniTrace(`wheel${index}`, '#45e68a', `${name} grip utilization history`)}
          </div>`).join('')}
      </div>
      <div class="section-title">G-FORCE + YAW HISTORY</div>
      <svg class="trace" viewBox="0 0 300 80" preserveAspectRatio="none" aria-label="G-force and yaw history">
        <line class="trace-grid" x1="0" y1="20" x2="300" y2="20"/><line class="trace-zero" x1="0" y1="40" x2="300" y2="40"/><line class="trace-grid" x1="0" y1="60" x2="300" y2="60"/>
        <polyline data-trace="lat" stroke="#55e9ff" points=""/><polyline data-trace="long" stroke="#ffb84d" points=""/><polyline data-trace="yaw" stroke="#d26cff" points=""/>
      </svg>
      <div class="trace-legend"><b style="color:#55e9ff">LAT <span data-debug="lat-g">0.00g</span></b><b style="color:#ffb84d">LONG <span data-debug="long-g">0.00g</span></b><b style="color:#d26cff">YAW <span data-debug="yaw">0°/s</span></b></div>
      <div class="section-title">DRIVELINE TORQUE FLOW</div>
      <div class="driveline">
        <div class="drive-node"><strong>ENGINE → CASE</strong><div data-debug="drive-head">--</div>${miniTrace('torque', '#e5b85c', 'driveline output torque history', true)}</div>
        <div class="drive-node"><strong>WATER LOAD</strong><div data-debug="water-load">dry</div>${miniTrace('water', '#4d9dff', 'hull submersion history')}</div>
        ${['FL', 'FR', 'RL', 'RR'].map((name, index) => `<div class="drive-node"><strong>${name}</strong><div data-drive-wheel="${index}">--</div></div>`).join('')}
      </div>
      <div class="legend">WORLD: yellow CoG · green/red gravity projection · cyan support polygon · purple/red suspension casts · tire arrows green→red · blue buoyancy · magenta water drag</div>
      <div class="recording">
        <div class="section-title">TUNING RUN RECORDER</div>
        <div class="record-actions"><button id="debug-record" type="button">Start run</button><button id="debug-export" type="button">Export CSV</button><button id="debug-clear" type="button">Clear</button></div>
        <div class="record-status" id="debug-record-status">0 runs · 0 samples</div>
      </div>
    </div>`;
  document.body.appendChild(panel);
  telemetryEl = panel.querySelector<HTMLDivElement>('#debug-telemetry');
  wireRecorder(panel);

  // Live axle readout section.
  const axleSection = document.createElement('div');
  axleSection.id = 'debug-axles';
  axleSection.style.cssText =
    'margin-top:8px;padding-top:7px;border-top:1px solid #2a323d;font-size:9px;color:#7adfff;';
  axleSection.innerHTML =
    '<div style="color:#d9531e;margin-bottom:4px">AXLE STATE</div>' +
    '<div id="debug-axle-front">front: --</div>' +
    '<div id="debug-axle-rear">rear: --</div>';
  panel.appendChild(axleSection);
  axleEl = axleSection;

  const tuningCard = document.createElement('div');
  tuningCard.id = 'debug-tuning-card';
  tuningCard.innerHTML = `
    <h2>LIVE TUNING</h2>
    <div class="debug-subtitle">runtime handling controls · local owner physics</div>
    <div class="debug-help" id="debug-tuning-help" role="status">Hover or focus anything in the lab for an explanation.</div>`;
  document.body.appendChild(tuningCard);

  const tuning = document.createElement('details');
  tuning.open = true;
  const tuningSummary = document.createElement('summary');
  tuningSummary.textContent = 'CONTROLS';
  tuning.appendChild(tuningSummary);
  tuningCard.appendChild(tuning);

  const valueEls = new Map<string, HTMLSpanElement>();

  for (const s of SLIDERS) {
    if (s.group) {
      const group = document.createElement('div');
      group.className = 'tuning-group';
      group.textContent = s.group;
      group.dataset.help = TUNING_GROUP_HELP[s.group];
      group.title = TUNING_GROUP_HELP[s.group];
      tuning.appendChild(group);
    }
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.help = s.description;
    row.title = s.description;
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
    tuning.appendChild(row);
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
  tuning.appendChild(actions);
  applyDebugHelp(panel);
  applyDebugHelp(tuningCard);
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
export const TIRE_LONG_FRICTION = ${f(TIRE_LONG_FRICTION * t.tireLongGripMult)}; // x${f(t.tireLongGripMult, 2)}
// TIRE_CARCASS live multipliers:
//   pressure edge wrap            x${f(t.tireEdgeWrapMult, 2)}
//   static deflection / compliance x${f(t.tireCarcassComplianceMult, 2)}
//   radial damping               x${f(t.tireRadialDampingMult, 2)}
//   sidewall correction          x${f(t.tireSidewallCorrectionMult, 2)}
//   sidewall friction            x${f(t.tireSidewallFrictionMult, 2)}
// Render-only tyre deformation:
//   visual bagging x${f(t.tireVisualDeformationMult, 2)}, shoulder bulge x${f(t.tireShoulderBulgeMult, 2)}
// TIRE_LATERAL.*:
//   stiffness: ${f(t.tireLatStiffness, 0)},
//   longRatio: ${f(t.tireLateralGripRatio)},
//   slipAnglePeak: ${f(t.tireSlipAnglePeak)}, // ${(t.tireSlipAnglePeak * 180 / Math.PI).toFixed(2)} deg
//   slipAngleFalloff: ${f(t.tireSlipAngleFalloff)},
//   slipAngleFloor: ${f(t.tireSlipAngleFloor)},
// ANTI_ROLL.*:
//   torqueStiffness: ${f(ANTI_ROLL.torqueStiffness * t.antiRollStiffnessMult, 0)}, // x${f(t.antiRollStiffnessMult, 2)}
//   torqueDamping: ${f(ANTI_ROLL.torqueDamping * t.antiRollDampingMult, 0)}, // x${f(t.antiRollDampingMult, 2)}
//   frontShare: ${f(t.antiRollFrontShare)},
//   rearShare: ${f(1 - t.antiRollFrontShare)},
// WHEEL.* rolling resistance:
//   rollingResistance: ${f(WHEEL.rollingResistance * t.rollingResistanceMult)}, // x${f(t.rollingResistanceMult, 2)}
//   rollingMultMud: ${f(t.rollingResistanceMudMult)},
//   rollingMultDeepMud: ${f(t.rollingResistanceDeepMudMult)},
// ENGINE.*:
//   peakTorqueNm: ${f(ENGINE.peakTorqueNm * t.engineTorqueMult, 0)}, // x${f(t.engineTorqueMult, 2)}
//   engineBrakeCoef: ${f(ENGINE.engineBrakeCoef * t.engineBrakeMult)}, // x${f(t.engineBrakeMult, 2)}
//   engineBrakeSpeedCoef: ${f(ENGINE.engineBrakeSpeedCoef * t.engineBrakeMult)},
// VEHICLE.* (drive feel):
//   brakeForce: ${f(t.brakeForce, 0)},
//   maxSteer: ${f(t.maxSteer, 2)},
//   steerSpeed: ${f(t.steerSpeed, 2)},
//   maxSteerLateralAccel: ${f(t.maxSteerLateralAccel)}, // ${(t.maxSteerLateralAccel / 9.81).toFixed(2)} g
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

/** Update the tire/attitude dashboard from the exact quantities consumed by
 * the latest owner-physics step. */
export function updateVehicleDebug(telemetry: Physics.VehicleDebugTelemetry): void {
  if (!telemetryEl) return;
  updateDynamicsTrace(telemetry);
  const degrees = 180 / Math.PI;
  const roll = telemetry.rollAngle * degrees;
  const pitch = telemetry.pitchAngle * degrees;
  const rollLimit = telemetry.staticRollLimit * degrees;
  const pitchLimit = telemetry.staticPitchLimit * degrees;
  const speedKmh = Math.hypot(
    telemetry.linearVelocity.x,
    telemetry.linearVelocity.y,
    telemetry.linearVelocity.z,
  ) * 3.6;
  const maxGrip = Math.max(...telemetry.wheels.map((wheel) => wheel.utilization));
  const setText = (key: string, value: string): void => {
    const el = telemetryEl?.querySelector<HTMLElement>(`[data-debug="${key}"]`);
    if (el) el.textContent = value;
  };
  setText('roll', `${roll >= 0 ? '+' : ''}${roll.toFixed(1)}°`);
  setText('pitch', `${pitch >= 0 ? '+' : ''}${pitch.toFixed(1)}°`);
  setText('limit', `${rollLimit.toFixed(1)}° R`);
  setText('speed', `${speedKmh.toFixed(1)} km/h`);
  setText('rpm', `${telemetry.driveline.rpm.toFixed(0)} rpm`);
  setText('max-grip', `${(maxGrip * 100).toFixed(0)}%`);
  setText('lat-g', `${telemetry.lateralG >= 0 ? '+' : ''}${telemetry.lateralG.toFixed(2)}g`);
  setText('long-g', `${telemetry.longitudinalG >= 0 ? '+' : ''}${telemetry.longitudinalG.toFixed(2)}g`);
  setText('yaw', `${telemetry.yawRate >= 0 ? '+' : ''}${(telemetry.yawRate * degrees).toFixed(0)}°/s`);
  const gear = telemetry.driveline.gear < 0 ? 'R' : telemetry.driveline.gear === 0 ? 'N' : String(telemetry.driveline.gear);
  const driveHead = telemetryEl.querySelector<HTMLElement>('[data-debug="drive-head"]');
  if (driveHead) {
    driveHead.textContent = `${telemetry.driveline.rpm.toFixed(0)} rpm · gear ${gear} · ${telemetry.driveline.transferCase.toUpperCase()}\n`
      + `pool ${telemetry.driveline.outputTorque.toFixed(0)} Nm · F ${telemetry.driveline.frontLocked ? 'LOCK' : 'open'} / R ${telemetry.driveline.rearLocked ? 'LOCK' : 'open'}`;
  }
  const waterLoad = telemetryEl.querySelector<HTMLElement>('[data-debug="water-load"]');
  if (waterLoad) {
    const buoyancy = telemetry.water.buoyancyForce.y;
    const drag = Math.hypot(telemetry.water.dragForce.x, telemetry.water.dragForce.y, telemetry.water.dragForce.z);
    const dragTorque = Math.hypot(telemetry.water.dragTorque.x, telemetry.water.dragTorque.y, telemetry.water.dragTorque.z);
    waterLoad.textContent = telemetry.water.submerged > 0.001
      ? `${(telemetry.water.submerged * 100).toFixed(0)}% hull · buoy ${(buoyancy / 1000).toFixed(1)} kN\n drag ${(drag / 1000).toFixed(1)} kN · ${(dragTorque / 1000).toFixed(1)} kNm`
      : 'dry · no buoyancy / drag';
  }

  const loads = telemetry.wheels.map((wheel) => wheel.normalLoad);
  const totalLoad = loads.reduce((sum, load) => sum + load, 0);
  const leftLoad = loads[0]! + loads[2]!;
  const rightLoad = loads[1]! + loads[3]!;
  const frontLoad = loads[0]! + loads[1]!;
  const rearLoad = loads[2]! + loads[3]!;
  const rollBias = totalLoad > 1 ? Math.abs(rightLoad - leftLoad) / totalLoad : 1;
  const pitchBias = totalLoad > 1 ? Math.abs(frontLoad - rearLoad) / totalLoad : 1;
  const loadReserve = Math.max(0, 1 - Math.max(rollBias, pitchBias));
  const rollMargin = rollLimit - Math.abs(roll);
  const pitchMargin = pitchLimit - Math.abs(pitch);
  const contactCount = telemetry.wheels.filter((wheel) => wheel.contact).length;
  const tip = telemetryEl.querySelector<HTMLElement>('[data-debug="tip-state"]');
  if (tip) {
    const margin = Math.min(rollMargin, pitchMargin);
    const danger = contactCount < 3 || margin < 2 || loadReserve < 0.12;
    const warn = !danger && (margin < 8 || loadReserve < 0.3);
    tip.className = `tip-state${danger ? ' danger' : warn ? ' warn' : ''}`;
    tip.textContent = `${danger ? 'TIP EDGE' : warn ? 'LOW RESERVE' : 'STABLE'} · `
      + `${contactCount}/4 contact · load reserve ${(loadReserve * 100).toFixed(0)}% · `
      + `angle margin ${Math.max(-99, margin).toFixed(1)}° (pitch limit ${pitchLimit.toFixed(1)}°)`;
  }

  for (let index = 0; index < 4; index++) {
    const wheel = telemetry.wheels[index]!;
    const card = telemetryEl.querySelector<HTMLElement>(`[data-wheel="${index}"]`);
    if (!card) continue;
    const surface = card.querySelector<HTMLElement>('[data-field="surface"]');
    const bar = card.querySelector<HTMLElement>('[data-field="bar"]');
    const data = card.querySelector<HTMLElement>('[data-field="data"]');
    if (surface) {
      const water = wheel.waterDepth > 0.02 ? ` + ${wheel.waterDepth.toFixed(2)}m water` : '';
      surface.textContent = wheel.contact ? `${Physics.surfaceInfo(wheel.surface).label}${water}` : 'air';
    }
    if (bar) {
      const percent = Math.max(0, Math.min(100, wheel.utilization * 100));
      bar.style.width = `${percent.toFixed(1)}%`;
      const gripColor = percent > 92 ? '#ff4f45' : percent > 68 ? '#ffd34e' : '#45e68a';
      bar.style.background = gripColor;
      card.querySelector(`[data-mini="wheel${index}"]`)?.setAttribute('stroke', gripColor);
    }
    if (data) {
      const travel = wheel.suspensionRestLength > 0
        ? Math.min(999, wheel.suspensionCompression / wheel.suspensionRestLength * 100)
        : 0;
      data.textContent = wheel.contact
        ? `${(wheel.normalLoad / 1000).toFixed(1)}kN · μ${wheel.gripCoefficient.toFixed(2)} · use ${(wheel.utilization * 100).toFixed(0)}%\n`
          + `${wheel.contactZone} ${(wheel.treadFraction * 100).toFixed(0)}% tread · axis ${(wheel.suspensionAxisAlignment * 100).toFixed(0)}%\n`
          + `slip ${(wheel.slipRatio * 100).toFixed(0)}% / ${(wheel.slipAngle * degrees).toFixed(1)}° · susp ${(wheel.suspensionCompression * 1000).toFixed(0)}mm (${travel.toFixed(0)}%) · tyre ${(wheel.carcassDeflection * 1000).toFixed(0)}mm\n`
          + `forces susp ${(wheel.suspensionForce / 1000).toFixed(1)} / carcass ${(wheel.carcassForce / 1000).toFixed(1)}kN`
        : `${wheel.contactZone} · no tread contact · susp ${(wheel.suspensionCompression * 1000).toFixed(0)}mm (${travel.toFixed(0)}%) · tyre ${(wheel.carcassDeflection * 1000).toFixed(0)}mm`;
      data.style.whiteSpace = 'pre-line';
    }
    const driveWheel = telemetryEl.querySelector<HTMLElement>(`[data-drive-wheel="${index}"]`);
    if (driveWheel) {
      const wheelRpm = wheel.angularVelocity * 60 / (Math.PI * 2);
      driveWheel.textContent = `${wheelRpm.toFixed(0)} wheel rpm\n`
        + `drive ${wheel.driveTorque.toFixed(0)} · ground ${wheel.groundTorque.toFixed(0)} Nm\n`
        + `brake ${wheel.brakeTorque.toFixed(0)} Nm`;
    }
  }
}
