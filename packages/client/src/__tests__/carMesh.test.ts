import { describe, expect, it } from 'vitest';
import { VEHICLE_BASE_IDS, VEHICLE_PART_CATALOGS, createStockBuild } from '@mydrunner/shared';
import * as THREE from 'three';
import { buildCarMesh } from '../carMesh.js';
import { disposeObject3D } from '../three/dispose.js';
import { setQualityTier } from '../quality.js';

describe('vehicle-specific fitted visuals', () => {
  it('builds every production base with four physics-driven wheel children', () => {
    for (const baseId of VEHICLE_BASE_IDS) {
      const mesh = buildCarMesh(createStockBuild(baseId), true, 0);
      expect(mesh.group.name).toBe(`vehicle.${baseId}`);
      expect(mesh.wheels).toHaveLength(4);
      expect(mesh.axles).toHaveLength(2);
      expect(mesh.recovery.fairlead.name).toBe('recovery.fairlead');
      expect(mesh.recovery.front.position.z).toBeGreaterThan(0);
      expect(mesh.recovery.rear.position.z).toBeLessThan(0);
      expect(mesh.wheels.every((wheel) => mesh.axles.some((axle) => wheel.parent === axle))).toBe(true);
      disposeObject3D(mesh.group);
    }
  });

  it('uses rounded differential pumpkins on both live axles', () => {
    const car = buildCarMesh(createStockBuild('ridgeback'), true, 0);

    for (const axle of ['front', 'rear']) {
      const differential = car.group.getObjectByName(`axle.${axle}.differential`) as THREE.Mesh;
      expect(differential).toBeInstanceOf(THREE.Mesh);
      expect(differential.geometry).toBeInstanceOf(THREE.SphereGeometry);
    }

    disposeObject3D(car.group);
  });

  it('keeps rigid rims beside four deformable carcasses with shadow deformation', () => {
    setQualityTier('high');
    const car = buildCarMesh(createStockBuild('ridgeback'), true, 0);
    expect(car.tires).toHaveLength(4);
    for (const tire of car.tires) {
      expect(tire.mesh.name).toBe('wheel.deformableCarcass');
      expect(tire.mesh.customDepthMaterial).toBeInstanceOf(THREE.MeshDepthMaterial);
      expect(tire.mesh.customDistanceMaterial).toBeInstanceOf(THREE.MeshDistanceMaterial);
      tire.update(0.02, new THREE.Vector3(0, 1, 0));
      const shader = {
        uniforms: {},
        vertexShader: '#include <common>\n#include <begin_vertex>',
        fragmentShader: '#include <common>\n#include <color_fragment>',
      };
      (tire.mesh.material as THREE.MeshStandardMaterial).onBeforeCompile(
        shader as never,
        {} as THREE.WebGLRenderer,
      );
      expect(shader.vertexShader).toContain('tireContactNormal');
      expect(shader.fragmentShader).toContain('tireBlocks');
      const rim = tire.mesh.parent!.children.find((child) => child !== tire.mesh) as THREE.Mesh;
      expect(rim.customDepthMaterial).toBeUndefined();
    }
    disposeObject3D(car.group);
  });

  it('retains tyre deformation geometry at low quality with fewer subdivisions', () => {
    setQualityTier('high');
    const high = buildCarMesh(createStockBuild('ridgeback'), true, 0);
    const highVertices = high.tires[0]!.mesh.geometry.getAttribute('position').count;
    disposeObject3D(high.group);
    setQualityTier('low');
    const low = buildCarMesh(createStockBuild('ridgeback'), true, 0);
    const lowVertices = low.tires[0]!.mesh.geometry.getAttribute('position').count;
    expect(lowVertices).toBeLessThan(highVertices);
    expect(low.tires).toHaveLength(4);
    disposeObject3D(low.group);
    setQualityTier('high');
  });

  it('fits only accessories selected by the normalized build', () => {
    const stock = buildCarMesh(createStockBuild('longreach'), true, 0);
    expect(stock.group.getObjectByName('attachment.frontBar')!.children).toHaveLength(1);
    expect(stock.group.getObjectByName('front.factoryBumper')).toBeDefined();
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
    expect(fitted.group.getObjectByName('attachment.snorkel')!.children).toHaveLength(3);
    expect(fitted.group.getObjectByName('attachment.rearBody')!.children.length).toBeGreaterThanOrEqual(4);
    expect(fitted.group.getObjectByName('front.factoryBumper')).toBeUndefined();
    expect(fitted.group.getObjectByName('roof.platform')).toBeDefined();
    expect(fitted.group.getObjectByName('snorkel.pipe')).toBeDefined();
    disposeObject3D(fitted.group);
  });

  it('renders the Outclaw as an exposed tube crawler on wide axles', () => {
    const crawler = buildCarMesh(createStockBuild('outclaw'), true, 0);
    expect(crawler.group.getObjectByName('crawler.skid')).toBeDefined();
    expect(crawler.group.getObjectByName('crawler.roofRail.-1')).toBeDefined();
    expect(crawler.group.getObjectByName('crawler.roofRail.1')).toBeDefined();
    expect(crawler.group.getObjectByName('body.cabin')).toBeUndefined();
    expect(Math.abs(crawler.wheels[0]!.position.x)).toBeGreaterThan(1);
    disposeObject3D(crawler.group);
  });

  it('renders the Dustback as a compact rally hatch without 4x4 equipment', () => {
    const catalog = VEHICLE_PART_CATALOGS['dustback-rs'];
    const rally = buildCarMesh({
      ...createStockBuild('dustback-rs'),
      frontBarId: catalog.frontBars[1]!.id,
      roofId: catalog.roofs[2]!.id,
      rearBodyId: catalog.rearBodies[2]!.id,
    }, true, 0);
    expect(rally.wheels).toHaveLength(4);
    expect(rally.group.getObjectByName('rally.lowerBody')).toBeDefined();
    expect(rally.group.getObjectByName('rally.squareLamp.-1')).toBeDefined();
    expect(rally.group.getObjectByName('rally.sumpGuard')).toBeDefined();
    expect(rally.group.getObjectByName('rally.antenna')).toBeDefined();
    expect(rally.group.getObjectByName('rally.internalSpare')).toBeDefined();
    expect(rally.group.getObjectByName('front.winchDrum')).toBeUndefined();
    expect(rally.group.getObjectByName('snorkel.pipe')).toBeUndefined();
    disposeObject3D(rally.group);
  });
});
