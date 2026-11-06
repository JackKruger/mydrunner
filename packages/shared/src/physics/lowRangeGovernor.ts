// The low-range (4L) post-solve velocity overrides, in one place.
//
// These rewrite the chassis velocity after Rapier has integrated it: a crawl
// governor along the chassis plane, a vertical-speed clamp while a discrete
// ledge is being climbed, and yaw/roll zeroing during a symmetric two-wheel
// climb. Each masks a contact-force defect rather than modelling something
// real (see "Known structural debt" in CLAUDE.md), so they live here, apart
// from the vehicle, where each can be retired as the force it compensates for
// is corrected. The vehicle decides when they run - only in 4L - and resets
// the windows on leaving it.

import type RAPIER from '@dimforge/rapier3d-compat';
import { LEDGE_CONTACT, LOW_RANGE } from '../constants.js';
import { TUNING } from '../tuning.js';

type Vec3 = { x: number; y: number; z: number };

/** Grace windows, in ticks, that keep each override engaged briefly after
 *  the condition that earned it ends. */
export interface LowRangeGovernor {
  ledgeGrace: number;
  symmetricClimbGrace: number;
}

export function createLowRangeGovernor(): LowRangeGovernor {
  return { ledgeGrace: 0, symmetricClimbGrace: 0 };
}

export function resetLowRangeGovernor(g: LowRangeGovernor): void {
  g.ledgeGrace = 0;
  g.symmetricClimbGrace = 0;
}

export interface LowRangeGovernorInputs {
  /** Chassis linear velocity as read at the top of postStep. */
  linearVelocity: Vec3;
  /** Chassis up and forward from the tick's captured pose. */
  up: Vec3;
  fwd: Vec3;
  supportedWheels: number;
  discreteLedgeSupportActive: boolean;
  /** Straight-line input with both wheels of an axle on the same ledge. */
  symmetricClimb: boolean;
}

/** Apply the 4L overrides to `body`. `scratchLinear` / `scratchAngular` are
 *  caller-owned so the tick stays allocation-free. @hotloop */
export function applyLowRangeGovernor(
  g: LowRangeGovernor,
  body: RAPIER.RigidBody,
  inputs: LowRangeGovernorInputs,
  scratchLinear: Vec3,
  scratchAngular: Vec3,
  substeps = 1,
): void {
  const lv = inputs.linearVelocity;
  g.ledgeGrace = inputs.discreteLedgeSupportActive
    ? LOW_RANGE.ledgeVelocityGraceTicks * substeps
    : Math.max(0, g.ledgeGrace - 1);
  // The governor stands in for the driveline holding the truck back, so
  // it only acts while the tyres can: with fewer than two wheels on
  // anything the truck is airborne or tumbling, and clamping it would
  // freeze a jump or fall in mid-air.
  const governed = inputs.supportedWheels >= 2;
  const limited = scratchLinear;
  limited.x = lv.x;
  limited.y = governed && g.ledgeGrace > 0
    ? clamp(lv.y, -LOW_RANGE.maxLedgeVerticalSpeed, LOW_RANGE.maxLedgeVerticalSpeed)
    : lv.y;
  limited.z = lv.z;
  if (governed) {
    // Cap travel along the ground, not world-horizontal speed. Scaling
    // only x/z on a grade leaves the full vertical component in place,
    // which tilts the velocity off the surface: uphill that launched the
    // truck off the slope it was climbing, downhill it drove it into it.
    // Chassis up stands in for the ground normal while wheels support it;
    // the normal component (suspension travel, a landing) is untouched.
    const up = inputs.up;
    const normalSpeed = limited.x * up.x + limited.y * up.y + limited.z * up.z;
    const tangentX = limited.x - up.x * normalSpeed;
    const tangentY = limited.y - up.y * normalSpeed;
    const tangentZ = limited.z - up.z * normalSpeed;
    const tangentSpeed = Math.hypot(tangentX, tangentY, tangentZ);
    if (tangentSpeed > TUNING.lowRangeMaxCrawlSpeed) {
      const scale = TUNING.lowRangeMaxCrawlSpeed / tangentSpeed;
      limited.x = tangentX * scale + up.x * normalSpeed;
      limited.y = tangentY * scale + up.y * normalSpeed;
      limited.z = tangentZ * scale + up.z * normalSpeed;
    }
  }
  if (limited.x !== lv.x || limited.y !== lv.y || limited.z !== lv.z) {
    body.setLinvel(limited, true);
  }
  g.symmetricClimbGrace = inputs.symmetricClimb
    ? LEDGE_CONTACT.handoffGraceTicks * substeps
    : Math.max(0, g.symmetricClimbGrace - 1);
  if (g.symmetricClimbGrace > 0) {
    const av = body.angvel();
    const up = inputs.up;
    const fwd = inputs.fwd;
    const yawRate = av.x * up.x + av.y * up.y + av.z * up.z;
    const rollRate = av.x * fwd.x + av.y * fwd.y + av.z * fwd.z;
    const limitedAngular = scratchAngular;
    limitedAngular.x = av.x - up.x * yawRate - fwd.x * rollRate;
    limitedAngular.y = av.y - up.y * yawRate - fwd.y * rollRate;
    limitedAngular.z = av.z - up.z * yawRate - fwd.z * rollRate;
    body.setAngvel(limitedAngular, true);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
