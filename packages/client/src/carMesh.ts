// Fitted procedural meshes for the five fictional Australian 4x4 bases.
// Geometry follows the resolved build, while wheel groups stay parented to
// the physics-driven solid axles. These meshes are intentionally free of
// manufacturer badges and double as the asset-load failure fallback.

import * as THREE from 'three';
import {
  Physics,
  createStockBuild,
  normalizeVehicleBaseId,
  normalizeVehicleBuild,
  type CarKind,
  type PaintFinish,
  type VehicleBuild,
} from '@mydrunner/shared';

type Extents = { x: number; y: number; z: number };

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

interface Materials {
  body: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  black: THREE.MeshStandardMaterial;
}

function makeMaterials(bodyColor: number, finish: PaintFinish = 'gloss'): Materials {
  const roughness = finish === 'matte' ? 0.9 : finish === 'satin' ? 0.66 : 0.42;
  const metalness = finish === 'matte' ? 0.02 : 0.15;
  return {
    body: new THREE.MeshStandardMaterial({ color: bodyColor, roughness, metalness, name: 'paint.primary' }),
    trim: new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.85, metalness: 0 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x29343d,
      roughness: 0.18,
      metalness: 0.08,
      transparent: true,
      opacity: 0.72,
    }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.35, metalness: 0.7 }),
    black: new THREE.MeshStandardMaterial({ color: 0x202020, roughness: 0.6 }),
  };
}

function buildSingleWheel(r: number, w: number, build?: VehicleBuild): THREE.Group {
  const tireGeo = new THREE.CylinderGeometry(r, r, w, 20);
  tireGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.95 });
  const rimGeo = new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.02, 14);
  rimGeo.rotateZ(Math.PI / 2);
  const steel = build?.wheelId.endsWith('.classic-steel') ?? false;
  const beadlock = build?.wheelId.endsWith('.beadlock-alloy') ?? false;
  const rimMat = new THREE.MeshStandardMaterial({
    color: steel ? 0x292b2d : beadlock ? 0x555b60 : 0x9aa0a6,
    roughness: steel ? 0.72 : 0.4,
    metalness: 0.7,
  });
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
  if (beadlock) {
    const ringGeo = new THREE.TorusGeometry(r * 0.54, 0.025, 8, 24);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({ color: 0xb7a476, roughness: 0.45, metalness: 0.75 }));
    ring.rotation.y = Math.PI / 2;
    ring.position.x = w * 0.51;
    wheelGroup.add(ring);
  }
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
function buildAxles(group: THREE.Group, build: VehicleBuild): {
  axles: [THREE.Group, THREE.Group];
  wheels: THREE.Object3D[];
} {
  const geom = Physics.geomFor(build);
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

    {
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
    }

    // Two wheels at the beam ends.
    const wheelXOffset = ag.trackHalf;
    const wheelW = geom.wheelWidth;
    for (let side = 0; side < 2; side++) {
      const wheel = buildSingleWheel(geom.wheelRadius, wheelW, build);
      wheel.position.set(side === 0 ? -wheelXOffset : +wheelXOffset, 0, 0);
      axle.add(wheel);
      wheels.push(wheel);
    }

    group.add(axle);
  }

  return { axles, wheels };
}

function buildLowerBodyAndFlares(
  group: THREE.Group,
  ext: Extents,
  mats: Materials,
  build: VehicleBuild,
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
  // axle geometry so flares track each base's wheelbase changes.
  for (const wp of Physics.restWheelPositions(build)) {
    const flare = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.85), mats.trim);
    flare.position.set(Math.sign(wp.x) * (ext.x + 0.02), -ext.y + 0.1, wp.z);
    group.add(flare);
  }
}

function buildWagonBody(group: THREE.Group, ext: Extents, mats: Materials): void {
  // Cabin - tall and upright, almost as wide as body, flat top. Sits on the
  // rear 75% of the body, behind a short bonnet.
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

  // Round headlights and a simple factory bumper.
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
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.82, 0.13, 0.12), mats.trim);
  bumper.position.set(0, -ext.y * 0.35, ext.z + 0.07);
  group.add(bumper);

  // Tall vertical tail lights.
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa31818, emissive: 0xa31818, emissiveIntensity: 0.4 });
  for (const sign of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.18, ext.y * 0.85, 0.04), tailMat);
    tl.position.set(sign * ext.x * 0.78, ext.y * 0.1, -ext.z - 0.03);
    group.add(tl);
  }
}

function buildUtilityBody(group: THREE.Group, ext: Extents, mats: Materials): void {
  // Single-cab forward of mid: cabin sits in the front 45% of the body, leaving
  // the rear 55% as the bed/tray. Cabin is shorter and narrower than the
  // wagon cabin so the silhouette reads as a utility.
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
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.82, 0.12, 0.12), mats.trim);
  bumper.position.set(0, -ext.y * 0.34, ext.z + 0.07);
  group.add(bumper);

  // Horizontal tail lights low on the tailgate.
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xa31818, emissive: 0xa31818, emissiveIntensity: 0.4 });
  for (const sign of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.04), tailMat);
    tl.position.set(sign * ext.x * 0.6, ext.y * 0.6, bedEndZ - 0.04);
    group.add(tl);
  }
}

function addSharedDetail(group: THREE.Group, ext: Extents, mats: Materials, build: VehicleBuild): void {
  const seamMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  // Door/panel seams and sill rails make the silhouette read at close range.
  for (const side of [-1, 1]) {
    for (const z of [-ext.z * 0.35, ext.z * 0.35]) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.018, ext.y * 1.35, 0.025), seamMat);
      seam.position.set(side * (ext.x + 0.011), ext.y * 0.75, z);
      group.add(seam);
    }
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.28), mats.trim);
    mirror.position.set(side * (ext.x + 0.12), ext.y * 1.45, ext.z * 0.42);
    group.add(mirror);
  }
  // Lightweight seats and dashboard remain visible through the glass.
  const cabinFrontZ = ext.z * 0.43;
  const dashboard = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.55, 0.15, 0.32), mats.trim);
  dashboard.position.set(0, ext.y + 0.45, cabinFrontZ + 0.28);
  group.add(dashboard);
  const seatRows = build.baseId === 'stockman-single'
    ? [cabinFrontZ - 0.12]
    : [cabinFrontZ - 0.12, -ext.z * 0.23];
  for (const rowZ of seatRows) {
    for (const side of [-1, 1]) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 0.52, 0.54, 0.46), mats.black);
      seat.position.set(side * ext.x * 0.39, ext.y + 0.34, rowZ);
      group.add(seat);
    }
  }
  group.userData.vehicleBuild = build;
}

function addBaseCharacter(group: THREE.Group, ext: Extents, mats: Materials, build: VehicleBuild): void {
  const trim = mats.trim;
  if (build.baseId === 'overlander') {
    const belt = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2.04, 0.07, ext.z * 1.55), trim);
    belt.position.set(0, ext.y * 1.1, -ext.z * 0.12);
    group.add(belt);
  } else if (build.baseId === 'stockman-single') {
    const headboard = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.82, 0.08, 0.08), mats.chrome);
    headboard.position.set(0, ext.y * 1.55, -ext.z * 0.05);
    group.add(headboard);
  } else if (build.baseId === 'stockman-dual') {
    const rearWindow = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.45, 0.48, 0.025), mats.glass);
    rearWindow.position.set(0, ext.y * 1.45, -ext.z * 0.18);
    group.add(rearWindow);
  } else if (build.baseId === 'longreach') {
    for (const side of [-1, 1]) {
      const cargoWindow = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.50, ext.z * 0.52), mats.glass);
      cargoWindow.position.set(side * (ext.x + 0.015), ext.y * 1.28, -ext.z * 0.48);
      group.add(cargoWindow);
    }
  }
}

function addAccessories(group: THREE.Group, ext: Extents, mats: Materials, build: VehicleBuild): void {
  const front = new THREE.Group(); front.name = 'attachment.frontBar'; group.add(front);
  const roof = new THREE.Group(); roof.name = 'attachment.roof'; group.add(roof);
  const rear = new THREE.Group(); rear.name = 'attachment.rearBody'; group.add(rear);
  const intake = new THREE.Group(); intake.name = 'attachment.snorkel'; group.add(intake);
  const metal = build.frontBarId.endsWith('.steel-winch') ? mats.black : mats.chrome;
  if (!build.frontBarId.endsWith('.factory')) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 2.08, 0.22, 0.22), metal);
    beam.position.set(0, -ext.y * 0.12, ext.z + 0.16);
    front.add(beam);
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(ext.x * 0.64, 0.045, 8, 20, Math.PI), metal);
    hoop.rotation.z = Math.PI;
    hoop.position.set(0, ext.y * 0.12, ext.z + 0.2);
    front.add(hoop);
  }
  if (build.winchId.endsWith('.fitted')) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.52, 16), mats.chrome);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0, -ext.y * 0.02, ext.z + 0.31);
    front.add(drum);
    const fairlead = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.08, 0.05), mats.chrome);
    fairlead.position.set(0, -ext.y * 0.02, ext.z + 0.45);
    front.add(fairlead);
  }
  if (build.snorkelId.endsWith('.fitted')) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.45, 12), mats.black);
    pipe.position.set(ext.x * 0.86, ext.y + 0.64, ext.z * 0.47);
    intake.add(pipe);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.24), mats.black);
    head.position.set(ext.x * 0.86, ext.y + 1.36, ext.z * 0.53);
    intake.add(head);
  }
  if (!build.roofId.endsWith('.none')) {
    const platformY = ext.y + 1.46;
    const platform = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.75, 0.08, ext.z * 1.2), mats.black);
    platform.position.set(0, platformY, -ext.z * 0.12);
    roof.add(platform);
    if (build.roofId.endsWith('.basket')) {
      for (const x of [-ext.x * 0.78, ext.x * 0.78]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, ext.z * 1.2), mats.black);
        rail.position.set(x, platformY + 0.12, -ext.z * 0.12);
        roof.add(rail);
      }
    } else {
      const awning = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, ext.z * 1.12, 12), mats.chrome);
      awning.rotation.x = Math.PI / 2;
      awning.position.set(ext.x * 0.98, platformY + 0.08, -ext.z * 0.12);
      roof.add(awning);
    }
  }
  if (!build.rearBodyId.endsWith('.factory')) {
    const heavy = build.rearBodyId.endsWith('.option-b');
    if (build.baseId === 'stockman-single' || build.baseId === 'stockman-dual') {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(ext.x * 1.88, heavy ? 1.25 : 0.22, ext.z * 0.78),
        heavy ? mats.chrome : mats.black,
      );
      box.position.set(0, ext.y + (heavy ? 0.62 : 0.11), -ext.z * 0.57);
      rear.add(box);
    } else {
      const carrier = new THREE.Mesh(new THREE.BoxGeometry(ext.x * 1.9, 0.12, 0.12), mats.black);
      carrier.position.set(0, ext.y * 0.15, -ext.z - 0.17);
      rear.add(carrier);
      const spareCount = heavy ? 2 : 1;
      for (let i = 0; i < spareCount; i++) {
        const spare = buildSingleWheel(Physics.geomFor(build).wheelRadius * 0.92, 0.20, build);
        spare.rotation.y = Math.PI / 2;
        spare.position.set((i - (spareCount - 1) / 2) * ext.x * 0.88, ext.y * 0.48, -ext.z - 0.25);
        rear.add(spare);
      }
      if (heavy) {
        const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.05, 0.08), mats.chrome);
        ladder.position.set(ext.x * 0.62, ext.y + 0.48, -ext.z - 0.14);
        rear.add(ladder);
      }
    }
  }
}

export function buildCarMesh(value: CarKind | VehicleBuild, _isLocal: boolean, _idHash: number): CarMesh {
  const build = typeof value === 'string'
    ? createStockBuild(normalizeVehicleBaseId(value))
    : normalizeVehicleBuild(value);
  const group = new THREE.Group();
  group.name = `vehicle.${build.baseId}`;
  const ext = Physics.geomFor(build).chassisHalfExtents;
  const mats = makeMaterials(Number.parseInt(build.paintColor.slice(1), 16), build.paintFinish);

  buildLowerBodyAndFlares(group, ext, mats, build);
  if (build.baseId === 'stockman-single' || build.baseId === 'stockman-dual') {
    buildUtilityBody(group, ext, mats);
  } else {
    buildWagonBody(group, ext, mats);
  }
  addSharedDetail(group, ext, mats, build);
  addBaseCharacter(group, ext, mats, build);
  addAccessories(group, ext, mats, build);
  const { axles, wheels } = buildAxles(group, build);
  return { group, wheels, axles };
}

/** Hash a player id string to a stable small int for color selection. */
export function colorHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}
