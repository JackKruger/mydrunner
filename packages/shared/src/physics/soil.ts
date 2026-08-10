/** Physical soft-ground helpers for mud and deep mud. */

export type SoilKind = 'none' | 'mud' | 'deep-mud';

export interface SoftGroundState {
  sinkDepth: number;
  slipDisplacement: number;
  soilCompaction: number;
  bulldozingResistance: number;
  slipWork: number;
}

export interface SoftGroundStepResult {
  contactArea: number;
  shearMultiplier: number;
  bulldozingForce: number;
  targetSinkDepth: number;
}

const PSI_TO_PA = 6_894.757;

export function estimateContactArea(
  normalLoad: number,
  pressurePsi: number,
  tyreWidth: number,
  tyreRadius: number,
): number {
  if (normalLoad <= 0) return 0;
  const ideal = normalLoad / (Math.max(1, pressurePsi) * PSI_TO_PA);
  const minimum = Math.max(0.001, tyreWidth * 0.04);
  const maximum = Math.max(minimum, tyreWidth * tyreRadius * 0.9);
  return clamp(ideal, minimum, maximum);
}

export function stepSoftGround(
  state: SoftGroundState,
  kind: SoilKind,
  normalLoad: number,
  pressurePsi: number,
  tyreWidth: number,
  tyreRadius: number,
  longitudinalSlipSpeed: number,
  longitudinalSpeed: number,
  dt: number,
  out: SoftGroundStepResult = {
    contactArea: 0,
    shearMultiplier: 1,
    bulldozingForce: 0,
    targetSinkDepth: 0,
  },
): SoftGroundStepResult {
  const step = Math.max(0, dt);
  if (kind === 'none' || normalLoad <= 0) {
    state.slipDisplacement = 0;
    state.soilCompaction = 0;
    state.bulldozingResistance = 0;
    state.slipWork = 0;
    state.sinkDepth = moveToward(state.sinkDepth, 0, 0.30 * step);
    out.contactArea = 0;
    out.shearMultiplier = 1;
    out.bulldozingForce = 0;
    out.targetSinkDepth = 0;
    return out;
  }

  const maxSink = kind === 'deep-mud' ? 0.38 : 0.18;
  const bearingStrength = kind === 'deep-mud' ? 28_000 : 55_000;
  const area = estimateContactArea(normalLoad, pressurePsi, tyreWidth, tyreRadius);
  const groundPressure = normalLoad / Math.max(1e-4, area);
  // Disturbance is work over real relative patch travel. Using a slip-ratio
  // denominator floor here would let harmless near-rest wheel jitter dig a
  // stationary tyre and could make a softer tyre sink more for no reason.
  const slipSpeed = Math.abs(longitudinalSlipSpeed);
  const slipIncrement = slipSpeed * step;
  state.slipDisplacement += slipIncrement;
  state.slipWork += normalLoad * slipIncrement;
  state.soilCompaction = clamp(state.soilCompaction + slipIncrement * 0.22 - step * 0.015, 0, 1);

  const equilibrium = maxSink * 0.62
    * clamp((groundPressure / bearingStrength - 0.25) / 4, 0, 1);
  const workScale = Math.max(1, normalLoad * (kind === 'deep-mud' ? 1.8 : 2.8));
  const digging = maxSink * 0.55 * (1 - Math.exp(-state.slipWork / workScale));
  const targetSinkDepth = clamp(equilibrium + digging, 0, maxSink);
  state.sinkDepth = moveToward(state.sinkDepth, targetSinkDepth, 0.12 * step);

  const shearBuild = 1 - Math.exp(-state.slipDisplacement / (kind === 'deep-mud' ? 0.20 : 0.14));
  // Soil shear rises to its peak as the lugs engage, then falls once excess
  // tread speed remoulds the same patch into slurry. Without this tail the
  // model rewarded sustained wheelspin with its highest shear coefficient.
  const excessSlipPenalty = 1 / (1 + Math.max(0, slipSpeed - 1.5) * 0.10);
  const footprintGain = clamp(
    Math.sqrt(area / Math.max(0.001, tyreWidth * 0.04)),
    1,
    1.5,
  );
  const shearMultiplier = clamp(
    (0.32 + shearBuild * 0.58 + state.soilCompaction * 0.10)
      * excessSlipPenalty * footprintGain,
    0.25,
    1,
  );
  const coefficient = kind === 'deep-mud' ? 150_000 : 95_000;
  const bulldozingForce = tyreWidth * state.sinkDepth * state.sinkDepth
    * coefficient * (
      1
      + Math.abs(longitudinalSpeed) * 0.55
      + Math.min(3, slipSpeed * 0.35)
    );
  state.bulldozingResistance = bulldozingForce;

  out.contactArea = area;
  out.shearMultiplier = shearMultiplier;
  out.bulldozingForce = bulldozingForce;
  out.targetSinkDepth = targetSinkDepth;
  return out;
}

function moveToward(value: number, target: number, maxDelta: number): number {
  const delta = target - value;
  return Math.abs(delta) <= maxDelta ? target : value + Math.sign(delta) * maxDelta;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
