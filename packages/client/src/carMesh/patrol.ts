// Nissan-Patrol-GQ-style boxy 4x4: full SUV cabin, roof rack, snorkel,
// bullbar, rear spare wheel.

import * as THREE from 'three';
import { VEHICLE } from '@mydrunner/shared';
import type { Materials } from './shared.js';

export const PATROL_COLORS = [
  0xd9531e, // burnt orange (local default)
  0x2a4a6a, // navy
  0x466b3a, // olive
  0xc9b86b, // sand
  0x8b4513, // saddle brown
  0xb23a48, // brick red
];

export function buildPatrolBody(group: THREE.Group, ext: typeof VEHICLE.chassisHalfExtents, mats: Materials): void {
  // Cabin - tall and upright, almost as wide as body, flat top. Sits on the
  // rear 75% of the body (Patrol has a short hood).
  const cabinLen = ext.z * 1.25;
  const cabinHeight = ext.y * 1.7;
  const cabinWide = ext.x * 1.93;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(cabinWide, cabinHeight, cabinLen), mats.body);
  cabin.position.set(0, ext.y + cabinHeight / 2, -ext.z * 0.25);
  cabin.castShadow = true;
  group.add(cabin);

  // Big square windows wrapping the cabin.
  const winThickness = 0.025;
  const winH = cabinHeight * 0.6;
  const winYCenter = ext.y + cabinHeight / 2 + cabinHeight * 0.05;
  for (const sign of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(winThickness, winH, cabinLen * 0.85), mats.glass);
    win.position.set(sign * (cabinWide / 2 + winThickness / 2), winYCenter, -ext.z * 0.25);
    group.add(win);
  }
  for (const [sign, slope] of [[1, -0.07], [-1, 0.07]] as const) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(cabinWide * 0.92, winH, winThickness), mats.glass);
    win.position.set(0, winYCenter, -ext.z * 0.25 + sign * (cabinLen / 2 + winThickness / 2));
    win.rotation.x = slope;
    group.add(win);
  }

  // Bullbar - thick horizontal pipe across the front with two vertical posts.
  const barRadius = 0.05;
  const barLen = ext.x * 1.7;
  const barHorizontal = new THREE.Mesh(new THREE.CylinderGeometry(barRadius, barRadius, barLen, 10), mats.black);
  barHorizontal.rotation.z = Math.PI / 2;
  barHorizontal.position.set(0, -ext.y * 0.1, ext.z + 0.18);
  barHorizontal.castShadow = true;
  group.add(barHorizontal);
  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(barRadius * 0.9, barRadius * 0.9, ext.y * 1.0, 8), mats.black);
    post.position.set(sign * ext.x * 0.55, -ext.y * 0.4, ext.z + 0.18);
    post.castShadow = true;
    group.add(post);
  }
  const upperBar = new THREE.Mesh(new THREE.CylinderGeometry(barRadius * 0.85, barRadius * 0.85, barLen * 0.6, 10), mats.black);
  upperBar.rotation.z = Math.PI / 2;
  upperBar.position.set(0, ext.y * 0.3, ext.z + 0.18);
  group.add(upperBar);

  // Round headlights set behind the bullbar.
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d2, emissive: 0xffd070, emissiveIntensity: 0.6 });
  for (const sign of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 14), headlightMat);
    hl.rotation.x = Math.PI / 2;
    hl.position.set(sign * ext.x * 0.55, -ext.y * 0.05, ext.z + 0.04);
    group.add(hl);
  }
  // Vertical chrome grille slats.
  for (let i = -2; i <= 2; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(0.035, ext.y * 0.45, 0.04), mats.chrome);
    slat.position.set(i * 0.07, -ext.y * 0.05, ext.z + 0.025);
    group.add(slat);
  }

  // Tall vertical tail lights.
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa31818, emissive: 0xa31818, emissiveIntensity: 0.4 });
  for (const sign of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.18, ext.y * 0.85, 0.04), tailMat);
    tl.position.set(sign * ext.x * 0.78, ext.y * 0.1, -ext.z - 0.03);
    group.add(tl);
  }
  // Rear spare wheel mount.
  const spareMount = new THREE.Mesh(
    new THREE.CylinderGeometry(VEHICLE.wheelRadius * 0.95, VEHICLE.wheelRadius * 0.95, 0.18, 18),
    new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.95 }),
  );
  spareMount.rotation.x = Math.PI / 2;
  spareMount.position.set(0, 0.05, -ext.z - 0.18);
  spareMount.castShadow = true;
  group.add(spareMount);

  // Roof rack with rails.
  const rackMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });
  const rackBase = new THREE.Mesh(new THREE.BoxGeometry(cabinWide * 0.92, 0.04, cabinLen * 0.9), rackMat);
  rackBase.position.set(0, ext.y + cabinHeight + 0.05, -ext.z * 0.25);
  rackBase.castShadow = true;
  group.add(rackBase);
  for (const sign of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, cabinLen * 0.9), rackMat);
    rail.position.set(sign * cabinWide * 0.45, ext.y + cabinHeight + 0.10, -ext.z * 0.25);
    group.add(rail);
  }

  // Snorkel up the right A-pillar.
  const snorkelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
  const snorkel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, cabinHeight * 1.1, 10), snorkelMat);
  snorkel.position.set(cabinWide / 2 - 0.03, ext.y + cabinHeight / 2, -ext.z * 0.25 + cabinLen / 2 - 0.1);
  group.add(snorkel);
  const snorkelHead = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.18), snorkelMat);
  snorkelHead.position.set(cabinWide / 2 - 0.03, ext.y + cabinHeight + 0.05, -ext.z * 0.25 + cabinLen / 2 - 0.1);
  group.add(snorkelHead);
}
