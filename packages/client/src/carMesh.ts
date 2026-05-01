// Procedural Nissan-Patrol-GQ-style 4x4 silhouette built from Three.js
// primitives. Boxy, upright, with bullbar, wheel flares, roof rack, and a
// snorkel up the A-pillar. Sized to match VEHICLE.chassisHalfExtents so
// the visual aligns with the physics chassis.

import * as THREE from 'three';
import { VEHICLE } from '@mydrunner/shared';

export interface CarMesh {
  group: THREE.Group;
  wheels: THREE.Object3D[];
}

export function buildCarMesh(color: number): CarMesh {
  const group = new THREE.Group();
  const ext = VEHICLE.chassisHalfExtents;

  const bodyColor = color;
  const trimColor = 0x161616; // dark plastic, lower body cladding

  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    roughness: 0.55,
    metalness: 0.15,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: trimColor,
    roughness: 0.85,
    metalness: 0.0,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x1a1f24,
    roughness: 0.15,
    metalness: 0.6,
  });
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xb8b8b8,
    roughness: 0.35,
    metalness: 0.7,
  });

  // Lower body: full chassis box in body color (gets a black trim band).
  const lower = new THREE.Mesh(
    new THREE.BoxGeometry(ext.x * 2, ext.y * 2, ext.z * 2),
    bodyMat,
  );
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  // Black plastic trim band along the bottom 1/4 of the body (very Patrol).
  const bandH = ext.y * 0.5;
  const band = new THREE.Mesh(
    new THREE.BoxGeometry(ext.x * 2.02, bandH, ext.z * 2.02),
    trimMat,
  );
  band.position.set(0, -ext.y + bandH / 2, 0);
  group.add(band);

  // Cabin - tall and upright, almost as wide as body, flat top. Sits on
  // the rear 75% of the body (Patrol has a short hood).
  const cabinLen = ext.z * 1.25;
  const cabinHeight = ext.y * 1.7; // taller than half-body
  const cabinWide = ext.x * 1.93;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(cabinWide, cabinHeight, cabinLen),
    bodyMat,
  );
  cabin.position.set(0, ext.y + cabinHeight / 2, -ext.z * 0.25);
  cabin.castShadow = true;
  group.add(cabin);

  // Big square windows wrapping the cabin.
  const winThickness = 0.025;
  const winH = cabinHeight * 0.6;
  const winYCenter = ext.y + cabinHeight / 2 + cabinHeight * 0.05;
  // Sides (long).
  for (const sign of [-1, 1]) {
    const win = new THREE.Mesh(
      new THREE.BoxGeometry(winThickness, winH, cabinLen * 0.85),
      glassMat,
    );
    win.position.set(sign * (cabinWide / 2 + winThickness / 2), winYCenter, -ext.z * 0.25);
    group.add(win);
  }
  // Windshield + rear glass.
  for (const [sign, slope] of [[1, -0.07], [-1, 0.07]] as const) {
    const win = new THREE.Mesh(
      new THREE.BoxGeometry(cabinWide * 0.92, winH, winThickness),
      glassMat,
    );
    win.position.set(0, winYCenter, -ext.z * 0.25 + sign * (cabinLen / 2 + winThickness / 2));
    win.rotation.x = slope; // slight rake
    group.add(win);
  }

  // Bullbar - thick horizontal pipe across the front with two vertical posts.
  const bullbarMat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.6 });
  const barRadius = 0.05;
  const barLen = ext.x * 1.7;
  const barHorizontal = new THREE.Mesh(
    new THREE.CylinderGeometry(barRadius, barRadius, barLen, 10),
    bullbarMat,
  );
  barHorizontal.rotation.z = Math.PI / 2;
  barHorizontal.position.set(0, -ext.y * 0.1, ext.z + 0.18);
  barHorizontal.castShadow = true;
  group.add(barHorizontal);
  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(barRadius * 0.9, barRadius * 0.9, ext.y * 1.0, 8),
      bullbarMat,
    );
    post.position.set(sign * ext.x * 0.55, -ext.y * 0.4, ext.z + 0.18);
    post.castShadow = true;
    group.add(post);
  }
  // Crossbar above the horizontal one (the Patrol "loop" look).
  const upperBar = new THREE.Mesh(
    new THREE.CylinderGeometry(barRadius * 0.85, barRadius * 0.85, barLen * 0.6, 10),
    bullbarMat,
  );
  upperBar.rotation.z = Math.PI / 2;
  upperBar.position.set(0, ext.y * 0.3, ext.z + 0.18);
  group.add(upperBar);

  // Headlights - round, set back behind the bullbar.
  const headlightMat = new THREE.MeshStandardMaterial({
    color: 0xfff4d2,
    emissive: 0xffd070,
    emissiveIntensity: 0.6,
  });
  for (const sign of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.06, 14), headlightMat);
    hl.rotation.x = Math.PI / 2;
    hl.position.set(sign * ext.x * 0.55, -ext.y * 0.05, ext.z + 0.04);
    group.add(hl);
  }
  // Grille - vertical slats between the headlights.
  for (let i = -2; i <= 2; i++) {
    const slat = new THREE.Mesh(
      new THREE.BoxGeometry(0.035, ext.y * 0.45, 0.04),
      chromeMat,
    );
    slat.position.set(i * 0.07, -ext.y * 0.05, ext.z + 0.025);
    group.add(slat);
  }

  // Tail lights - tall vertical rectangles (Patrol style).
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xa31818,
    emissive: 0xa31818,
    emissiveIntensity: 0.4,
  });
  for (const sign of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.18, ext.y * 0.85, 0.04), tailMat);
    tl.position.set(sign * ext.x * 0.78, ext.y * 0.1, -ext.z - 0.03);
    group.add(tl);
  }
  // Rear spare wheel mount (signature 4x4 detail).
  const spareMount = new THREE.Mesh(
    new THREE.CylinderGeometry(VEHICLE.wheelRadius * 0.95, VEHICLE.wheelRadius * 0.95, 0.18, 18),
    new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.95 }),
  );
  spareMount.rotation.x = Math.PI / 2;
  spareMount.position.set(0, 0.05, -ext.z - 0.18);
  spareMount.castShadow = true;
  group.add(spareMount);

  // Roof rack - flat tray with low rails.
  const rackMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });
  const rackBase = new THREE.Mesh(
    new THREE.BoxGeometry(cabinWide * 0.92, 0.04, cabinLen * 0.9),
    rackMat,
  );
  rackBase.position.set(0, ext.y + cabinHeight + 0.05, -ext.z * 0.25);
  rackBase.castShadow = true;
  group.add(rackBase);
  // Rack rails.
  for (const sign of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.08, cabinLen * 0.9),
      rackMat,
    );
    rail.position.set(sign * cabinWide * 0.45, ext.y + cabinHeight + 0.10, -ext.z * 0.25);
    group.add(rail);
  }

  // Snorkel up the right A-pillar - very Patrol.
  const snorkelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.85 });
  const snorkel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, cabinHeight * 1.1, 10),
    snorkelMat,
  );
  snorkel.position.set(cabinWide / 2 - 0.03, ext.y + cabinHeight / 2, -ext.z * 0.25 + cabinLen / 2 - 0.1);
  group.add(snorkel);
  const snorkelHead = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.18, 0.18),
    snorkelMat,
  );
  snorkelHead.position.set(cabinWide / 2 - 0.03, ext.y + cabinHeight + 0.05, -ext.z * 0.25 + cabinLen / 2 - 0.1);
  group.add(snorkelHead);

  // Wheel flares - black arches around each wheel position.
  const flareMat = trimMat;
  for (const wp of VEHICLE.wheelPositions) {
    const flare = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.1, 0.85),
      flareMat,
    );
    flare.position.set(Math.sign(wp.x) * (ext.x + 0.02), -ext.y + 0.1, wp.z);
    flare.rotation.y = 0;
    group.add(flare);
  }

  // Wheels - chunky off-road tires with metal rim and bolt detail.
  const wheels: THREE.Object3D[] = [];
  const tireGeo = new THREE.CylinderGeometry(VEHICLE.wheelRadius, VEHICLE.wheelRadius, VEHICLE.wheelWidth, 20);
  tireGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.95 });
  const rimGeo = new THREE.CylinderGeometry(VEHICLE.wheelRadius * 0.6, VEHICLE.wheelRadius * 0.6, VEHICLE.wheelWidth + 0.02, 14);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.7 });
  const hubGeo = new THREE.CylinderGeometry(VEHICLE.wheelRadius * 0.18, VEHICLE.wheelRadius * 0.18, VEHICLE.wheelWidth + 0.04, 8);
  hubGeo.rotateZ(Math.PI / 2);
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.8 });
  for (let i = 0; i < 4; i++) {
    const wheelGroup = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.castShadow = true;
    wheelGroup.add(tire);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    wheelGroup.add(rim);
    const hub = new THREE.Mesh(hubGeo, hubMat);
    wheelGroup.add(hub);
    group.add(wheelGroup);
    wheels.push(wheelGroup);
  }

  return { group, wheels };
}

