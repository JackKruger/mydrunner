import { UNDAMAGED_VEHICLE } from '../types.js';
import type { VehicleDamageState } from '../types.js';

export interface CollisionDamageEvent {
  /** Solver impulse in N*s. */
  impulse: number;
  /** Contact point in chassis-local metres (+Z is front). */
  localPoint: { x: number; y: number; z: number };
  chassisHalfExtents: { x: number; y: number; z: number };
  /** 0 glancing/sideways, 1 driving directly into the contact. */
  approach: number;
}

export function createDamageState(): VehicleDamageState {
  return { ...UNDAMAGED_VEHICLE };
}

export function repairDamage(state: VehicleDamageState): void {
  state.body = 1;
  state.engine = 1;
  state.steering = 1;
  state.stoppedCause = 'none';
}

/**
 * Applies one owner-observed Rapier contact. Low/resting impulses are ignored;
 * direction and local contact position decide which systems are affected.
 */
export function applyCollisionDamage(
  state: VehicleDamageState,
  event: CollisionDamageEvent,
  damageResistance: number,
  bullbarEngineProtection: number,
): void {
  if (!Number.isFinite(event.impulse) || event.impulse <= 2_200) return;
  const severity = Math.min(0.75, (event.impulse - 2_200) / 17_000)
    * Math.max(0.35, 1.15 - damageResistance);
  if (severity <= 0) return;
  const frontness = Math.max(0, event.localPoint.z / Math.max(0.1, event.chassisHalfExtents.z));
  const sideness = Math.min(1, Math.abs(event.localPoint.x) / Math.max(0.1, event.chassisHalfExtents.x));
  const direct = Math.max(0, Math.min(1, event.approach));
  state.body = clamp01(state.body - severity * (0.65 + direct * 0.35));
  if (frontness > 0.38) {
    const protection = Math.max(0, Math.min(0.8, bullbarEngineProtection));
    state.engine = clamp01(
      state.engine - severity * frontness * (0.35 + direct * 0.9) * (1 - protection),
    );
    state.steering = clamp01(
      state.steering - severity * frontness * (0.18 + sideness * 0.65),
    );
  } else if (sideness > 0.62) {
    state.steering = clamp01(state.steering - severity * sideness * 0.32);
  }
  if (state.engine <= 0.08) state.stoppedCause = 'collision';
}

export function normalizeDamageState(value: unknown): VehicleDamageState | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Partial<VehicleDamageState>;
  if (
    typeof v.body !== 'number' || !Number.isFinite(v.body) || v.body < 0 || v.body > 1
    || typeof v.engine !== 'number' || !Number.isFinite(v.engine) || v.engine < 0 || v.engine > 1
    || typeof v.steering !== 'number' || !Number.isFinite(v.steering) || v.steering < 0 || v.steering > 1
    || (v.stoppedCause !== 'none' && v.stoppedCause !== 'collision' && v.stoppedCause !== 'flooding')
  ) return null;
  return { body: v.body, engine: v.engine, steering: v.steering, stoppedCause: v.stoppedCause };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
