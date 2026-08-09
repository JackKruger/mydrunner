import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  VEHICLE_BASE_IDS,
  VEHICLE_PART_CATALOGS,
  createStockBuild,
  type VehicleBaseId,
  type VehicleBuild,
} from '@mydrunner/shared';
import { buildCarMesh } from '../carMesh.js';
import { disposeObject3D } from '../three/dispose.js';
import {
  createVehicleVisualLayout,
  type VisualBox,
  type VehicleVisualLayout,
} from '../vehicleVisualLayout.js';

const EPSILON = 1e-6;

function expectInsideCabin(spec: VisualBox, layout: VehicleVisualLayout): void {
  const half = {
    x: layout.cabin.size.x / 2,
    y: layout.cabin.size.y / 2,
    z: layout.cabin.size.z / 2,
  };
  expect(spec.center.x - spec.size.x / 2).toBeGreaterThanOrEqual(layout.cabin.center.x - half.x - EPSILON);
  expect(spec.center.x + spec.size.x / 2).toBeLessThanOrEqual(layout.cabin.center.x + half.x + EPSILON);
  expect(spec.center.y - spec.size.y / 2).toBeGreaterThanOrEqual(layout.cabin.center.y - half.y - EPSILON);
  expect(spec.center.y + spec.size.y / 2).toBeLessThanOrEqual(layout.cabin.center.y + half.y + EPSILON);
  expect(spec.center.z - spec.size.z / 2).toBeGreaterThanOrEqual(layout.cabin.rearZ - EPSILON);
  expect(spec.center.z + spec.size.z / 2).toBeLessThanOrEqual(layout.cabin.frontZ + EPSILON);
}

function fittedBuild(baseId: VehicleBaseId, changes: Partial<VehicleBuild>): VehicleBuild {
  return { ...createStockBuild(baseId), ...changes };
}

describe('vehicle visual layout', () => {
  it('keeps dashboards and every seat row inside the cabin on all bases', () => {
    for (const baseId of VEHICLE_BASE_IDS) {
      const layout = createVehicleVisualLayout(createStockBuild(baseId));
      expectInsideCabin(layout.dashboard, layout);
      for (const seat of layout.seats) expectInsideCabin(seat, layout);
      expect(layout.seats).toHaveLength(baseId === 'stockman-single' || baseId === 'outclaw' ? 2 : 4);
    }
  });

  it('models the dual cab as a longer cabin with its rear glass on the actual rear plane', () => {
    const single = createVehicleVisualLayout(createStockBuild('stockman-single'));
    const dual = createVehicleVisualLayout(createStockBuild('stockman-dual'));
    expect(dual.cabin.size.z).toBeGreaterThan(single.cabin.size.z);
    expect(dual.cabin.frontZ / dual.extents.z).toBeCloseTo(0.925, 6);
    expect(dual.cabin.rearZ / dual.extents.z).toBeCloseTo(-0.375, 6);
    expect(dual.cabin.rearWindow.center.z + dual.cabin.rearWindow.size.z / 2).toBeCloseTo(dual.cabin.rearZ, 6);
  });

  it('chooses the cab roof for a low utility rear and the canopy for a full-height rear', () => {
    for (const baseId of ['stockman-single', 'stockman-dual'] as const) {
      const catalog = VEHICLE_PART_CATALOGS[baseId];
      const low = createVehicleVisualLayout(fittedBuild(baseId, { rearBodyId: catalog.rearBodies[1]!.id }));
      const high = createVehicleVisualLayout(fittedBuild(baseId, { rearBodyId: catalog.rearBodies[2]!.id }));
      expect(low.canopy).toBeNull();
      expect(low.roofSurface.center.z).toBeCloseTo(low.cabin.center.z, 6);
      expect(high.canopy).not.toBeNull();
      expect(high.canopy!.center.y + high.canopy!.size.y / 2).toBeCloseTo(high.cabin.roofY, 6);
      expect(high.roofSurface.center.z).toBeCloseTo(high.canopy!.center.z, 6);
      expect(high.roofSurface.length).toBeCloseTo(high.canopy!.size.z, 6);
    }
  });

  it('mounts every roof option four centimetres above and within its chosen surface', () => {
    for (const baseId of VEHICLE_BASE_IDS) {
      if (baseId === 'dustback-rs') continue;
      const catalog = VEHICLE_PART_CATALOGS[baseId];
      for (const roofOption of catalog.roofs.slice(1)) {
        const rearBodyId = baseId.startsWith('stockman') ? catalog.rearBodies[2]!.id : catalog.rearBodies[0]!.id;
        const build = fittedBuild(baseId, { roofId: roofOption.id, rearBodyId });
        const layout = createVehicleVisualLayout(build);
        const built = buildCarMesh(build, true, 0);
        built.group.updateMatrixWorld(true);
        const platform = built.group.getObjectByName('roof.platform')!;
        const bounds = new THREE.Box3().setFromObject(platform);
        expect(bounds.min.y - layout.roofSurface.center.y).toBeCloseTo(0.04, 6);
        expect(bounds.max.x - bounds.min.x).toBeCloseTo(layout.roofSurface.width * 0.90, 6);
        expect(bounds.max.z - bounds.min.z).toBeCloseTo(layout.roofSurface.length * 0.85, 6);
        expect(bounds.min.x).toBeGreaterThanOrEqual(-layout.roofSurface.width / 2 - EPSILON);
        expect(bounds.max.x).toBeLessThanOrEqual(layout.roofSurface.width / 2 + EPSILON);
        expect(bounds.min.z).toBeGreaterThanOrEqual(layout.roofSurface.center.z - layout.roofSurface.length / 2 - EPSILON);
        expect(bounds.max.z).toBeLessThanOrEqual(layout.roofSurface.center.z + layout.roofSurface.length / 2 + EPSILON);
        for (let index = 0; index < 4; index++) {
          const footBounds = new THREE.Box3().setFromObject(built.group.getObjectByName(`roof.foot.${index}`)!);
          expect(footBounds.min.y).toBeCloseTo(layout.roofSurface.center.y, 6);
        }
        disposeObject3D(built.group);
      }
    }
  });

  it('keeps fitted snorkel pipes and heads outside the cabin skin and glass', () => {
    for (const baseId of VEHICLE_BASE_IDS) {
      const catalog = VEHICLE_PART_CATALOGS[baseId];
      if (catalog.snorkels.length < 2) continue;
      const build = fittedBuild(baseId, { snorkelId: catalog.snorkels[1]!.id });
      const layout = createVehicleVisualLayout(build);
      const built = buildCarMesh(build, true, 0);
      built.group.updateMatrixWorld(true);
      const cabinSkinX = layout.cabin.size.x / 2;
      for (const name of ['snorkel.pipe', 'snorkel.head']) {
        const bounds = new THREE.Box3().setFromObject(built.group.getObjectByName(name)!);
        expect(bounds.min.x - cabinSkinX).toBeGreaterThanOrEqual(0.02 - EPSILON);
        for (const glass of layout.cabin.sideWindows) {
          const glassMinX = Math.abs(glass.center.x) - glass.size.x / 2;
          expect(bounds.min.x).toBeGreaterThan(glassMinX);
        }
      }
      expect(layout.anchors.snorkel.z).toBeCloseTo(layout.cabin.frontZ - 0.12, 6);
      disposeObject3D(built.group);
    }
  });

  it('builds mutually exclusive factory and fitted front assemblies', () => {
    for (const baseId of VEHICLE_BASE_IDS) {
      if (baseId === 'dustback-rs') continue;
      const catalog = VEHICLE_PART_CATALOGS[baseId];
      const factory = buildCarMesh(createStockBuild(baseId), true, 0);
      expect(factory.group.getObjectByName('front.factoryBumper')).toBeDefined();
      expect(factory.group.getObjectByName('front.barBeam')).toBeUndefined();
      disposeObject3D(factory.group);

      const fitted = buildCarMesh(fittedBuild(baseId, {
        frontBarId: catalog.frontBars[2]!.id,
        winchId: catalog.winches[1]!.id,
      }), true, 0);
      expect(fitted.group.getObjectByName('front.factoryBumper')).toBeUndefined();
      expect(fitted.group.getObjectByName('front.barBeam')).toBeDefined();
      expect(fitted.group.getObjectByName('front.winchDrum')).toBeDefined();
      disposeObject3D(fitted.group);
    }
  });

  it('lays out a low three-door Dustback cabin and rally-only attachments', () => {
    const catalog = VEHICLE_PART_CATALOGS['dustback-rs'];
    const build = fittedBuild('dustback-rs', {
      frontBarId: catalog.frontBars[2]!.id,
      roofId: catalog.roofs[1]!.id,
      rearBodyId: catalog.rearBodies[1]!.id,
    });
    const layout = createVehicleVisualLayout(build);
    const built = buildCarMesh(build, true, 0);
    expect(layout.style).toBe('rally');
    expect(layout.tray).toBeNull();
    expect(layout.seats).toHaveLength(4);
    expect(layout.cabin.roofY).toBeLessThan(createVehicleVisualLayout(createStockBuild('ridgeback')).cabin.roofY);
    expect(built.group.getObjectByName('rally.doorSeam.-1')).toBeDefined();
    expect(built.group.getObjectByName('rally.doorSeam.1')).toBeDefined();
    expect(built.group.getObjectByName('rally.lampPod')).toBeDefined();
    expect(built.group.getObjectByName('rally.roofVent')).toBeDefined();
    expect(built.group.getObjectByName('rally.ducktail')).toBeDefined();
    expect(built.group.getObjectByName('front.barBeam')).toBeUndefined();
    expect(built.group.getObjectByName('roof.platform')).toBeUndefined();
    expect(built.group.getObjectByName('snorkel.pipe')).toBeUndefined();
    expect(built.group.getObjectByName('rear.carrier')).toBeUndefined();
    disposeObject3D(built.group);
  });

  it('uses positioned anchors with locally authored accessory children', () => {
    const catalog = VEHICLE_PART_CATALOGS.longreach;
    const build = fittedBuild('longreach', {
      frontBarId: catalog.frontBars[2]!.id,
      winchId: catalog.winches[1]!.id,
      snorkelId: catalog.snorkels[1]!.id,
      roofId: catalog.roofs[2]!.id,
      rearBodyId: catalog.rearBodies[2]!.id,
    });
    const layout = createVehicleVisualLayout(build);
    const built = buildCarMesh(build, true, 0);
    const front = built.group.getObjectByName('attachment.frontBar')!;
    const roof = built.group.getObjectByName('attachment.roof')!;
    const snorkel = built.group.getObjectByName('attachment.snorkel')!;
    const rear = built.group.getObjectByName('attachment.rearBody')!;
    expect(front.position.z).toBeCloseTo(layout.extents.z, 6);
    expect(roof.position.y).toBeCloseTo(layout.roofSurface.center.y, 6);
    expect(snorkel.position.x).toBeGreaterThan(layout.cabin.size.x / 2);
    expect(rear.position.z).toBeCloseTo(-layout.extents.z, 6);
    expect(built.group.getObjectByName('front.barBeam')!.position.z).toBeLessThan(1);
    expect(built.group.getObjectByName('roof.platform')!.position.z).toBe(0);
    expect(built.group.getObjectByName('rear.carrier')!.position.z).toBeGreaterThan(-1);
    disposeObject3D(built.group);
  });
});
