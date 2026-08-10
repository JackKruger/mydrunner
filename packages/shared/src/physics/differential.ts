/** Deterministic axle-differential primitives. */

export type DifferentialMode = 'open' | 'locked' | 'lsd';

export interface DifferentialSpec {
  mode: 'open' | 'selectable-locker' | 'lsd';
  torqueBiasRatio: number;
  preloadNm: number;
}

export interface DifferentialImpulseResult {
  leftAngularVelocity: number;
  rightAngularVelocity: number;
  angularImpulse: number;
  reactionTorque: number;
}

export function differentialCarrierSpeed(left: number, right: number): number {
  return 0.5 * (left + right);
}

/** Engine-side carrier speed. Undriven front wheels cannot affect 2H/RWD;
 * the locked centre transfer in 4H/4L uses the mean axle carrier speed. */
export function drivenCarrierSpeed(
  transferCase: '2h' | '4h' | '4l',
  frontCarrier: number,
  rearCarrier: number,
): number {
  return transferCase === '2h' ? rearCarrier : 0.5 * (frontCarrier + rearCarrier);
}

/** Exact locked-centre transfer. The safe-engagement gate lives in the
 * drivetrain controls; once 4H/4L is engaged the two carriers are one shaft.
 * The impulse therefore removes all relative speed while conserving total
 * four-wheel angular momentum. */
/** @hotloop */
export function solveCenterTransferImpulse(
  frontCarrier: number,
  rearCarrier: number,
  wheelInertia: number,
  dt: number,
  out: DifferentialImpulseResult = {
    leftAngularVelocity: 0,
    rightAngularVelocity: 0,
    angularImpulse: 0,
    reactionTorque: 0,
  },
): DifferentialImpulseResult {
  const effectiveAxleInertia = 2 * Math.max(1e-6, wheelInertia);
  const step = Math.max(1e-6, dt);
  const impulse = 0.5 * (rearCarrier - frontCarrier) * effectiveAxleInertia;
  out.leftAngularVelocity = frontCarrier + impulse / effectiveAxleInertia;
  out.rightAngularVelocity = rearCarrier - impulse / effectiveAxleInertia;
  out.angularImpulse = impulse;
  out.reactionTorque = impulse / step;
  return out;
}

/**
 * Apply an equal-and-opposite side-gear impulse. The locked solution removes
 * relative speed while conserving wheel angular momentum. LSD uses the same
 * solution but caps the transferable reaction with preload and TBR.
 */
/** @hotloop */
export function solveDifferentialAngularImpulse(
  leftAngularVelocity: number,
  rightAngularVelocity: number,
  wheelInertia: number,
  dt: number,
  mode: DifferentialMode,
  axleInputTorque = 0,
  torqueBiasRatio = 1,
  preloadNm = 0,
  out: DifferentialImpulseResult = {
    leftAngularVelocity: 0,
    rightAngularVelocity: 0,
    angularImpulse: 0,
    reactionTorque: 0,
  },
): DifferentialImpulseResult {
  const inertia = Math.max(1e-6, wheelInertia);
  const step = Math.max(1e-6, dt);
  if (mode === 'open') {
    out.leftAngularVelocity = leftAngularVelocity;
    out.rightAngularVelocity = rightAngularVelocity;
    out.angularImpulse = 0;
    out.reactionTorque = 0;
    return out;
  }

  const requiredImpulse = 0.5 * (rightAngularVelocity - leftAngularVelocity) * inertia;
  let impulse = requiredImpulse;
  if (mode === 'lsd') {
    const tbr = Math.max(1, torqueBiasRatio);
    const biasFraction = (tbr - 1) / (tbr + 1);
    // Side torque is open-diff torque (half the axle input) plus/minus the
    // LSD reaction. Solving (base + reaction) / (base - reaction) <= TBR
    // gives reaction <= 0.5 * |axle torque| * (TBR-1)/(TBR+1).
    const torqueCapacity = Math.max(0, preloadNm)
      + 0.5 * Math.abs(axleInputTorque) * biasFraction;
    const impulseCapacity = torqueCapacity * step;
    impulse = clamp(requiredImpulse, -impulseCapacity, impulseCapacity);
  }

  out.leftAngularVelocity = leftAngularVelocity + impulse / inertia;
  out.rightAngularVelocity = rightAngularVelocity - impulse / inertia;
  out.angularImpulse = impulse;
  out.reactionTorque = impulse / step;
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
