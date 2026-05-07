// Shared materials, wheel + axle builder, and lower-body builder used
// by every kind. The per-kind body builders (patrol/hilux/ute/motorbike)
// import these and add the kind-specific cabin/bed/frame on top.

import * as THREE from 'three';
import { Physics, VEHICLE, type CarKind } from '@mydrunner/shared';

export interface Materials {
  body: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  black: THREE.MeshStandardMaterial;
}

export function pickColor(palette: readonly number[], isLocal: boolean, idHash: number): number {
  if (isLocal) return palette[0]!;
  return palette[1 + (idHash % (palette.length - 1))] ?? palette[1]!;
}

export function makeMaterials(bodyColor: number): Materials {
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
export function buildAxles(group: THREE.Group, kind: CarKind): {
  axles: [THREE.Group, THREE.Group];
  wheels: THREE.Object3D[];
} {
  const geom = Physics.geomFor(kind);
  const axles: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  const wheels: THREE.Object3D[] = [];

  const beamMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const diffMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.75, metalness: 0.2 });

  // Motorbike visualises both per-axle wheels overlapped at the chassis
  // centreline so the silhouette reads as 1 front + 1 rear wheel. The
  // physics still drives 4 wheels at full trackHalf - the visual is just
  // collapsed onto x=0. Side beams and diff pumpkins are skipped because
  // a bike doesn't have a solid axle.
  const isBike = kind === 'motorbike';

  for (let aIdx = 0; aIdx < 2; aIdx++) {
    const ag = aIdx === 0 ? geom.front : geom.rear;
    const axle = axles[aIdx]!;
    // Initial pose at rest. The axle BEAM sits at wheel-centre height in
    // chassis frame, which is the chassis attachment (centerLocalY) minus
    // the spring rest length. As the spring compresses (rideY > 0) the
    // beam moves UP toward the attachment; that's what scene.ts applies
    // each frame from the physics axle state.
    axle.position.set(0, ag.centerLocalY - ag.suspensionRestLength, ag.centerLocalZ);

    if (!isBike) {
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

    // Two wheels at the beam ends (overlapped at centre for the bike).
    const wheelXOffset = isBike ? 0 : ag.trackHalf;
    // Bike tyres are narrower than truck tyres - keeps the silhouette
    // bike-like even though the underlying physics width is shared.
    const wheelW = isBike ? geom.wheelWidth * 0.45 : geom.wheelWidth;
    for (let side = 0; side < 2; side++) {
      const wheel = buildSingleWheel(geom.wheelRadius, wheelW);
      wheel.position.set(side === 0 ? -wheelXOffset : +wheelXOffset, 0, 0);
      axle.add(wheel);
      wheels.push(wheel);
    }

    group.add(axle);
  }

  return { axles, wheels };
}

/** Lower body box + plastic trim band + per-wheel flares. Shared by all
 *  4-wheel kinds; the bike skips this and draws only its frame. */
export function buildLowerBodyAndFlares(
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
