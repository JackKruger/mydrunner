import { describe, expect, it } from 'vitest';
import { Physics, WINCH } from '@mydrunner/shared';
import { CULL_SHOW_FACTOR, cullRadius, shouldShow } from '../obstacles/cull.js';
import { QUALITY } from '../quality.js';

type Obstacle = Physics.Obstacle;

function obstacle(kind: string, size: number, height = 0): Obstacle {
  return { id: `${kind}-${size}`, kind, x: 0, y: 0, z: 0, yaw: 0, size, height } as Obstacle;
}

const FLOOR = QUALITY.low.obstacleCullFloorM;

describe('the winch invariant', () => {
  it('keeps the cull floor clear of anything a cable can reach', () => {
    // THIS IS THE ONE THAT MATTERS. Winch anchoring raycasts the obstacle
    // group, and THREE.Raycaster skips subtrees with visible === false — so
    // an object hidden inside winch range is an object the player can no
    // longer winch to. That is a gameplay change, which is exactly what the
    // graphics tier is not allowed to make.
    //
    // If someone retunes WINCH.maxAttachDistance upward, this fails and the
    // floor moves with it, rather than mobile players quietly losing recovery
    // points on scenery that desktop players still have.
    //
    // The margin is not decoration. The cull measures from the CAMERA and the
    // anchor check measures from the TRUCK, and the chase camera sits up to
    // ~15 m behind. Hiding only ever happens far from the camera, so the
    // binding case is an object straight ahead: at the floor it is still
    // FLOOR - 15 m from the truck, which has to clear the attach distance.
    const MAX_CHASE_OFFSET_M = 15;
    expect(FLOOR - MAX_CHASE_OFFSET_M).toBeGreaterThan(WINCH.maxAttachDistance);
  });

  it('never hides a kind a cable can attach to, at any anchorable size', () => {
    // From winchAnchorForObstacle: trunk kinds at any size, stump >= 0.35,
    // rock >= 1.25, and boulder unconditionally.
    const anchorable: [string, number][] = [
      ['tree', 0.1], ['pine', 0.1], ['deadTree', 0.1], ['palm', 0.1],
      ['stump', 0.35], ['rock', 1.25], ['boulder', 0.01],
    ];
    for (const [kind, size] of anchorable) {
      expect(cullRadius(obstacle(kind, size), FLOOR), kind).toBe(Infinity);
    }
  });

  it('does cull rocks too small to anchor to', () => {
    // Sub-1.25 m rocks are the population worth culling — the mountain's
    // rockfall satellites and grid pebbles — and winchAnchorForObstacle
    // rejects them, so hiding them past the floor takes nothing away.
    expect(cullRadius(obstacle('rock', 0.3), FLOOR)).toBe(FLOOR);
    expect(Physics.winchAnchorForObstacle(obstacle('rock', 0.3), { x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe('cull radius', () => {
  it('never hides a landmark-sized object', () => {
    expect(cullRadius(obstacle('shippingContainer', 2.4), FLOOR)).toBe(Infinity);
    // Bulk also counts height: a tall thin object is a landmark too.
    expect(cullRadius(obstacle('flagpole', 0.2, 8), FLOOR)).toBe(Infinity);
  });

  it('hides only genuinely small scenery at the floor', () => {
    expect(cullRadius(obstacle('trafficCone', 0.3), FLOOR)).toBe(FLOOR);
    expect(cullRadius(obstacle('tyreStack', 1.0), FLOOR)).toBeGreaterThan(FLOOR);
  });
});

describe('hysteresis', () => {
  it('does not strobe an object sitting on the boundary', () => {
    const r = 60;
    const onBoundary = (r - 0.01) ** 2;
    // Just inside: a shown object stays shown.
    expect(shouldShow(onBoundary, r, true)).toBe(true);
    // Just outside: it hides.
    expect(shouldShow((r + 0.01) ** 2, r, true)).toBe(false);
    // Once hidden it must come back closer than it left, not at the same
    // radius — otherwise a parked truck at exactly r flickers every sweep.
    expect(shouldShow(onBoundary, r, false)).toBe(false);
    expect(shouldShow((r * CULL_SHOW_FACTOR - 0.01) ** 2, r, false)).toBe(true);
  });

  it('always shows an object with an infinite radius', () => {
    expect(shouldShow(1e9, Infinity, false)).toBe(true);
  });
});
