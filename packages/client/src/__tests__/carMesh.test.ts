import { describe, expect, it } from 'vitest';
import { VEHICLE_BASE_IDS, VEHICLE_PART_CATALOGS, createStockBuild } from '@mydrunner/shared';
import { buildCarMesh } from '../carMesh.js';
import { disposeObject3D } from '../three/dispose.js';

describe('vehicle-specific fitted visuals', () => {
  it('builds every production base with four physics-driven wheel children', () => {
    for (const baseId of VEHICLE_BASE_IDS) {
      const mesh = buildCarMesh(createStockBuild(baseId), true, 0);
      expect(mesh.group.name).toBe(`vehicle.${baseId}`);
      expect(mesh.wheels).toHaveLength(4);
      expect(mesh.axles).toHaveLength(2);
      expect(mesh.wheels.every((wheel) => mesh.axles.some((axle) => wheel.parent === axle))).toBe(true);
      disposeObject3D(mesh.group);
    }
  });

  it('fits only accessories selected by the normalized build', () => {
    const stock = buildCarMesh(createStockBuild('longreach'), true, 0);
    expect(stock.group.getObjectByName('attachment.frontBar')!.children).toHaveLength(0);
    expect(stock.group.getObjectByName('attachment.roof')!.children).toHaveLength(0);
    expect(stock.group.getObjectByName('attachment.snorkel')!.children).toHaveLength(0);
    expect(stock.group.getObjectByName('attachment.rearBody')!.children).toHaveLength(0);
    disposeObject3D(stock.group);

    const catalog = VEHICLE_PART_CATALOGS.longreach;
    const fitted = buildCarMesh({
      ...createStockBuild('longreach'),
      suspensionId: catalog.suspension[2]!.id,
      tireId: catalog.tires[3]!.id,
      wheelId: catalog.wheels[2]!.id,
      frontBarId: catalog.frontBars[2]!.id,
      winchId: catalog.winches[1]!.id,
      snorkelId: catalog.snorkels[1]!.id,
      roofId: catalog.roofs[2]!.id,
      rearBodyId: catalog.rearBodies[2]!.id,
    }, true, 0);
    expect(fitted.group.getObjectByName('attachment.frontBar')!.children.length).toBeGreaterThanOrEqual(4);
    expect(fitted.group.getObjectByName('attachment.roof')!.children.length).toBeGreaterThanOrEqual(2);
    expect(fitted.group.getObjectByName('attachment.snorkel')!.children).toHaveLength(2);
    expect(fitted.group.getObjectByName('attachment.rearBody')!.children.length).toBeGreaterThanOrEqual(4);
    disposeObject3D(fitted.group);
  });
});
