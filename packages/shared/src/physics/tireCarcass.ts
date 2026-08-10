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
}

export type TireContactZone = 'tread' | 'shoulder' | 'sidewall';

export interface TireContactSemantics {
  zone: TireContactZone;
  /** 1 on tread, 0 on a pure sidewall, smooth through the shoulder. */
  treadFraction: number;
  axleAlignment: number;
}

const TREAD_END = 0.35;
const SIDEWALL_START = 0.80;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Classify a cylinder contact from the absolute normal/axle dot product. */
export function classifyTireContact(normalDotAxle: number): TireContactSemantics {
  const alignment = clamp(Math.abs(normalDotAxle), 0, 1);
  if (alignment <= TREAD_END) {
    return { zone: 'tread', treadFraction: 1, axleAlignment: alignment };
  }
  if (alignment >= SIDEWALL_START) {
    return { zone: 'sidewall', treadFraction: 0, axleAlignment: alignment };
  }
  const x = (alignment - TREAD_END) / (SIDEWALL_START - TREAD_END);
  const smooth = x * x * (3 - 2 * x);
  return { zone: 'shoulder', treadFraction: 1 - smooth, axleAlignment: alignment };
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
  const total = Math.max(0, totalDeflection);
  const ks = Math.max(1, suspensionStiffness);
  const kt = Math.max(1, carcassStiffness);
  const freeCarcass = total * ks / (ks + kt);
  const carcassDeflection = clamp(freeCarcass, 0, Math.max(0, maxCarcassDeflection));
  const suspensionDeflection = Math.max(0, total - carcassDeflection);
  const force = Math.max(0, Math.min(ks * suspensionDeflection, kt * carcassDeflection));
  return {
    force,
    suspensionDeflection,
    carcassDeflection,
    suspensionForce: force,
    carcassForce: force,
  };
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
  releaseRate = 1.5,
): SidewallConstraintResult {
  const step = Math.max(1e-6, dt);
  const target = clamp(penetration, 0, Math.max(0, maxDeflection));
  const maxRelease = releaseRate * step;
  const deflection = target < previousDeflection
    ? Math.max(target, previousDeflection - maxRelease)
    : target;
  const correctionSpeed = clamp(deflection * correctionRate, 0, maxCorrectionSpeed);
  const impulse = clamp((correctionSpeed - normalSpeed) * Math.max(0, effectiveMass), 0, maxImpulse);
  return { impulse, correctionSpeed, deflection };
}

export function carcassRates(
  spec: TireCarcassSpec,
  radius: number,
  nominalQuarterLoad: number,
  quarterMass: number,
): { stiffness: number; radialDamping: number; sidewallDamping: number; maxDeflection: number } {
  const maxDeflection = Math.max(0.005, radius * spec.staticDeflectionRatio * 2);
  const staticDeflection = Math.max(0.001, radius * spec.staticDeflectionRatio);
  const stiffness = Math.max(1, nominalQuarterLoad / staticDeflection);
  const critical = 2 * Math.sqrt(stiffness * Math.max(1, quarterMass));
  const radialDamping = critical * spec.radialDampingRatio;
  return {
    stiffness,
    radialDamping,
    sidewallDamping: radialDamping * spec.sidewallDampingRatio,
    maxDeflection,
  };
}
