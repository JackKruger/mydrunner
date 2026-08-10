import * as THREE from 'three';
import type { Physics } from '@mydrunner/shared';

const FORCE_SCALE = 1 / 5_000;
const SUPPORT_ORDER = [0, 1, 3, 2] as const;

function utilizationColor(value: number): THREE.Color {
  const t = Math.max(0, Math.min(1, value));
  if (t < 0.65) return new THREE.Color().lerpColors(
    new THREE.Color(0x45e68a), new THREE.Color(0xffd34e), t / 0.65,
  );
  return new THREE.Color().lerpColors(
    new THREE.Color(0xffd34e), new THREE.Color(0xff4f45), (t - 0.65) / 0.35,
  );
}

function pointInPolygon(x: number, z: number, points: readonly THREE.Vector3[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if (((a.z > z) !== (b.z > z))
      && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** World-space instrumentation for the locally owned vehicle.
 *
 * Yellow is the build-resolved centre of mass, the vertical line is gravity's
 * projection, cyan is the current contact support polygon, and each contact
 * arrow is the tangential force the tire solver transmitted this tick. */
export class VehicleDebugView {
  readonly group = new THREE.Group();
  private readonly com: THREE.Mesh;
  private readonly projection: THREE.Mesh;
  private readonly gravityGeometry = new THREE.BufferGeometry();
  private readonly gravityMaterial = new THREE.LineBasicMaterial({
    color: 0x45e68a, depthTest: false, transparent: true, opacity: 0.95,
  });
  private readonly gravityLine: THREE.Line;
  private readonly supportGeometry = new THREE.BufferGeometry();
  private readonly supportLine: THREE.LineLoop;
  private readonly supportPositions = new Float32Array(4 * 3);
  private readonly contactMarkers: THREE.Mesh[] = [];
  private readonly forceArrows: THREE.ArrowHelper[] = [];
  private readonly suspensionLines: THREE.Line[] = [];
  private readonly suspensionPositions: Float32Array[] = [];
  private readonly buoyancyArrow: THREE.ArrowHelper;
  private readonly dragArrow: THREE.ArrowHelper;
  private readonly supportPoints: THREE.Vector3[] = [];
  private readonly direction = new THREE.Vector3();

  constructor() {
    this.group.name = 'vehicle-dev-telemetry';
    this.group.renderOrder = 1000;

    const comMaterial = new THREE.MeshBasicMaterial({ color: 0xffdf48, depthTest: false });
    this.com = new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 1), comMaterial);
    this.com.renderOrder = 1001;
    this.group.add(this.com);

    this.projection = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.035, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0x45e68a, depthTest: false }),
    );
    this.projection.rotation.x = Math.PI / 2;
    this.projection.renderOrder = 1001;
    this.group.add(this.projection);

    this.gravityGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.gravityLine = new THREE.Line(this.gravityGeometry, this.gravityMaterial);
    this.gravityLine.renderOrder = 1000;
    this.group.add(this.gravityLine);

    this.supportGeometry.setAttribute('position', new THREE.BufferAttribute(this.supportPositions, 3));
    this.supportLine = new THREE.LineLoop(
      this.supportGeometry,
      new THREE.LineBasicMaterial({ color: 0x55e9ff, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.supportLine.renderOrder = 1000;
    this.group.add(this.supportLine);

    for (let i = 0; i < 4; i++) {
      const suspensionPosition = new Float32Array(6);
      const suspensionGeometry = new THREE.BufferGeometry();
      suspensionGeometry.setAttribute('position', new THREE.BufferAttribute(suspensionPosition, 3));
      const suspensionLine = new THREE.Line(
        suspensionGeometry,
        new THREE.LineBasicMaterial({ color: 0x9d72ff, depthTest: false, transparent: true, opacity: 0.8 }),
      );
      suspensionLine.renderOrder = 1000;
      this.suspensionPositions.push(suspensionPosition);
      this.suspensionLines.push(suspensionLine);
      this.group.add(suspensionLine);

      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x55e9ff, depthTest: false }),
      );
      marker.renderOrder = 1001;
      this.contactMarkers.push(marker);
      this.group.add(marker);

      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.01, 0x45e68a, 0.18, 0.1,
      );
      (arrow.line.material as THREE.Material).depthTest = false;
      (arrow.cone.material as THREE.Material).depthTest = false;
      arrow.renderOrder = 1002;
      this.forceArrows.push(arrow);
      this.group.add(arrow);
    }

    this.buoyancyArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.01, 0x29a8ff, 0.24, 0.14,
    );
    this.dragArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.01, 0xd26cff, 0.24, 0.14,
    );
    for (const arrow of [this.buoyancyArrow, this.dragArrow]) {
      (arrow.line.material as THREE.Material).depthTest = false;
      (arrow.cone.material as THREE.Material).depthTest = false;
      arrow.renderOrder = 1002;
      arrow.visible = false;
      this.group.add(arrow);
    }
  }

  update(telemetry: Physics.VehicleDebugTelemetry): void {
    const com = telemetry.centerOfMassWorld;
    this.com.position.set(com.x, com.y, com.z);
    this.supportPoints.length = 0;

    for (const index of SUPPORT_ORDER) {
      const wheel = telemetry.wheels[index]!;
      const marker = this.contactMarkers[index]!;
      const arrow = this.forceArrows[index]!;
      const suspensionLine = this.suspensionLines[index]!;
      const suspensionPosition = this.suspensionPositions[index]!;
      const origin = wheel.suspensionOrigin;
      const end = wheel.suspensionEnd;
      suspensionPosition[0] = origin.x;
      suspensionPosition[1] = origin.y;
      suspensionPosition[2] = origin.z;
      suspensionPosition[3] = end.x;
      suspensionPosition[4] = end.y;
      suspensionPosition[5] = end.z;
      (suspensionLine.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (suspensionLine.material as THREE.LineBasicMaterial).color.setHex(wheel.contact ? 0x9d72ff : 0xff596d);
      suspensionLine.visible = wheel.suspensionRestLength > 0;
      marker.visible = wheel.contact;
      arrow.visible = wheel.contact;
      if (!wheel.contact) continue;

      const cp = wheel.contactPoint;
      marker.position.set(cp.x, cp.y + 0.035, cp.z);
      const loadScale = Math.max(0.7, Math.min(1.8, wheel.normalLoad / 5_000));
      marker.scale.setScalar(loadScale);
      this.supportPoints.push(new THREE.Vector3(cp.x, cp.y + 0.04, cp.z));

      this.direction.set(wheel.force.x, wheel.force.y, wheel.force.z);
      const magnitude = this.direction.length();
      if (magnitude > 1e-4) {
        this.direction.multiplyScalar(1 / magnitude);
        arrow.position.set(cp.x, cp.y + 0.08, cp.z);
        arrow.setDirection(this.direction);
        const length = Math.max(0.12, Math.min(3, magnitude * FORCE_SCALE));
        arrow.setLength(length, Math.min(0.24, length * 0.32), Math.min(0.13, length * 0.2));
        arrow.setColor(utilizationColor(wheel.utilization));
      } else {
        arrow.visible = false;
      }
    }

    // Ordering by angle keeps the polygon valid when a wheel is airborne and
    // the four-contact rectangle becomes a three-contact support triangle.
    if (this.supportPoints.length >= 3) {
      const cx = this.supportPoints.reduce((sum, p) => sum + p.x, 0) / this.supportPoints.length;
      const cz = this.supportPoints.reduce((sum, p) => sum + p.z, 0) / this.supportPoints.length;
      this.supportPoints.sort((a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx));
    }
    for (let i = 0; i < this.supportPoints.length; i++) {
      const point = this.supportPoints[i]!;
      this.supportPositions[i * 3] = point.x;
      this.supportPositions[i * 3 + 1] = point.y;
      this.supportPositions[i * 3 + 2] = point.z;
    }
    this.supportGeometry.setDrawRange(0, this.supportPoints.length);
    this.supportGeometry.attributes.position!.needsUpdate = true;
    this.supportLine.visible = this.supportPoints.length >= 2;

    const supportY = this.supportPoints.length > 0
      ? this.supportPoints.reduce((sum, p) => sum + p.y, 0) / this.supportPoints.length
      : telemetry.position.y - telemetry.wheelRadius;
    const stable = this.supportPoints.length >= 3
      && pointInPolygon(com.x, com.z, this.supportPoints);
    const stateColor = stable ? 0x45e68a : 0xff4f45;
    this.gravityMaterial.color.setHex(stateColor);
    (this.projection.material as THREE.MeshBasicMaterial).color.setHex(stateColor);
    this.projection.position.set(com.x, supportY + 0.03, com.z);
    const gravityPositions = this.gravityGeometry.attributes.position as THREE.BufferAttribute;
    gravityPositions.setXYZ(0, com.x, com.y, com.z);
    gravityPositions.setXYZ(1, com.x, supportY + 0.03, com.z);
    gravityPositions.needsUpdate = true;

    this.updateForceArrow(
      this.buoyancyArrow,
      telemetry.water.buoyancyPoint,
      telemetry.water.buoyancyForce,
      1 / 10_000,
    );
    this.updateForceArrow(
      this.dragArrow,
      telemetry.water.dragPoint,
      telemetry.water.dragForce,
      1 / 8_000,
    );
  }

  private updateForceArrow(
    arrow: THREE.ArrowHelper,
    point: { x: number; y: number; z: number },
    force: { x: number; y: number; z: number },
    scale: number,
  ): void {
    this.direction.set(force.x, force.y, force.z);
    const magnitude = this.direction.length();
    arrow.visible = magnitude > 5;
    if (!arrow.visible) return;
    this.direction.multiplyScalar(1 / magnitude);
    arrow.position.set(point.x, point.y, point.z);
    arrow.setDirection(this.direction);
    const length = Math.max(0.15, Math.min(4, magnitude * scale));
    arrow.setLength(length, Math.min(0.3, length * 0.3), Math.min(0.16, length * 0.18));
  }
}
