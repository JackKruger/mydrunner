// Procedural truck silhouettes built from Three.js primitives. The chassis
// extents (VEHICLE.chassisHalfExtents) and wheel positions are shared
// across kinds because physics is shared - only the visual changes.
//
// Kinds:
//   patrol - Nissan-Patrol-GQ-style boxy 4x4: full SUV cabin, roof rack,
//            snorkel, bullbar, rear spare wheel.
//   hilux  - Toyota-Hilux-style ute: short forward cab + bed with a
//            hardtop canopy, low-profile bullbar, no roof rack.

import * as THREE from 'three';
import { Physics, VEHICLE, type CarKind } from '@mydrunner/shared';

export interface CarMesh {
  group: THREE.Group;
  /** [FL, FR, RL, RR]. Spin + steer apply here. Each wheel is a child
   *  of its axle group (axles[0] for FL/FR, axles[1] for RL/RR), so
   *  posing the axle moves both wheels together - that's the solid-axle
   *  rigid-beam coupling. */
  wheels: THREE.Object3D[];
  /** [front, rear] axle groups. Each is positioned at chassis-local
   *  (0, centerLocalY + rideY, centerLocalZ) and rotated by rollAngle
   *  about chassis-forward (local +Z). Wheel meshes are children at
   *  (+/- trackHalf, 0, 0). */
  axles: [THREE.Group, THREE.Group];
}

const PATROL_COLORS = [
  0xd9531e, // burnt orange (local default)
  0x2a4a6a, // navy
  0x466b3a, // olive
  0xc9b86b, // sand
  0x8b4513, // saddle brown
  0xb23a48, // brick red
];

const HILUX_COLORS = [
  0xe8e3da, // arctic white (local default)
  0x1f2a36, // graphite
  0x6e3a1c, // bronze
  0x3a5a3a, // forest
  0xc1342f, // cherry red
  0x8aa0b5, // silver-blue
];

interface Materials {
  body: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  black: THREE.MeshStandardMaterial;
}

function pickColor(palette: readonly number[], isLocal: boolean, idHash: number): number {
  if (isLocal) return palette[0]!;
  return palette[1 + (idHash % (palette.length - 1))] ?? palette[1]!;
}

function makeMaterials(bodyColor: number): Materials {
  return {
    body: new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.55, metalness: 0.15 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.85, metalness: 0 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x1a1f24, roughness: 0.15, metalness: 0.6 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.35, metalness: 0.7 }),
    black: new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.6 }),
  };
}

function buildSingleWheel(r: number, w: number): THREE.Group {
  const tireGeo = new THREE.CylinderGeometry(r, r, w, 20);
  tireGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.95 });
  const rimGeo = new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.02, 14);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.7 });
  const hubGeo = new THREE.CylinderGeometry(r * 0.18, r * 0.18, w + 0.04, 8);
  hubGeo.rotateZ(Math.PI / 2);
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.8 });
  const spokeGeo = new THREE.BoxGeometry(w + 0.005, r * 0.55, 0.05);
  // 0.02m radial height keeps lugs visible but avoids digging 2.8cm into
  // the visual terrain at each contact (the old 0.04m protrusion caused
  // 8 visible ground-penetration bumps per wheel revolution).
  const treadGeo = new THREE.BoxGeometry(w * 0.85, 0.02, 0.07);
  const treadMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 });

  const wheelGroup = new THREE.Group();
  // YXZ rotation order so the renderer composes turn-then-roll correctly:
  // rotation.y is applied AFTER rotation.x, meaning the wheel rolls around
  // its own axle FIRST, then turns. With the default XYZ order, a spinning
  // wheel that's also steered tumbles around the world X axis (visibly
  // shaking when driving + turning).
  wheelGroup.rotation.order = 'YXZ';
  const tire = new THREE.Mesh(tireGeo, tireMat);
  tire.castShadow = true;
  wheelGroup.add(tire);
  wheelGroup.add(new THREE.Mesh(rimGeo, rimMat));
  wheelGroup.add(new THREE.Mesh(hubGeo, hubMat));
  const spokeCount = 5;
  for (let s = 0; s < spokeCount; s++) {
    const spoke = new THREE.Mesh(spokeGeo, rimMat);
    spoke.rotation.x = (s / spokeCount) * Math.PI * 2;
    wheelGroup.add(spoke);
  }
  const lugCount = 8;
  for (let l = 0; l < lugCount; l++) {
    const lug = new THREE.Mesh(treadGeo, treadMat);
    const a = (l / lugCount) * Math.PI * 2;
    lug.position.set(0, r * Math.cos(a) * 1.01, r * Math.sin(a) * 1.01);
    lug.rotation.x = a;
    wheelGroup.add(lug);
  }
  return wheelGroup;
}

/** Build the two solid-axle assemblies and attach them to the chassis
 *  group. Each axle is a child Group containing a beam + diff pumpkin
 *  + left wheel + right wheel. The axle group is the unit posed by
 *  scene.ts each frame using rideY (vertical) and rollAngle (twist
 *  about chassis-forward) - the rigid-beam articulation is the visual
 *  signature of solid-axle 4x4s. Wheels are at fixed local +/- trackHalf
 *  inside the axle group, so steering and spin still apply per-wheel
 *  while the axle itself moves them as one unit. */
function buildAxles(group: THREE.Group, kind: CarKind): {
  axles: [THREE.Group, THREE.Group];
  wheels: THREE.Object3D[];
} {
  const geom = Physics.geomFor(kind);
  const axles: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  const wheels: THREE.Object3D[] = [];

  const beamMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const diffMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.75, metalness: 0.2 });

  for (let aIdx = 0; aIdx < 2; aIdx++) {
    const ag = aIdx === 0 ? geom.front : geom.rear;
    const axle = axles[aIdx]!;
    // Initial pose at rest. The axle BEAM sits at wheel-centre height in
    // chassis frame, which is the chassis attachment (centerLocalY) minus
    // the spring rest length. As the spring compresses (rideY > 0) the
    // beam moves UP toward the attachment; that's what scene.ts applies
    // each frame from the physics axle state.
    axle.position.set(0, ag.centerLocalY - ag.suspensionRestLength, ag.centerLocalZ);

    // Beam: thin cylinder along chassis-X. Slightly shorter than full
    // track so the wheel hubs visually overlap the beam ends.
    const beamLen = ag.trackHalf * 2 - 0.18;
    const beamRad = 0.07;
    const beamGeo = new THREE.CylinderGeometry(beamRad, beamRad, beamLen, 12);
    beamGeo.rotateZ(Math.PI / 2);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.castShadow = true;
    axle.add(beam);

    // Diff pumpkin: a stout box at the centre of the beam, slightly
    // offset toward the chassis side that historically housed the diff
    // (rear axle = forward of centre). Pure visual identifier.
    const diffSize = aIdx === 0 ? { x: 0.34, y: 0.30, z: 0.34 } : { x: 0.36, y: 0.32, z: 0.36 };
    const diffGeo = new THREE.BoxGeometry(diffSize.x, diffSize.y, diffSize.z);
    const diff = new THREE.Mesh(diffGeo, diffMat);
    diff.position.set(0, 0, aIdx === 0 ? 0 : 0.04);
    diff.castShadow = true;
    axle.add(diff);

    // Two wheels at the beam ends.
    for (let side = 0; side < 2; side++) {
      const wheel = buildSingleWheel(geom.wheelRadius, geom.wheelWidth);
      wheel.position.set(side === 0 ? -ag.trackHalf : +ag.trackHalf, 0, 0);
      axle.add(wheel);
      wheels.push(wheel);
    }

    group.add(axle);
  }

  return { axles, wheels };
}

function buildLowerBodyAndFlares(
  group: THREE.Group,
  ext: typeof VEHICLE.chassisHalfExtents,
  mats: Materials,
  kind: CarKind,
): void {
  // Lower body: full chassis box.
  const lower = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2, ext.y * 2, ext.z * 2), mats.body);
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  // Black plastic trim band along the bottom 1/4.
  const bandH = ext.y * 0.5;
  const band = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2.02, bandH, ext.z * 2.02), mats.trim);
  band.position.set(0, -ext.y + bandH / 2, 0);
  group.add(band);

  // Wheel flares around each wheel position. Driven from the per-kind
  // axle geometry so flares track wheelbase changes (e.g. a longer
  // Hilux puts its rear flares further back than a Patrol's).
  for (const wp of Physics.restWheelPositions(kind)) {
    const flare = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.85), mats.trim);
    flare.position.set(Math.sign(wp.x) * (ext.x + 0.02), -ext.y + 0.1, wp.z);
    group.add(flare);
  }
}

function buildPatrolBody(group: THREE.Group, ext: typeof VEHICLE.chassisHalfExtents, mats: Materials): void {
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

function buildHiluxBody(group: THREE.Group, ext: typeof VEHICLE.chassisHalfExtents, mats: Materials): void {
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

export function buildCarMesh(kind: CarKind, isLocal: boolean, idHash: number): CarMesh {
  const group = new THREE.Group();
  const ext = VEHICLE.chassisHalfExtents;
  const palette = kind === 'hilux' ? HILUX_COLORS : PATROL_COLORS;
  const mats = makeMaterials(pickColor(palette, isLocal, idHash));

  buildLowerBodyAndFlares(group, ext, mats, kind);
  if (kind === 'hilux') {
    buildHiluxBody(group, ext, mats);
  } else {
    buildPatrolBody(group, ext, mats);
  }
  const { axles, wheels } = buildAxles(group, kind);
  return { group, wheels, axles };
}

/** Hash a player id string to a stable small int for color selection. */
export function colorHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}
