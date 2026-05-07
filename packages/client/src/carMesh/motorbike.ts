// Dual-sport bike: thin frame, fuel tank, seat, handlebars, two visible
// wheels (overlapped per axle at chassis centre by buildAxles).

import * as THREE from 'three';
import { VEHICLE } from '@mydrunner/shared';
import type { Materials } from './shared.js';

export const MOTORBIKE_COLORS = [
  0x2a8acb, // electric blue (local default)
  0x111111, // satin black
  0xd11a1a, // rally red
  0x1a8c3a, // racing green
  0xefa61c, // amber
  0x9b2cd1, // ultraviolet
];

export function buildMotorbikeBody(group: THREE.Group, ext: typeof VEHICLE.chassisHalfExtents, mats: Materials): void {
  // Bike silhouette built along the chassis centreline. The wide chassis
  // collider is shared (physics is identical across kinds), so the visual
  // intentionally does NOT draw the full chassis box - we draw only the
  // bike frame, tank, seat, and handlebars at the centreline. The two
  // visible wheels are placed by buildAxles with x=0 overlap.
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.4 });

  // Lower frame backbone: a thin rail from front to rear at chassis
  // bottom edge.
  const backbone = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.10, ext.z * 1.7), frameMat);
  backbone.position.set(0, -ext.y + 0.08, 0);
  backbone.castShadow = true;
  group.add(backbone);

  // Fuel tank: teardrop-ish (use a stretched box) above the front-mid
  // section in body colour.
  const tankLen = ext.z * 0.55;
  const tankHeight = ext.y * 0.65;
  const tankWidth = 0.30;
  const tank = new THREE.Mesh(new THREE.BoxGeometry(tankWidth, tankHeight, tankLen), mats.body);
  tank.position.set(0, ext.y * 0.25, ext.z * 0.15);
  tank.castShadow = true;
  group.add(tank);

  // Seat: a longer dark slab behind the tank.
  const seatLen = ext.z * 0.55;
  const seatHeight = 0.12;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.32, seatHeight, seatLen), mats.trim);
  seat.position.set(0, ext.y * 0.55, -ext.z * 0.18);
  seat.castShadow = true;
  group.add(seat);

  // Tail / rear fender + tail light cluster at the very back.
  const tailFender = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.10, 0.40), mats.body);
  tailFender.position.set(0, ext.y * 0.55, -ext.z * 0.78);
  group.add(tailFender);
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa31818, emissive: 0xa31818, emissiveIntensity: 0.5 });
  const tailLight = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.03), tailMat);
  tailLight.position.set(0, ext.y * 0.55, -ext.z * 0.96);
  group.add(tailLight);

  // Front fork: two thin posts running from the front-axle area up to the
  // headstock above the tank. Slight rake.
  const forkRad = 0.025;
  const forkLen = ext.y * 1.6;
  for (const sign of [-1, 1]) {
    const fork = new THREE.Mesh(new THREE.CylinderGeometry(forkRad, forkRad, forkLen, 10), frameMat);
    fork.position.set(sign * 0.10, ext.y * 0.15, ext.z * 0.85);
    fork.rotation.x = -0.18;
    fork.castShadow = true;
    group.add(fork);
  }

  // Headstock + headlight cowl at the top of the forks.
  const headstockY = ext.y * 0.95;
  const headstockZ = ext.z * 0.97;
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.18), mats.body);
  cowl.position.set(0, headstockY, headstockZ);
  cowl.castShadow = true;
  group.add(cowl);
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d2, emissive: 0xffd070, emissiveIntensity: 0.7 });
  const headlight = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 14), headlightMat);
  headlight.rotation.x = Math.PI / 2;
  headlight.position.set(0, headstockY, headstockZ + 0.10);
  group.add(headlight);

  // Handlebars: a wide horizontal bar across the headstock, with two
  // grip stubs at the ends.
  const barLen = 0.70;
  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, barLen, 10), frameMat);
  bars.rotation.z = Math.PI / 2;
  bars.position.set(0, headstockY + 0.14, headstockZ - 0.04);
  group.add(bars);
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
  for (const sign of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.10, 10), gripMat);
    grip.rotation.z = Math.PI / 2;
    grip.position.set(sign * (barLen / 2 - 0.05), headstockY + 0.14, headstockZ - 0.04);
    group.add(grip);
  }

  // Engine block: a chunky dark box slung beneath the tank between the
  // wheels.
  const engine = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.50), mats.black);
  engine.position.set(0, -ext.y * 0.15, 0);
  engine.castShadow = true;
  group.add(engine);

  // Exhaust: a short chrome cylinder along the right side, sloping up
  // toward the rear.
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 12), mats.chrome);
  exhaust.rotation.x = Math.PI / 2;
  exhaust.rotation.y = -0.05;
  exhaust.position.set(0.18, -ext.y * 0.05, -ext.z * 0.45);
  group.add(exhaust);
}
