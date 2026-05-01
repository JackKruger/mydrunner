// Cheap Pacejka-style longitudinal grip curve. Returns a multiplier in
// [TIRE.slipFloor, 1.0] for the engine force at a wheel given its slip
// ratio. Models the basic phenomenon: if you spin a wheel faster than
// the contact patch can grip, you LOSE traction. So mashing the throttle
// in mud isn't just slow because of low surface friction - it's slow
// because the tire is breaking loose and not transmitting torque.
//
// Slip ratio = (wheelSurfaceSpeed - groundSpeed) / max(|wheelSurfaceSpeed|, |groundSpeed|, eps)
// where wheelSurfaceSpeed = wheelAngVel * wheelRadius.

import { TIRE } from '../constants.js';

export function slipRatio(wheelAngVel: number, wheelRadius: number, groundSpeed: number): number {
  const wheelLin = wheelAngVel * wheelRadius;
  const denom = Math.max(Math.abs(wheelLin), Math.abs(groundSpeed), 0.5);
  return (wheelLin - groundSpeed) / denom;
}

export function gripFromSlip(slip: number): number {
  const a = Math.abs(slip);
  if (a <= TIRE.slipPeak) {
    // Linear ramp up to peak.
    return a / TIRE.slipPeak;
  }
  // Exponential decay past peak, asymptoting to slipFloor.
  const over = a - TIRE.slipPeak;
  const decay = Math.exp(-over * TIRE.slipFalloff);
  return TIRE.slipFloor + (1 - TIRE.slipFloor) * decay;
}
