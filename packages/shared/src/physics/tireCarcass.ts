/** Directional tyre-carcass primitives shared by physics, tests and visuals. */

export interface TireCarcassSpec {
  /** Static radial deflection as a fraction of the unloaded radius. */
  staticDeflectionRatio: number;
  /** Fraction of critical damping in the radial direction. */
  radialDampingRatio: number;
  /** Sidewall damping relative to radial damping. */
  sidewallDampingRatio: number;
  /** Tangential friction retained by a pure sidewall. */
  sidewallFrictionRatio: number;
  nominalPressurePsi: number;
  minPressurePsi: number;
  maxPressurePsi: number;
}

export type TireContactZone = 'tread' | 'shoulder' | 'sidewall';

export interface TireContactSemantics {
  zone: TireContactZone;
  /** 1 on tread, 0 on a pure sidewall, smooth through the shoulder. */
  treadFraction: number;
  axleAlignment: number;
}

/** How fast a sidewall deflection is allowed to release, in m/s. Exported
 *  because the owner tick passes every argument explicitly to reach the out
 *  parameter, and a hand-copied 1.5 there would silently drift from this. */
export const SIDEWALL_RELEASE_RATE = 1.5;

const TREAD_END = 0.35;
const SIDEWALL_START = 0.80;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Classify a cylinder contact from the absolute normal/axle dot product. */
export function classifyTireContact(normalDotAxle: number): TireContactSemantics {
  return classifyTireContactInto(
    normalDotAxle,
    { zone: 'tread', treadFraction: 0, axleAlignment: 0 },
  );
}

/** `classifyTireContact` writing into a caller-owned record. @hotloop */
export function classifyTireContactInto(
  normalDotAxle: number,
  out: TireContactSemantics,
): TireContactSemantics {
  const alignment = clamp(Math.abs(normalDotAxle), 0, 1);
  out.axleAlignment = alignment;
  if (alignment <= TREAD_END) {
    out.zone = 'tread';
    out.treadFraction = 1;
    return out;
  }
  if (alignment >= SIDEWALL_START) {
    out.zone = 'sidewall';
    out.treadFraction = 0;
    return out;
  }
  const x = (alignment - TREAD_END) / (SIDEWALL_START - TREAD_END);
  const smooth = x * x * (3 - 2 * x);
  out.zone = 'shoulder';
  out.treadFraction = 1 - smooth;
  return out;
}

export interface SeriesSpringResult {
  force: number;
  suspensionDeflection: number;
  carcassDeflection: number;
  suspensionForce: number;
  carcassForce: number;
}

/**
 * Bounded closed-form solution for suspension and carcass springs in series.
 * `totalDeflection` is the hub travel reported by the geometric tyre cast.
 */
export function solveSeriesCompliance(
  totalDeflection: number,
  suspensionStiffness: number,
  carcassStiffness: number,
  maxCarcassDeflection: number,
): SeriesSpringResult {
  return solveSeriesComplianceInto(
    totalDeflection, suspensionStiffness, carcassStiffness, maxCarcassDeflection,
    {
      force: 0,
      suspensionDeflection: 0,
      carcassDeflection: 0,
      suspensionForce: 0,
      carcassForce: 0,
    },
  );
}

/** `solveSeriesCompliance` writing into a caller-owned result. @hotloop */
export function solveSeriesComplianceInto(
  totalDeflection: number,
  suspensionStiffness: number,
  carcassStiffness: number,
  maxCarcassDeflection: number,
  out: SeriesSpringResult,
): SeriesSpringResult {
  const total = Math.max(0, totalDeflection);
  const ks = Math.max(1, suspensionStiffness);
  const kt = Math.max(1, carcassStiffness);
  const freeCarcass = total * ks / (ks + kt);
  const carcassDeflection = clamp(freeCarcass, 0, Math.max(0, maxCarcassDeflection));
  const suspensionDeflection = Math.max(0, total - carcassDeflection);
  const force = Math.max(0, Math.min(ks * suspensionDeflection, kt * carcassDeflection));
  out.force = force;
  out.suspensionDeflection = suspensionDeflection;
  out.carcassDeflection = carcassDeflection;
  out.suspensionForce = force;
  out.carcassForce = force;
  return out;
}

export interface SidewallConstraintResult {
  impulse: number;
  correctionSpeed: number;
  deflection: number;
}

/** Implicit, velocity-level sidewall contact. No explicit stiff spring. */
export function solveSidewallConstraint(
  penetration: number,
  normalSpeed: number,
  effectiveMass: number,
  dt: number,
  previousDeflection: number,
  maxDeflection: number,
  correctionRate = 18,
  maxCorrectionSpeed = 2.5,
  maxImpulse = 4_000,
  releaseRate = SIDEWALL_RELEASE_RATE,
): SidewallConstraintResult {
  return solveSidewallConstraintInto(
    penetration, normalSpeed, effectiveMass, dt, previousDeflection, maxDeflection,
    correctionRate, maxCorrectionSpeed, maxImpulse, releaseRate,
    { impulse: 0, correctionSpeed: 0, deflection: 0 },
  );
}

/** `solveSidewallConstraint` writing into a caller-owned result. @hotloop */
export function solveSidewallConstraintInto(
  penetration: number,
  normalSpeed: number,
  effectiveMass: number,
  dt: number,
  previousDeflection: number,
  maxDeflection: number,
  correctionRate: number,
  maxCorrectionSpeed: number,
  maxImpulse: number,
  releaseRate: number,
  out: SidewallConstraintResult,
): SidewallConstraintResult {
  const step = Math.max(1e-6, dt);
  const target = clamp(penetration, 0, Math.max(0, maxDeflection));
  const maxRelease = releaseRate * step;
  const deflection = target < previousDeflection
    ? Math.max(target, previousDeflection - maxRelease)
    : target;
  const correctionSpeed = clamp(deflection * correctionRate, 0, maxCorrectionSpeed);
  const impulse = clamp((correctionSpeed - normalSpeed) * Math.max(0, effectiveMass), 0, maxImpulse);
  out.impulse = impulse;
  out.correctionSpeed = correctionSpeed;
  out.deflection = deflection;
  return out;
}

export interface CarcassRates {
  stiffness: number;
  radialDamping: number;
  sidewallDamping: number;
  maxDeflection: number;
}

export function carcassRates(
  spec: TireCarcassSpec,
  radius: number,
  nominalQuarterLoad: number,
  quarterMass: number,
  pressureScale = 1,
): CarcassRates {
  return carcassRatesInto(
    spec.staticDeflectionRatio, spec.radialDampingRatio, spec.sidewallDampingRatio,
    radius, nominalQuarterLoad, quarterMass, pressureScale,
    { stiffness: 0, radialDamping: 0, sidewallDamping: 0, maxDeflection: 0 },
  );
}

/** `carcassRates` taking the three carcass ratios as scalars and writing into a
 *  caller-owned result. The owner tick scales two of those ratios by live
 *  TUNING multipliers; passing them separately is what removes the per-wheel
 *  spec spread the allocating form required. @hotloop */
export function carcassRatesInto(
  staticDeflectionRatio: number,
  radialDampingRatio: number,
  sidewallDampingRatio: number,
  radius: number,
  nominalQuarterLoad: number,
  quarterMass: number,
  pressureScale: number,
  out: CarcassRates,
): CarcassRates {
  const maxDeflection = Math.max(0.005, radius * staticDeflectionRatio * 2);
  const staticDeflection = Math.max(0.001, radius * staticDeflectionRatio);
  const stiffness = Math.max(1, nominalQuarterLoad / staticDeflection)
    * Math.max(0.55, Math.min(1.35, pressureScale));
  const critical = 2 * Math.sqrt(stiffness * Math.max(1, quarterMass));
  const radialDamping = critical * radialDampingRatio;
  out.stiffness = stiffness;
  out.radialDamping = radialDamping;
  out.sidewallDamping = radialDamping * sidewallDampingRatio;
  out.maxDeflection = maxDeflection;
  return out;
}

export function pressureRadialScale(pressurePsi: number, nominalPsi: number): number {
  return clamp(pressurePsi / Math.max(1, nominalPsi), 0.55, 1.35);
}

export function pressureRollingScale(pressurePsi: number, nominalPsi: number): number {
  return (Math.max(1, nominalPsi) / Math.max(1, pressurePsi)) ** 0.6;
}

export function pressureEdgeWrapScale(pressurePsi: number, nominalPsi: number): number {
  const inverseRatio = Math.max(1, nominalPsi) / Math.max(1, pressurePsi);
  return clamp(Math.sqrt(inverseRatio), 0.75, 1.75);
}

export function pressureLateralScale(pressurePsi: number, nominalPsi: number): number {
  return clamp(Math.sqrt(Math.max(1, pressurePsi) / Math.max(1, nominalPsi)), 0.75, 1.15);
}

export function sealedRoadPressureGripScale(pressurePsi: number, nominalPsi: number): number {
  const ratio = pressurePsi / Math.max(1, nominalPsi);
  return 1 - Math.max(0, 1 - ratio) * 0.08;
}
