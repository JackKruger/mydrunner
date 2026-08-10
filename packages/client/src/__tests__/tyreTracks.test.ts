import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  Physics,
  VEHICLE_PART_CATALOGS,
  createStockBuild,
  type VehicleState,
} from '@mydrunner/shared';
import {
  TYRE_TRACK_FADE_START_MS,
  TYRE_TRACK_LIFETIME_MS,
  TyreTrackSystem,
  tyreTrackFade,
  tyreTrackWidth,
} from '../tyreTracks.js';

const SIZE = 80;
const RES = 16;
const BUILD = createStockBuild();

function terrain(surface: Physics.Surface, waterLevel?: number): Physics.TerrainData {
  const result: Physics.TerrainData = {
    size: SIZE,
    resolution: RES,
    heights: new Float32Array(RES * RES),
    surfaces: new Uint8Array(RES * RES).fill(surface),
    seed: 0,
    mountain: Physics.mountainFor(SIZE),
    petrolStation: Physics.petrolStationPadFor(SIZE),
    ...Physics.dryWater(RES),
    bogs: [],
    roads: [],
  };
  if (waterLevel !== undefined) result.waterLevel.fill(waterLevel);
  return result;
}

function vehicle(speed = 5, contact = true): VehicleState {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linVel: { x: 0, y: 0, z: speed },
    angVel: { x: 0, y: 0, z: 0 },
    rpm: 1000,
    gear: 1,
    throttle: 0.3,
    drivetrain: { transferCase: '4h', frontLocked: false, rearLocked: false },
    damage: { body: 1, engine: 1, steering: 1, stoppedCause: 'none' },
    wheels: [0, 1, 2, 3].map(() => ({
      steer: 0,
      spin: 0,
      contact,
      suspensionLength: 0.3,
      angVel: 10,
      tireDeflection: 0.015,
      tireContactNormal: { x: 0, y: 1, z: 0 },
    })),
    axles: [{ rideY: 0, rollAngle: 0 }, { rideY: 0, rollAngle: 0 }],
  };
}

function pose(z = 0, extraY = 0): THREE.Group {
  const geom = Physics.geomFor(BUILD);
  const group = new THREE.Group();
  group.position.set(
    0,
    Math.abs(geom.front.centerLocalY) + 0.3 + geom.wheelRadius + extraY,
    z,
  );
  return group;
}

function driveOneStep(tracks: TyreTrackSystem, surface: Physics.Surface): void {
  tracks.setTerrain(terrain(surface));
  tracks.sampleVehicle('p1', BUILD, vehicle(), pose(0));
  tracks.sampleVehicle('p1', BUILD, vehicle(), pose(0.4));
}

describe('visual tyre tracks', () => {
  it.each([
    Physics.Surface.Dirt,
    Physics.Surface.Mud,
    Physics.Surface.DeepMud,
    Physics.Surface.Grass,
  ])('leaves four independent wheel marks on supported surface %s', (surface) => {
    const tracks = new TyreTrackSystem();
    driveOneStep(tracks, surface);
    expect(tracks.activeSegmentCount).toBe(4);
    expect(tracks.mesh.visible).toBe(true);
    tracks.dispose();
  });

  it.each([
    Physics.Surface.Road,
    Physics.Surface.Gravel,
    Physics.Surface.Concrete,
  ])('does not mark firm surface %s', (surface) => {
    const tracks = new TyreTrackSystem();
    driveOneStep(tracks, surface);
    expect(tracks.activeSegmentCount).toBe(0);
    tracks.dispose();
  });

  it('requires a rolling, terrain-supported wheel', () => {
    const noContact = new TyreTrackSystem();
    noContact.setTerrain(terrain(Physics.Surface.Dirt));
    noContact.sampleVehicle('p1', BUILD, vehicle(5, false), pose(0));
    noContact.sampleVehicle('p1', BUILD, vehicle(5, false), pose(0.4));
    expect(noContact.activeSegmentCount).toBe(0);
    noContact.dispose();

    const stopped = new TyreTrackSystem();
    stopped.setTerrain(terrain(Physics.Surface.Dirt));
    stopped.sampleVehicle('p1', BUILD, vehicle(0), pose(0));
    stopped.sampleVehicle('p1', BUILD, vehicle(0), pose(0.4));
    expect(stopped.activeSegmentCount).toBe(0);
    stopped.dispose();

    const onObstacle = new TyreTrackSystem();
    onObstacle.setTerrain(terrain(Physics.Surface.Dirt));
    onObstacle.sampleVehicle('p1', BUILD, vehicle(), pose(0, 1));
    onObstacle.sampleVehicle('p1', BUILD, vehicle(), pose(0.4, 1));
    expect(onObstacle.activeSegmentCount).toBe(0);
    onObstacle.dispose();
  });

  it('does not draw a firm bed through water but still marks submerged mud', () => {
    const firm = new TyreTrackSystem();
    firm.setTerrain(terrain(Physics.Surface.Dirt, 0.4));
    firm.sampleVehicle('p1', BUILD, vehicle(), pose(0));
    firm.sampleVehicle('p1', BUILD, vehicle(), pose(0.4));
    expect(firm.activeSegmentCount).toBe(0);
    firm.dispose();

    const mud = new TyreTrackSystem();
    mud.setTerrain(terrain(Physics.Surface.Mud, 0.4));
    mud.sampleVehicle('p1', BUILD, vehicle(), pose(0));
    mud.sampleVehicle('p1', BUILD, vehicle(), pose(0.4));
    expect(mud.activeSegmentCount).toBe(4);
    mud.dispose();
  });

  it('breaks continuity across teleports and player disappearance', () => {
    const tracks = new TyreTrackSystem();
    tracks.setTerrain(terrain(Physics.Surface.Dirt));
    tracks.sampleVehicle('p1', BUILD, vehicle(), pose(0));
    tracks.sampleVehicle('p1', BUILD, vehicle(), pose(5));
    expect(tracks.activeSegmentCount).toBe(0);

    tracks.retainPlayers(new Set());
    tracks.sampleVehicle('p1', BUILD, vehicle(), pose(5.4));
    expect(tracks.activeSegmentCount).toBe(0);
    tracks.dispose();
  });

  it('uses the fitted tyre width for the visible print', () => {
    const catalog = VEHICLE_PART_CATALOGS[BUILD.baseId];
    const widest = catalog.tires.reduce((a, b) => (
      tyreTrackWidth({ ...BUILD, tireId: b.id }) > tyreTrackWidth({ ...BUILD, tireId: a.id }) ? b : a
    ));
    const wideBuild = { ...BUILD, tireId: widest.id };
    expect(tyreTrackWidth(wideBuild)).toBeGreaterThan(tyreTrackWidth(BUILD));
    expect(tyreTrackWidth(BUILD)).toBeCloseTo(Physics.geomFor(BUILD).wheelWidth * 0.9, 6);
  });

  it('fades late in its bounded lifetime', () => {
    expect(tyreTrackFade(0)).toBe(1);
    expect(tyreTrackFade(TYRE_TRACK_FADE_START_MS)).toBe(1);
    expect(tyreTrackFade((TYRE_TRACK_FADE_START_MS + TYRE_TRACK_LIFETIME_MS) / 2))
      .toBeCloseTo(0.5, 6);
    expect(tyreTrackFade(TYRE_TRACK_LIFETIME_MS)).toBe(0);
  });

  it('recycles a fixed pool and renders it as one mesh', () => {
    const tracks = new TyreTrackSystem(4);
    tracks.setTerrain(terrain(Physics.Surface.Dirt));
    tracks.sampleVehicle('p1', BUILD, vehicle(), pose(0));
    tracks.sampleVehicle('p1', BUILD, vehicle(), pose(0.4));
    tracks.sampleVehicle('p1', BUILD, vehicle(), pose(0.8));
    expect(tracks.activeSegmentCount).toBe(4);
    expect(tracks.capacity).toBe(4);
    expect(tracks.group.children).toEqual([tracks.mesh]);
    expect(tracks.mesh.geometry.drawRange.count).toBe(24);
    tracks.dispose();
  });

  it('clears marks and continuity when the world changes', () => {
    const tracks = new TyreTrackSystem();
    driveOneStep(tracks, Physics.Surface.Grass);
    tracks.setTerrain(terrain(Physics.Surface.Dirt));
    expect(tracks.activeSegmentCount).toBe(0);
    expect(tracks.mesh.visible).toBe(false);
    tracks.sampleVehicle('p1', BUILD, vehicle(), pose(0.8));
    expect(tracks.activeSegmentCount).toBe(0);
    tracks.dispose();
  });
});
