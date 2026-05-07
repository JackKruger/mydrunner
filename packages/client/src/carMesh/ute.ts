// Falcon-style sedan-based ute: low cabin, flat open tray, sport bar over
// the tray, no canopy.

import * as THREE from 'three';
import { VEHICLE } from '@mydrunner/shared';
import type { Materials } from './shared.js';

export const UTE_COLORS = [
  0xf2c200, // canary yellow (local default)
  0x1a1a1a, // jet black
  0xb91212, // racing red
  0x2d4a8a, // royal blue
  0x6f7a85, // gunmetal
  0xd87b1c, // burnt amber
];

export function buildUteBody(group: THREE.Group, ext: typeof VEHICLE.chassisHalfExtents, mats: Materials): void {
  // Sedan-based ute: low, sleek cabin in the front 45% of the body, then
  // a flat open tray with side walls and a sport bar. No canopy.
  const cabinLen = ext.z * 0.85;
  const cabinHeight = ext.y * 1.35;     // lower than Hilux (1.55) - sedan-like
  const cabinWide = ext.x * 1.84;
  const cabinCenterZ = ext.z * 0.5;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(cabinWide, cabinHeight, cabinLen), mats.body);
  cabin.position.set(0, ext.y + cabinHeight / 2, cabinCenterZ);
  cabin.castShadow = true;
  group.add(cabin);

  // Glass: side windows + raked windshield + sloped rear cab glass.
  const winThickness = 0.025;
  const winH = cabinHeight * 0.55;
  const winYCenter = ext.y + cabinHeight / 2 + cabinHeight * 0.08;
  for (const sign of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(winThickness, winH, cabinLen * 0.8), mats.glass);
    win.position.set(sign * (cabinWide / 2 + winThickness / 2), winYCenter, cabinCenterZ);
    group.add(win);
  }
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(cabinWide * 0.94, winH, winThickness), mats.glass);
  windshield.position.set(0, winYCenter, cabinCenterZ + cabinLen / 2 + winThickness / 2);
  windshield.rotation.x = -0.22;        // sleeker rake than the Hilux
  group.add(windshield);
  const rearCabGlass = new THREE.Mesh(new THREE.BoxGeometry(cabinWide * 0.88, winH * 0.85, winThickness), mats.glass);
  rearCabGlass.position.set(0, winYCenter, cabinCenterZ - cabinLen / 2 - winThickness / 2);
  rearCabGlass.rotation.x = 0.18;
  group.add(rearCabGlass);

  // Open tray: low side walls along the rear half, no canopy. Tailgate
  // sits at the back edge of the body. Floor is the lower body box.
  const trayStartZ = cabinCenterZ - cabinLen / 2;
  const trayEndZ = -ext.z;
  const trayLen = trayStartZ - trayEndZ;
  const trayCenterZ = (trayStartZ + trayEndZ) / 2;
  const wallH = ext.y * 0.45;
  const wallY = ext.y + wallH / 2;
  const trayFront = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.92, wallH, 0.06), mats.body);
  trayFront.position.set(0, wallY, trayStartZ - 0.03);
  group.add(trayFront);
  const tailgate = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.92, wallH * 0.95, 0.06), mats.body);
  tailgate.position.set(0, wallY - wallH * 0.025, trayEndZ + 0.03);
  group.add(tailgate);
  for (const sign of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.06, wallH, trayLen), mats.body);
    wall.position.set(sign * ext.x * 0.96, wallY, trayCenterZ);
    group.add(wall);
  }

  // Sport bar (chrome roll-bar over the front of the tray) - the
  // signature ute styling cue.
  const barRadius = 0.05;
  const barTopY = ext.y + cabinHeight * 0.85;
  const barTopWidth = ext.x * 1.55;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(barRadius, barRadius, barTopWidth, 10), mats.chrome);
  top.rotation.z = Math.PI / 2;
  top.position.set(0, barTopY, trayStartZ - 0.05);
  top.castShadow = true;
  group.add(top);
  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(barRadius * 0.95, barRadius * 0.95, barTopY - (ext.y + wallH), 10),
      mats.chrome,
    );
    post.position.set(sign * (barTopWidth / 2), (barTopY + ext.y + wallH) / 2, trayStartZ - 0.05);
    post.castShadow = true;
    group.add(post);
  }

  // Low-profile nudge bar across the front (no upper loop, sits under
  // the bonnet line - sportier than the Patrol's bullbar).
  const nudgeLen = ext.x * 1.65;
  const nudge = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, nudgeLen, 10), mats.chrome);
  nudge.rotation.z = Math.PI / 2;
  nudge.position.set(0, -ext.y * 0.2, ext.z + 0.14);
  nudge.castShadow = true;
  group.add(nudge);

  // Slim rectangular headlights flush with the front fascia.
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d2, emissive: 0xffd070, emissiveIntensity: 0.55 });
  for (const sign of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.10, 0.04), headlightMat);
    hl.position.set(sign * ext.x * 0.5, ext.y * 0.05, ext.z + 0.025);
    group.add(hl);
  }
  // Wide grille slot.
  const grille = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.0, 0.14, 0.04), mats.trim);
  grille.position.set(0, -ext.y * 0.12, ext.z + 0.025);
  group.add(grille);

  // Horizontal tail lights inset on the tailgate.
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa31818, emissive: 0xa31818, emissiveIntensity: 0.4 });
  for (const sign of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.14, 0.04), tailMat);
    tl.position.set(sign * ext.x * 0.62, wallY * 0.95, trayEndZ - 0.04);
    group.add(tl);
  }
}
