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

const COMPONENT_NAMES = [
  'suspension.front.radius.left',
  'suspension.front.radius.right',
  'suspension.front.panhard',
  'suspension.front.spring.left',
  'suspension.front.spring.right',
  'suspension.front.damper.left',
  'suspension.front.damper.right',
  'suspension.rear.lower.left',
  'suspension.rear.lower.right',
  'suspension.rear.upper.left',
  'suspension.rear.upper.right',
  'suspension.rear.panhard',
  'suspension.rear.spring.left',
  'suspension.rear.spring.right',
  'suspension.rear.damper.left',
  'suspension.rear.damper.right',
] as const;

function withSuspension(baseId: VehicleBaseId, index: number): VehicleBuild {
  const build = createStockBuild(baseId);
  return { ...build, suspensionId: VEHICLE_PART_CATALOGS[baseId].suspension[index]!.id };
}

function connectorLength(build: VehicleBuild, name: string): number {
  const car = buildCarMesh(build, true, 0);
  car.suspension.update();
  const length = car.suspension.connectors.find((item) => item.mesh.name === name)!.mesh.scale.y;
  disposeObject3D(car.group);
  return length;
}

describe('articulated suspension visuals', () => {
  it('builds a complete live-axle layout for every base and suspension package', () => {
    for (const baseId of VEHICLE_BASE_IDS) {
      for (let suspensionIndex = 0; suspensionIndex < 3; suspensionIndex++) {
        const car = buildCarMesh(withSuspension(baseId, suspensionIndex), true, 0);
        expect(car.suspension.connectors).toHaveLength(COMPONENT_NAMES.length);
        for (const name of COMPONENT_NAMES) {
          expect(car.group.getObjectByName(name), `${baseId}: ${name}`).toBeDefined();
          expect(car.group.getObjectByName(`${name}.anchor.chassis`)).toBeDefined();
          expect(car.group.getObjectByName(`${name}.anchor.axle`)).toBeDefined();
        }
        for (const item of car.suspension.connectors) {
          expect(item.chassisAnchor.parent).toBe(car.group);
          expect(car.axles).toContain(item.axleAnchor.parent);
        }
        disposeObject3D(car.group);
      }
    }
  });

  it('keeps every connector joined to its mounts through compression and articulation', () => {
    const car = buildCarMesh(withSuspension('ridgeback', 2), true, 0);
    car.group.position.set(3, 1.4, -5);
    car.group.rotation.set(0.18, -0.31, 0.12);
    car.axles[0].position.y += 0.20;
    car.axles[0].rotation.z = 0.56;
    car.axles[1].position.y -= 0.15;
    car.axles[1].rotation.z = -0.56;
    car.suspension.update();

    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const center = new THREE.Vector3();
    const meshCenter = new THREE.Vector3();
    const linkDirection = new THREE.Vector3();
    const meshDirection = new THREE.Vector3();
    const meshRotation = new THREE.Quaternion();
    for (const item of car.suspension.connectors) {
      item.chassisAnchor.getWorldPosition(start);
      item.axleAnchor.getWorldPosition(end);
      item.mesh.getWorldPosition(meshCenter);
      center.addVectors(start, end).multiplyScalar(0.5);
      const length = start.distanceTo(end);
      expect(Number.isFinite(item.mesh.scale.y)).toBe(true);
      expect(item.mesh.scale.y).toBeGreaterThan(0);
      expect(item.mesh.scale.y).toBeCloseTo(length, 6);
      expect(meshCenter.distanceTo(center)).toBeLessThan(1e-6);

      linkDirection.subVectors(end, start).normalize();
      item.mesh.getWorldQuaternion(meshRotation);
      meshDirection.copy(new THREE.Vector3(0, 1, 0)).applyQuaternion(meshRotation).normalize();
      expect(meshDirection.dot(linkDirection)).toBeCloseTo(1, 6);
    }
    disposeObject3D(car.group);
  });

  it('gives lifted packages longer travel visuals and distinct hardware', () => {
    const factory = withSuspension('longreach', 0);
    const touring = withSuspension('longreach', 1);
    const flex = withSuspension('longreach', 2);
    expect(connectorLength(touring, 'suspension.front.spring.left'))
      .toBeGreaterThan(connectorLength(factory, 'suspension.front.spring.left'));
    expect(connectorLength(flex, 'suspension.front.spring.left'))
      .toBeGreaterThan(connectorLength(touring, 'suspension.front.spring.left'));

    const cars = [factory, touring, flex].map((build) => buildCarMesh(build, true, 0));
    const damperColors = cars.map((car) => {
      const mesh = car.group.getObjectByName('suspension.front.damper.left') as THREE.Mesh;
      return (mesh.material as THREE.MeshStandardMaterial).color.getHex();
    });
    expect(new Set(damperColors).size).toBe(3);
    const factoryArm = cars[0]!.group.getObjectByName('suspension.front.radius.left') as THREE.Mesh;
    const flexArm = cars[2]!.group.getObjectByName('suspension.front.radius.left') as THREE.Mesh;
    expect((flexArm.geometry as THREE.CylinderGeometry).parameters.radiusTop)
      .toBeGreaterThan((factoryArm.geometry as THREE.CylinderGeometry).parameters.radiusTop);
    for (const car of cars) disposeObject3D(car.group);
  });
});
