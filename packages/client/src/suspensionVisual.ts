// Articulated undercarriage visuals for the procedural live-axle vehicles.
// These links deliberately consume the existing two-DOF axle pose; they do
// not add constraints or state to the physics model.

import * as THREE from 'three';
import { Physics, type VehicleBuild } from '@mydrunner/shared';
import { activeQuality, type QualitySettings } from './quality.js';

type Point = { x: number; y: number; z: number };

export interface SuspensionConnectorVisual {
  mesh: THREE.Mesh;
  chassisAnchor: THREE.Object3D;
  axleAnchor: THREE.Object3D;
}

export interface SuspensionVisual {
  connectors: readonly SuspensionConnectorVisual[];
  /** Re-align every connector after the axle groups have been posed. */
  update(): void;
}

interface SuspensionMaterials {
  arm: THREE.MeshStandardMaterial;
  rod: THREE.MeshStandardMaterial;
  bracket: THREE.MeshStandardMaterial;
  spring: THREE.MeshStandardMaterial;
  damper: THREE.MeshStandardMaterial;
}

const UP = new THREE.Vector3(0, 1, 0);

function vec(point: Point): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z);
}

function materialsFor(build: VehicleBuild): SuspensionMaterials {
  const touring = build.suspensionId.endsWith('.touring-50');
  const flex = build.suspensionId.endsWith('.flex-100');
  return {
    arm: new THREE.MeshStandardMaterial({ color: flex ? 0x34383b : 0x252729, roughness: 0.78, metalness: 0.35 }),
    rod: new THREE.MeshStandardMaterial({ color: 0x17191b, roughness: 0.72, metalness: 0.4 }),
    bracket: new THREE.MeshStandardMaterial({ color: 0x202224, roughness: 0.82, metalness: 0.28 }),
    spring: new THREE.MeshStandardMaterial({
      color: flex ? 0xd7a528 : touring ? 0x4b6f91 : 0x3a3d40,
      roughness: 0.58,
      metalness: 0.45,
    }),
    damper: new THREE.MeshStandardMaterial({
      color: flex ? 0xd65a36 : touring ? 0x3278ae : 0x34383c,
      roughness: 0.5,
      metalness: 0.52,
    }),
  };
}

/** A unit-height coil around local +Y. Scaling Y extends it between mounts.
 *
 *  At full detail this is ~640 triangles, four per truck, and they cast
 *  shadows — a lot of geometry for a spring that is mostly hidden behind a
 *  wheel. The reduced form halves the path samples and drops the tube to a
 *  triangular cross-section, which still reads as a coil at the distance the
 *  chase camera actually sits. */
function springGeometry(radius: number, detailed: boolean): THREE.TubeGeometry {
  const turns = 8;
  const perTurn = detailed ? 8 : 4;
  const samples = turns * perTurn;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const angle = t * turns * Math.PI * 2;
    points.push(new THREE.Vector3(
      Math.cos(angle) * radius,
      t - 0.5,
      Math.sin(angle) * radius,
    ));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), samples, 0.016, detailed ? 5 : 3, false);
}

function addAnchor(
  parent: THREE.Object3D,
  name: string,
  position: Point,
  bracketMaterial: THREE.Material,
): THREE.Object3D {
  const anchor = new THREE.Object3D();
  anchor.name = name;
  anchor.position.copy(vec(position));
  parent.add(anchor);

  const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.14), bracketMaterial);
  bracket.name = `${name}.mount`;
  bracket.castShadow = true;
  bracket.position.copy(anchor.position);
  parent.add(bracket);
  return anchor;
}

/**
 * Build front radius-arm and rear five-link location, plus coils and dampers.
 * Connector meshes live in chassis space while their axle endpoints live in
 * the moving axle groups, so update() is the only cross-frame operation.
 */
export function buildSuspensionVisual(
  chassis: THREE.Group,
  axles: [THREE.Group, THREE.Group],
  build: VehicleBuild,
  quality: QualitySettings = activeQuality(),
): SuspensionVisual {
  const geom = Physics.geomFor(build);
  const mats = materialsFor(build);
  const flex = build.suspensionId.endsWith('.flex-100');
  const touring = build.suspensionId.endsWith('.touring-50');
  const armRadius = flex ? 0.057 : touring ? 0.051 : 0.046;
  const armGeometry = new THREE.CylinderGeometry(armRadius, armRadius, 1, 10);
  const rodGeometry = new THREE.CylinderGeometry(0.032, 0.032, 1, 9);
  const damperGeometry = new THREE.CylinderGeometry(flex ? 0.052 : 0.046, flex ? 0.052 : 0.046, 1, 10);
  const springGeo = springGeometry(flex ? 0.105 : touring ? 0.098 : 0.09, quality.detailedSuspension);
  const connectors: SuspensionConnectorVisual[] = [];

  function connector(
    name: string,
    axle: THREE.Group,
    chassisPoint: Point,
    axlePoint: Point,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
  ): void {
    const chassisAnchor = addAnchor(chassis, `${name}.anchor.chassis`, chassisPoint, mats.bracket);
    const axleAnchor = addAnchor(axle, `${name}.anchor.axle`, axlePoint, mats.bracket);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    // 16 links per truck, all in the shadow depth pass. Tied to the tier's
    // shadow flag so it costs nothing extra to reason about.
    mesh.castShadow = quality.shadows;
    chassis.add(mesh);
    connectors.push({ mesh, chassisAnchor, axleAnchor });
  }

  const longitudinalSpan = Math.min(0.98, Math.max(0.74, geom.spec.wheelbase * 0.3));

  // Front: two long radius arms locate the beam longitudinally; a Panhard
  // rod locates it laterally. Mounts sit below the chassis rails so the
  // links remain visible without intersecting the body shell.
  const front = geom.front;
  for (const side of [-1, 1]) {
    connector(
      `suspension.front.radius.${side < 0 ? 'left' : 'right'}`,
      axles[0],
      { x: side * front.trackHalf * 0.53, y: front.centerLocalY - 0.10, z: front.centerLocalZ - longitudinalSpan },
      { x: side * front.trackHalf * 0.55, y: 0.035, z: -0.10 },
      armGeometry,
      mats.arm,
    );
  }
  connector(
    'suspension.front.panhard',
    axles[0],
    { x: -front.trackHalf * 0.68, y: front.centerLocalY - 0.08, z: front.centerLocalZ + 0.055 },
    { x: front.trackHalf * 0.68, y: 0.14, z: 0.055 },
    rodGeometry,
    mats.rod,
  );

  // Rear: parallel lower and upper trailing links plus a Panhard rod form
  // the familiar five-link live-axle layout used by touring 4x4s.
  const rear = geom.rear;
  for (const side of [-1, 1]) {
    connector(
      `suspension.rear.lower.${side < 0 ? 'left' : 'right'}`,
      axles[1],
      { x: side * rear.trackHalf * 0.54, y: rear.centerLocalY - 0.11, z: rear.centerLocalZ + longitudinalSpan },
      { x: side * rear.trackHalf * 0.57, y: 0.025, z: 0.11 },
      armGeometry,
      mats.arm,
    );
    connector(
      `suspension.rear.upper.${side < 0 ? 'left' : 'right'}`,
      axles[1],
      { x: side * rear.trackHalf * 0.25, y: rear.centerLocalY + 0.015, z: rear.centerLocalZ + longitudinalSpan * 0.72 },
      { x: side * rear.trackHalf * 0.34, y: 0.19, z: -0.045 },
      rodGeometry,
      mats.rod,
    );
  }
  connector(
    'suspension.rear.panhard',
    axles[1],
    { x: rear.trackHalf * 0.68, y: rear.centerLocalY - 0.08, z: rear.centerLocalZ - 0.055 },
    { x: -rear.trackHalf * 0.68, y: 0.14, z: -0.055 },
    rodGeometry,
    mats.rod,
  );

  // Both axles get paired coils and slightly inboard dampers. Their lower
  // anchors articulate with the beam; the top mounts remain chassis-fixed.
  for (let axleIndex = 0; axleIndex < 2; axleIndex++) {
    const axleGeom = axleIndex === 0 ? front : rear;
    const axleName = axleIndex === 0 ? 'front' : 'rear';
    const zLean = axleIndex === 0 ? -0.08 : 0.08;
    for (const side of [-1, 1]) {
      const sideName = side < 0 ? 'left' : 'right';
      connector(
        `suspension.${axleName}.spring.${sideName}`,
        axles[axleIndex]!,
        { x: side * axleGeom.trackHalf * 0.57, y: axleGeom.centerLocalY - 0.015, z: axleGeom.centerLocalZ },
        { x: side * axleGeom.trackHalf * 0.57, y: 0.12, z: 0 },
        springGeo,
        mats.spring,
      );
      connector(
        `suspension.${axleName}.damper.${sideName}`,
        axles[axleIndex]!,
        { x: side * axleGeom.trackHalf * 0.76, y: axleGeom.centerLocalY - 0.025, z: axleGeom.centerLocalZ + zLean },
        { x: side * axleGeom.trackHalf * 0.66, y: 0.025, z: -zLean },
        damperGeometry,
        mats.damper,
      );
    }
  }

  const startWorld = new THREE.Vector3();
  const endWorld = new THREE.Vector3();
  const startLocal = new THREE.Vector3();
  const endLocal = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const inverseChassis = new THREE.Matrix4();
  const midpoint = new THREE.Vector3();

  function update(): void {
    chassis.updateWorldMatrix(true, true);
    inverseChassis.copy(chassis.matrixWorld).invert();
    for (const item of connectors) {
      item.chassisAnchor.getWorldPosition(startWorld);
      item.axleAnchor.getWorldPosition(endWorld);
      startLocal.copy(startWorld).applyMatrix4(inverseChassis);
      endLocal.copy(endWorld).applyMatrix4(inverseChassis);
      direction.subVectors(endLocal, startLocal);
      const length = direction.length();
      if (!Number.isFinite(length) || length < 1e-5) {
        item.mesh.visible = false;
        continue;
      }
      item.mesh.visible = true;
      item.mesh.position.copy(midpoint.addVectors(startLocal, endLocal).multiplyScalar(0.5));
      item.mesh.quaternion.setFromUnitVectors(UP, direction.multiplyScalar(1 / length));
      item.mesh.scale.set(1, length, 1);
    }
  }

  update();
  return { connectors, update };
}
