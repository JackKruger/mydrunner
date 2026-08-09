import { describe, expect, it } from 'vitest';
import { WINCH } from '../constants.js';
import { computeWinchForce, stepWinchRuntime, winchAnchorForObstacle } from '../physics/winch.js';

const endpoint = (x: number, velocity = 0) => ({
  position: { x, y: 0, z: 0 },
  velocity: { x: velocity, y: 0, z: 0 },
});

describe('winch rope physics', () => {
  it('is unilateral: slack cable never pushes', () => {
    const result = computeWinchForce(endpoint(0), endpoint(5), 6);
    expect(result.extension).toBe(0);
    expect(result.tension).toBe(0);
  });

  it('adds damping while endpoints separate and caps applied shock force', () => {
    const still = computeWinchForce(endpoint(0), endpoint(6), 5);
    const separating = computeWinchForce(endpoint(0, -1), endpoint(6, 1), 5);
    expect(separating.demand).toBeGreaterThan(still.demand);
    expect(separating.tension).toBe(WINCH.breakForce);
  });

  it('stalls reel-in at rated pull and breaks only after sustained overload', () => {
    const initial = { cableLength: 10, tension: 0, overloadTime: 0, broken: false };
    const stalled = stepWinchRuntime(initial, 1, WINCH.ratedPull, 0.1);
    expect(stalled.cableLength).toBe(10);
    let state = initial;
    for (let i = 0; i < 3; i++) state = stepWinchRuntime(state, 0, WINCH.breakForce + 1, 0.1);
    expect(state.broken).toBe(true);
  });

  it('only exposes strong scenery as anchors', () => {
    const base = { id: 'o', x: 4, y: 0, z: 0, height: 4, yaw: 0, length: undefined };
    expect(winchAnchorForObstacle({ ...base, kind: 'tree', size: 0.3 }, { x: 0, y: 1, z: 0 })).not.toBeNull();
    expect(winchAnchorForObstacle({ ...base, kind: 'rock', size: 0.5 }, { x: 0, y: 1, z: 0 })).toBeNull();
    expect(winchAnchorForObstacle({ ...base, kind: 'trafficCone', size: 1 }, { x: 0, y: 1, z: 0 })).toBeNull();
  });
});
