// Visual side of the petrol station (and any other static landmark
// structures we add later). Built from the same shared spec the
// physics module uses, so meshes line up with colliders without any
// hand-eye coordination.

import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';

export class LandmarkMeshes {
  readonly group = new THREE.Group();

  constructor(landmarks: Physics.Landmarks) {
    this.buildPetrolStation(landmarks.petrolStation);
  }

  private buildPetrolStation(ps: Physics.PetrolStation): void {
    const STATION = Physics.STATION;
    const root = new THREE.Group();
    root.position.set(ps.x, ps.y, ps.z);
    root.rotation.y = ps.yaw;
    this.group.add(root);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe1d8c2, roughness: 0.85 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xc44719, roughness: 0.7 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x7a8186, roughness: 0.6, metalness: 0.4 });
    const columnMat = new THREE.MeshStandardMaterial({ color: 0xb6b6b6, roughness: 0.55, metalness: 0.3 });
    const pumpMat = new THREE.MeshStandardMaterial({ color: 0xc4421a, roughness: 0.45, metalness: 0.35 });
    const pumpDarkMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.2, metalness: 0.7 });

    // Office building.
    const b = STATION.building;
    const building = new THREE.Mesh(
      new THREE.BoxGeometry(b.w, b.h, b.d),
      wallMat,
    );
    building.castShadow = true;
    building.receiveShadow = true;
    building.position.set(0, b.h / 2, STATION.buildingZOffset);
    root.add(building);

    // Front-of-shop windows: a continuous strip across the road-facing wall.
    const windowH = b.h * 0.55;
    const window = new THREE.Mesh(
      new THREE.BoxGeometry(b.w * 0.85, windowH, 0.04),
      glassMat,
    );
    window.position.set(0, b.h * 0.55, STATION.buildingZOffset + b.d / 2 + 0.02);
    root.add(window);

    // Red signage band along the top of the building's road-facing wall.
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(b.w, b.h * 0.18, 0.06),
      accentMat,
    );
    sign.position.set(0, b.h * 0.91, STATION.buildingZOffset + b.d / 2 + 0.04);
    root.add(sign);

    // Shelter roof slab.
    const sh = STATION.shelter;
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(sh.w, sh.h, sh.d),
      roofMat,
    );
    roof.castShadow = true;
    roof.position.set(0, sh.columnHeight + sh.h / 2, sh.zOffset);
    root.add(roof);

    // Red trim on the front edge of the shelter (canopy facia).
    const facia = new THREE.Mesh(
      new THREE.BoxGeometry(sh.w, sh.h * 0.6, 0.08),
      accentMat,
    );
    facia.position.set(0, sh.columnHeight + sh.h * 0.7, sh.zOffset + sh.d / 2 + 0.05);
    root.add(facia);

    // Four shelter columns.
    const colHalfH = sh.columnHeight / 2;
    for (const cx of [-sh.w / 2 + 0.5, sh.w / 2 - 0.5]) {
      for (const cz of [sh.zOffset - sh.d / 2 + 0.4, sh.zOffset + sh.d / 2 - 0.4]) {
        const col = new THREE.Mesh(
          new THREE.CylinderGeometry(sh.columnRadius, sh.columnRadius, sh.columnHeight, 12),
          columnMat,
        );
        col.castShadow = true;
        col.position.set(cx, colHalfH, cz);
        root.add(col);
      }
    }

    // Two pumps under the shelter. Body box + a small darker top "head"
    // (the part with the screen + nozzle) + a hose loop hanging off the
    // side.
    const p = STATION.pump;
    for (const px of [-p.spacing / 2, p.spacing / 2]) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), pumpMat);
      body.castShadow = true;
      body.position.set(px, p.h / 2, p.zOffset);
      root.add(body);
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(p.w * 0.95, p.h * 0.18, p.d * 0.95),
        pumpDarkMat,
      );
      head.position.set(px, p.h * 0.92, p.zOffset);
      root.add(head);
      // Nozzle holster on the road-facing side.
      const nozzle = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.30, 0.08),
        pumpDarkMat,
      );
      nozzle.position.set(px - p.w * 0.55, p.h * 0.55, p.zOffset);
      root.add(nozzle);
    }

    // Sign pole + sign by the road. A simple rectangle sign mounted
    // ~5m up so it's visible from a distance.
    const poleH = 6;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, poleH, 10),
      columnMat,
    );
    pole.position.set(sh.w / 2 + 1.2, poleH / 2, sh.zOffset + sh.d / 2 + 0.5);
    pole.castShadow = true;
    root.add(pole);
    const signBoard = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 1.1, 0.18),
      accentMat,
    );
    signBoard.position.set(sh.w / 2 + 1.2, poleH - 0.35, sh.zOffset + sh.d / 2 + 0.5);
    signBoard.castShadow = true;
    root.add(signBoard);
  }
}
