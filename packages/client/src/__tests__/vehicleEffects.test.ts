// Emission rules for the ground/water visuals.
//
// The properties worth pinning are the ones whose failure is a slow
// visual bug rather than a crash: emitting per frame instead of per
// snapshot (so particle density tracks the display), and needing a wire
// field for spray (which would have cost a protocol bump).

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  Physics, createStockBuild, type VehicleState, type WorldSnapshot,
} from '@mydrunner/shared';
import { VehicleEffects } from '../vehicleEffects.js';

const SIZE = 80;
const RES = 16;
const BUILD = createStockBuild();

function terrain(waterLevel?: number): Physics.TerrainData {
  const t: Physics.TerrainData = {
    size: SIZE,
    resolution: RES,
    heights: new Float32Array(RES * RES),
    surfaces: new Uint8Array(RES * RES).fill(Physics.Surface.Dirt),
    seed: 0,
    mountain: Physics.mountainFor(SIZE),
    petrolStation: Physics.petrolStationPadFor(SIZE),
    ...Physics.dryWater(RES),
    bogs: [],
    roads: [],
  };
  if (waterLevel !== undefined) t.waterLevel.fill(waterLevel);
  return t;
}

function vehicleState(over: Partial<VehicleState> = {}): VehicleState {
  return {
    position: { x: 0, y: 0.6, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linVel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    rpm: 1000,
    gear: 1,
    throttle: 0,
    drivetrain: { transferCase: '4h', frontLocked: false, rearLocked: false },
    damage: { body: 1, engine: 1, steering: 1, stoppedCause: 'none' },
    wheels: [0, 1, 2, 3].map(() => ({
      steer: 0, spin: 0, contact: true, suspensionLength: 0.3, angVel: 0,
      tireDeflection: 0.015, tireContactNormal: { x: 0, y: 1, z: 0 },
    })),
    axles: [{ rideY: 0, rollAngle: 0 }, { rideY: 0, rollAngle: 0 }],
    ...over,
  };
}

function snapshot(v: VehicleState): WorldSnapshot {
  return {
    tick: 1,
    serverTimeMs: 0,
    players: [{
      id: 'p1', name: 'p', build: BUILD, buildRevision: 1, workshopMode: false, vehicle: v, stateSeq: 1,
    }],
  };
}

function pose(): THREE.Group {
  const g = new THREE.Group();
  g.position.set(0, 0.6, 0);
  return g;
}

/** Count of currently visible particles. */
function live(fx: VehicleEffects): number {
  return fx.particleStats().active;
}

function withWheelSpeed(v: VehicleState, angVel: number): VehicleState {
  return {
    ...v,
    wheels: v.wheels.map((wheel) => ({ ...wheel, angVel })),
  };
}

describe('wheelspin ground response', () => {
  it('shows dust when driven wheels spin on ordinary dirt', () => {
    const fx = new VehicleEffects();
    fx.setTerrain(terrain());
    const v = withWheelSpeed(vehicleState(), 12);
    fx.spawnFromSnapshot(snapshot(v), 1, () => pose());
    expect(live(fx)).toBeGreaterThan(0);
    fx.dispose();
  });

  it('emits from a wheel whose contact edge is below the hub', () => {
    const fx = new VehicleEffects();
    fx.setTerrain(terrain());
    const g = pose();
    g.position.y = 2;
    const v = withWheelSpeed(vehicleState(), 12);
    fx.spawnFromSnapshot(snapshot(v), 1, () => g);

    expect(live(fx)).toBeGreaterThan(0);
    fx.dispose();
  });

  it('increases plume density with lost-traction severity', () => {
    const weak = new VehicleEffects();
    weak.setTerrain(terrain());
    weak.spawnFromSnapshot(snapshot(withWheelSpeed(vehicleState(), 4)), 1, () => pose());
    const weakCount = live(weak);

    const strong = new VehicleEffects();
    strong.setTerrain(terrain());
    strong.spawnFromSnapshot(snapshot(withWheelSpeed(vehicleState(), 32)), 1, () => pose());
    const strongCount = live(strong);

    expect(weakCount).toBeGreaterThan(0);
    expect(strongCount).toBeGreaterThan(weakCount);
    weak.dispose();
    strong.dispose();
  });

  it('does not emit while the tyres are rolling at road speed', () => {
    const fx = new VehicleEffects();
    fx.setTerrain(terrain());
    const radius = Physics.geomFor(BUILD).wheelRadius;
    const rolling = withWheelSpeed(
      vehicleState({ linVel: { x: 0, y: 0, z: 8 } }),
      8 / radius,
    );
    fx.spawnFromSnapshot(snapshot(rolling), 1, () => pose());
    expect(live(fx)).toBe(0);
    fx.dispose();
  });

  it('does not emit from an airborne spinning wheel', () => {
    const fx = new VehicleEffects();
    fx.setTerrain(terrain());
    const v = withWheelSpeed(vehicleState(), 32);
    v.wheels = v.wheels.map((wheel) => ({ ...wheel, contact: false }));
    fx.spawnFromSnapshot(snapshot(v), 1, () => pose());
    expect(live(fx)).toBe(0);
    fx.dispose();
  });
});

describe('water spray', () => {
  it('throws spray from a wheel driving through water', () => {
    const fx = new VehicleEffects();
    fx.setTerrain(terrain(0.3));
    const g = pose();
    fx.spawnFromSnapshot(snapshot(vehicleState({ linVel: { x: 0, y: 0, z: 8 } })), 1, () => g);
    expect(live(fx)).toBeGreaterThan(0);
    fx.dispose();
  });

  it('throws none on dry ground at the same speed', () => {
    const fx = new VehicleEffects();
    fx.setTerrain(terrain());
    const g = pose();
    fx.spawnFromSnapshot(snapshot(vehicleState({ linVel: { x: 0, y: 0, z: 8 } })), 1, () => g);
    expect(live(fx)).toBe(0);
    fx.dispose();
  });

  it('throws none when parked in water', () => {
    // Standing in a ford should be still, not a fountain.
    const fx = new VehicleEffects();
    fx.setTerrain(terrain(0.3));
    const g = pose();
    fx.spawnFromSnapshot(snapshot(vehicleState()), 1, () => g);
    expect(live(fx)).toBe(0);
    fx.dispose();
  });

  it('needs no new wire field — spray comes from the transmitted pose', () => {
    // VehicleState here carries nothing about water. Spray is derived
    // from position against the water height this client computes from
    // the same map document, which is what kept SNAPSHOT_SCHEMA at 2.
    const v = vehicleState({ linVel: { x: 0, y: 0, z: 8 } });
    expect(Object.keys(v)).not.toContain('waterDepth');

    const fx = new VehicleEffects();
    fx.setTerrain(terrain(0.3));
    fx.spawnFromSnapshot(snapshot(v), 1, () => pose());
    expect(live(fx)).toBeGreaterThan(0);
    fx.dispose();
  });

  it('tapers off once the wheel is fully submerged', () => {
    const shallow = new VehicleEffects();
    shallow.setTerrain(terrain(0.25));
    shallow.spawnFromSnapshot(
      snapshot(vehicleState({ linVel: { x: 0, y: 0, z: 8 } })), 1, () => pose(),
    );
    const shallowCount = live(shallow);
    shallow.dispose();

    const deep = new VehicleEffects();
    deep.setTerrain(terrain(1.6));
    deep.spawnFromSnapshot(
      snapshot(vehicleState({ linVel: { x: 0, y: 0, z: 8 } })), 1, () => pose(),
    );
    const deepCount = live(deep);
    deep.dispose();

    expect(shallowCount).toBeGreaterThan(deepCount);
  });
});

describe('the snapshot gate', () => {
  it('emits once per snapshot, not once per frame', () => {
    // A 120 Hz client must not throw four times the particles of a
    // 30 Hz one. Same recvAtMs = same snapshot = no second emission.
    const fx = new VehicleEffects();
    fx.setTerrain(terrain(0.3));
    const g = pose();
    const snap = snapshot(vehicleState({ linVel: { x: 0, y: 0, z: 8 } }));

    fx.spawnFromSnapshot(snap, 100, () => g);
    const afterOne = live(fx);
    for (let i = 0; i < 8; i++) fx.spawnFromSnapshot(snap, 100, () => g);
    expect(live(fx)).toBe(afterOne);

    fx.spawnFromSnapshot(snap, 133, () => g);
    expect(live(fx)).toBeGreaterThan(afterOne);
    fx.dispose();
  });

  it('does nothing before a terrain is set', () => {
    const fx = new VehicleEffects();
    fx.spawnFromSnapshot(snapshot(vehicleState({ linVel: { x: 0, y: 0, z: 8 } })), 1, () => pose());
    expect(live(fx)).toBe(0);
    fx.dispose();
  });
});

describe('offline preview', () => {
  it('emits without any snapshot stream', () => {
    // The gap this closes: the whole effects path used to hang off
    // snapshot arrival, so an editor preview showed no spray at all.
    const fx = new VehicleEffects();
    fx.setTerrain(terrain(0.3));
    const v = vehicleState({ linVel: { x: 0, y: 0, z: 8 } });
    fx.spawnLocal(BUILD, v, pose(), 1000);
    expect(live(fx)).toBeGreaterThan(0);
    fx.dispose();
  });

  it('rate-limits on wall clock so density does not track frame rate', () => {
    const fx = new VehicleEffects();
    fx.setTerrain(terrain(0.3));
    const v = vehicleState({ linVel: { x: 0, y: 0, z: 8 } });
    const g = pose();
    fx.spawnLocal(BUILD, v, g, 1000);
    const afterOne = live(fx);
    // Eight more frames within the same 1/30 s window.
    for (let i = 1; i <= 8; i++) fx.spawnLocal(BUILD, v, g, 1000 + i);
    expect(live(fx)).toBe(afterOne);
    fx.dispose();
  });
});
