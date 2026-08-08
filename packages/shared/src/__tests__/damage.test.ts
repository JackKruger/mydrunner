import { describe, expect, it } from 'vitest';
import { applyCollisionDamage, createDamageState, repairDamage } from '../physics/damage.js';

const ext = { x: 0.9, y: 0.5, z: 2.1 };

describe('vehicle damage', () => {
  it('ignores ordinary resting and suspension impulses', () => {
    const state = createDamageState();
    applyCollisionDamage(state, { impulse: 1_900, localPoint: { x: 0, y: -0.5, z: 0 }, chassisHalfExtents: ext, approach: 1 }, 0.8, 0);
    expect(state).toEqual(createDamageState());
  });

  it('damages the engine more in a direct frontal strike', () => {
    const front = createDamageState();
    const side = createDamageState();
    applyCollisionDamage(front, { impulse: 10_000, localPoint: { x: 0, y: 0, z: 2 }, chassisHalfExtents: ext, approach: 1 }, 0.8, 0);
    applyCollisionDamage(side, { impulse: 10_000, localPoint: { x: 0.9, y: 0, z: 0 }, chassisHalfExtents: ext, approach: 1 }, 0.8, 0);
    expect(front.engine).toBeLessThan(side.engine);
    expect(front.body).toBeLessThan(1);
  });

  it('gives a steel bullbar meaningful engine protection', () => {
    const bare = createDamageState();
    const protectedState = createDamageState();
    const hit = { impulse: 14_000, localPoint: { x: 0, y: 0, z: 2 }, chassisHalfExtents: ext, approach: 1 };
    applyCollisionDamage(bare, hit, 0.8, 0);
    applyCollisionDamage(protectedState, hit, 0.8, 0.56);
    expect(protectedState.engine).toBeGreaterThan(bare.engine);
  });

  it('repairs all conditions', () => {
    const state = createDamageState();
    state.body = 0.2; state.engine = 0; state.steering = 0.3; state.stoppedCause = 'collision';
    repairDamage(state);
    expect(state).toEqual(createDamageState());
  });
});
