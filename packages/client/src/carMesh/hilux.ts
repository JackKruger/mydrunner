// Toyota-Hilux-style ute: short forward cab + bed with a hardtop canopy,
// low-profile bullbar, no roof rack.

import * as THREE from 'three';
import { VEHICLE } from '@mydrunner/shared';
import type { Materials } from './shared.js';

export const HILUX_COLORS = [
  0xe8e3da, // arctic white (local default)
  0x1f2a36, // graphite
  0x6e3a1c, // bronze
  0x3a5a3a, // forest
  0xc1342f, // cherry red
  0x8aa0b5, // silver-blue
];

export function buildHiluxBody(group: THREE.Group, ext: typeof VEHICLE.chassisHalfExtents, mats: Materials): void {
  // Single-cab forward of mid: cabin sits in the front 45% of the body, leaving
  // the rear 55% as the bed/tray. Cabin is shorter and narrower than the
  // Patrol's full SUV cabin so the silhouette reads as a ute.
  const cabinLen = ext.z * 0.95;
  const cabinHeight = ext.y * 1.55;
  const cabinWide = ext.x * 1.86;
  const cabinCenterZ = ext.z * 0.45;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(cabinWide, cabinHeight, cabinLen), mats.body);
  cabin.position.set(0, ext.y + cabinHeight / 2, cabinCenterZ);
  cabin.castShadow = true;
  group.add(cabin);

  // Cabin glass: side windows + windshield + small rear cab window.
  const winThickness = 0.025;
  const winH = cabinHeight * 0.55;
  const winYCenter = ext.y + cabinHeight / 2 + cabinHeight * 0.07;
  for (const sign of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(winThickness, winH, cabinLen * 0.8), mats.glass);
    win.position.set(sign * (cabinWide / 2 + winThickness / 2), winYCenter, cabinCenterZ);
    group.add(win);
  }
  // Windshield (raked forward) + rear cab glass (smaller, vertical).
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(cabinWide * 0.92, winH, winThickness), mats.glass);
  windshield.position.set(0, winYCenter, cabinCenterZ + cabinLen / 2 + winThickness / 2);
  windshield.rotation.x = -0.12;
  group.add(windshield);
  const rearCabGlass = new THREE.Mesh(new THREE.BoxGeometry(cabinWide * 0.85, winH * 0.8, winThickness), mats.glass);
  rearCabGlass.position.set(0, winYCenter, cabinCenterZ - cabinLen / 2 - winThickness / 2);
  group.add(rearCabGlass);

  // Tray bed: low side walls along the rear half of the body (where the cabin
  // doesn't sit). The lower body box already provides the floor and outer
  // sides - these walls are the bed sidewalls that frame the canopy.
  const bedStartZ = cabinCenterZ - cabinLen / 2; // back edge of cabin
  const bedEndZ = -ext.z;                         // back of vehicle
  const bedLen = bedStartZ - bedEndZ;
  const bedCenterZ = (bedStartZ + bedEndZ) / 2;
  const bedWallH = ext.y * 0.55;
  const bedWallY = ext.y + bedWallH / 2;
  // Bed front wall (against cabin back).
  const bedFront = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.92, bedWallH, 0.06), mats.body);
  bedFront.position.set(0, bedWallY, bedStartZ - 0.03);
  group.add(bedFront);
  // Tailgate at the rear.
  const tailgate = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.92, bedWallH * 0.95, 0.06), mats.body);
  tailgate.position.set(0, bedWallY - bedWallH * 0.025, bedEndZ + 0.03);
  group.add(tailgate);
  // Side bed walls.
  for (const sign of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.06, bedWallH, bedLen), mats.body);
    wall.position.set(sign * ext.x * 0.96, bedWallY, bedCenterZ);
    group.add(wall);
  }

  // Canopy (the user-requested fibreglass shell on the bed). Sits on top of
  // the bed walls and is sized so its top is flush with the cabin roof,
  // and its sides sit slightly inboard of the cabin width so the silhouette
  // reads as cabin-then-canopy rather than one continuous box. Tinted
  // glass on side + back.
  const canopyH = cabinHeight - bedWallH;
  const canopyW = ext.x * 1.78;
  const canopyL = bedLen * 0.96;
  const canopyY = ext.y + bedWallH + canopyH / 2;
  const canopyZ = bedCenterZ;
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(canopyW, canopyH, canopyL), mats.body);
  canopy.position.set(0, canopyY, canopyZ);
  canopy.castShadow = true;
  group.add(canopy);
  // Slight bevel: an angled cap at the rear top edge for a less-brick silhouette.
  const canopyCap = new THREE.Mesh(new THREE.BoxGeometry(canopyW, canopyH * 0.18, 0.18), mats.body);
  canopyCap.position.set(0, canopyY + canopyH / 2 - canopyH * 0.09, canopyZ - canopyL / 2 + 0.06);
  canopyCap.rotation.x = 0.3;
  group.add(canopyCap);
  // Canopy windows (tinted).
  const canopyWinH = canopyH * 0.45;
  const canopyWinY = canopyY + canopyH * 0.05;
  for (const sign of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(winThickness, canopyWinH, canopyL * 0.85), mats.glass);
    win.position.set(sign * (canopyW / 2 + winThickness / 2), canopyWinY, canopyZ);
    group.add(win);
  }
  const canopyRear = new THREE.Mesh(new THREE.BoxGeometry(canopyW * 0.85, canopyWinH, winThickness), mats.glass);
  canopyRear.position.set(0, canopyWinY, canopyZ - canopyL / 2 - winThickness / 2);
  group.add(canopyRear);

  // Low-profile bullbar: single horizontal bar with two short posts. No
  // upper loop - Hiluxes typically wear simpler nudge bars than Patrols.
  const barRadius = 0.045;
  const barLen = ext.x * 1.7;
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(barRadius, barRadius, barLen, 10), mats.black);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, -ext.y * 0.15, ext.z + 0.16);
  bar.castShadow = true;
  group.add(bar);
  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(barRadius * 0.9, barRadius * 0.9, ext.y * 0.85, 8), mats.black);
    post.position.set(sign * ext.x * 0.55, -ext.y * 0.42, ext.z + 0.16);
    group.add(post);
  }

  // Rectangular headlights tucked into the front fenders.
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff4d2, emissive: 0xffd070, emissiveIntensity: 0.55 });
  for (const sign of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.04), headlightMat);
    hl.position.set(sign * ext.x * 0.55, ext.y * 0.05, ext.z + 0.025);
    group.add(hl);
  }
  // Wide chrome grille bar between the headlights.
  const grille = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 0.95, 0.1, 0.04), mats.chrome);
  grille.position.set(0, -ext.y * 0.05, ext.z + 0.025);
  group.add(grille);

  // Horizontal tail lights low on the tailgate.
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa31818, emissive: 0xa31818, emissiveIntensity: 0.4 });
  for (const sign of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.04), tailMat);
    tl.position.set(sign * ext.x * 0.6, ext.y * 0.6, bedEndZ - 0.04);
    group.add(tl);
  }
}
