// The editor's tool state, where it meets the object catalog.

import { describe, it, expect } from 'vitest';
import { Physics } from '@mydrunner/shared';
import {
  OBJECT_YAW_STEP, applyKindDefaults, defaultToolState, objectBaseY, placeableKinds, stepYaw,
} from '../editor/tools.js';
import { OBJECT_MESHES } from '../obstacles/registry.js';
import { createMeshCtx } from '../obstacles/materials.js';

describe('placeable kinds', () => {
  it('offers every kind the catalog knows, grouped', () => {
    const offered = placeableKinds().flatMap((g) => g.kinds);
    expect([...offered].sort()).toEqual([...Physics.OBJECT_KINDS].sort());
    expect(placeableKinds().length).toBeGreaterThan(1);
  });

  it('names every group', () => {
    for (const g of placeableKinds()) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.kinds.length).toBeGreaterThan(0);
    }
  });

  it('has a visual builder for every offered kind', () => {
    expect(Object.keys(OBJECT_MESHES).sort()).toEqual([...Physics.OBJECT_KINDS].sort());
  });

  it('builds the expanded choices with finite local transforms', () => {
    const added = [
      'cactus', 'reeds', 'stairSteps', 'rockGarden', 'washboard', 'sandbagWall',
      'fuelPump', 'generator', 'portableToilet', 'streetLight', 'bench',
      'roadworkBarrier', 'checkpointArch', 'horizontalTank', 'watchtower',
      'campTent', 'woodPile', 'waterTrough', 'farmWindmill', 'solarPanel',
      'oldTractor', 'bushHut', 'timberCabin', 'leanTo', 'caravan', 'bushDunny',
    ] as const;
    const ctx = createMeshCtx();
    for (const kind of added) {
      const d = Physics.objectInfo(kind).defaults;
      const parts = OBJECT_MESHES[kind](ctx, {
        id: `test-${kind}`, kind, x: 0, y: 0, z: 0, yaw: 0,
        size: d.size, height: d.height,
        ...(d.length !== undefined ? { length: d.length } : {}),
      });
      expect(parts.length, kind).toBeGreaterThan(0);
      for (const part of parts) {
        part.traverse((node) => {
          for (const value of [
            node.position.x, node.position.y, node.position.z,
            node.rotation.x, node.rotation.y, node.rotation.z,
            node.scale.x, node.scale.y, node.scale.z,
          ]) expect(Number.isFinite(value), kind).toBe(true);
        });
      }
    }
  });
});

describe('applyKindDefaults', () => {
  it('reseeds the dimensions from the kind, not a global', () => {
    const state = defaultToolState();
    // The old behaviour was one global 1.6 / 2 for everything, which sized
    // a traffic cone like a boulder and a flagpole like a rock.
    applyKindDefaults(state, 'trafficCone');
    const cone = Physics.objectInfo('trafficCone').defaults;
    expect(state.objectKind).toBe('trafficCone');
    expect(state.objectSize).toBeCloseTo(cone.size, 9);
    expect(state.objectHeight).toBeCloseTo(cone.height, 9);

    applyKindDefaults(state, 'boulder');
    expect(state.objectSize).toBeCloseTo(Physics.objectInfo('boulder').defaults.size, 9);
    expect(state.objectSize).not.toBeCloseTo(cone.size, 3);
  });

  it('always leaves a usable length, even for kinds that ignore it', () => {
    const state = defaultToolState();
    for (const kind of Physics.OBJECT_KINDS) {
      applyKindDefaults(state, kind);
      expect(state.objectLength, kind).toBeGreaterThan(0);
      expect(Number.isFinite(state.objectLength), kind).toBe(true);
    }
  });

  it('seeds dimensions inside the kind limits for every kind', () => {
    const state = defaultToolState();
    for (const kind of Physics.OBJECT_KINDS) {
      applyKindDefaults(state, kind);
      const l = Physics.objectInfo(kind).limits;
      expect(state.objectSize, kind).toBeGreaterThanOrEqual(l.size[0]);
      expect(state.objectSize, kind).toBeLessThanOrEqual(l.size[1]);
      expect(state.objectHeight, kind).toBeGreaterThanOrEqual(l.height[0]);
      expect(state.objectHeight, kind).toBeLessThanOrEqual(l.height[1]);
    }
  });
});

describe('stepYaw', () => {
  it('steps by a fixed increment', () => {
    expect(stepYaw(0, 1)).toBeCloseTo(OBJECT_YAW_STEP, 9);
    expect(stepYaw(0, -1)).toBeCloseTo(-OBJECT_YAW_STEP, 9);
  });

  // The panel's yaw slider runs -pi..pi. An unwrapped value would drive it
  // off the end and the readout would stop matching the ghost.
  it('wraps into the slider range', () => {
    let yaw = 0;
    for (let i = 0; i < 40; i++) yaw = stepYaw(yaw, 1);
    expect(yaw).toBeGreaterThanOrEqual(-Math.PI);
    expect(yaw).toBeLessThanOrEqual(Math.PI);
  });

  it('returns to where it started after a full turn', () => {
    const steps = Math.round((Math.PI * 2) / OBJECT_YAW_STEP);
    let yaw = 0.4;
    for (let i = 0; i < steps; i++) yaw = stepYaw(yaw, 1);
    expect(Math.cos(yaw)).toBeCloseTo(Math.cos(0.4), 6);
    expect(Math.sin(yaw)).toBeCloseTo(Math.sin(0.4), 6);
  });
});

describe('defaultToolState', () => {
  it('starts on a kind the catalog knows, at that kind\'s defaults', () => {
    const s = defaultToolState();
    expect(Physics.isObstacleKind(s.objectKind)).toBe(true);
    const d = Physics.objectInfo(s.objectKind).defaults;
    expect(s.objectSize).toBeCloseTo(d.size, 9);
    expect(s.objectHeight).toBeCloseTo(d.height, 9);
  });

  it('starts with a determinate yaw', () => {
    // Placement used to write Math.random() at click time, so the ghost
    // could never have matched what landed.
    expect(defaultToolState().objectYaw).toBe(0);
  });

  it('starts ground-snapped and resolves every placement mode', () => {
    const state = defaultToolState();
    expect(state.objectPlacementMode).toBe('ground');
    expect(objectBaseY(state, 12)).toBe(12);

    state.objectPlacementMode = 'offset';
    state.objectYOffset = 2.375;
    expect(objectBaseY(state, 12)).toBeCloseTo(14.375, 9);

    state.objectPlacementMode = 'absolute';
    state.objectWorldY = -3.125;
    expect(objectBaseY(state, 99)).toBeCloseTo(-3.125, 9);
  });
});
