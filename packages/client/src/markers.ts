// Authored markers, as seen in the world.
//
// The garage bay is the one marker the simulation reads — Room leases a
// bay by marker id and parks you on its authored pose — and until this
// existed it had no visual of its own at all. The only thing telling a
// player where to stop was three white stripes hardcoded into the petrol
// station's mesh, which meant a bay authored anywhere else on any other
// map was invisible: you had to already know it was there. The bay now
// paints itself from its own marker, so placing one in the editor puts
// the same box, kerb and beacon on the ground that the shipped station's
// bays get.
//
// Everything here is cosmetic. There are no colliders: the bay is a
// trigger volume, and a wheel stop you could actually hit would change
// what "drive fully into the bay" means on every existing map. The kerb
// is a visual promise the physics deliberately does not keep.

import * as THREE from 'three';
import { Maps, Physics } from '@mydrunner/shared';
import { disposeObject3D } from './three/dispose.js';

/** Bay geometry, derived from the marker's own trigger radius so the
 *  painted box and the volume you have to be inside cannot disagree.
 *  A shipped 1.65 m bay comes out 2.97 m × 5.28 m, against a 1.7 m ×
 *  3.8 m truck — room to be a little crooked, not room to park beside it. */
const BAY = {
  halfWidthPerRadius: 0.9,
  halfLengthPerRadius: 1.6,
  /** Painted line width, and how far the paint sits above the slab. */
  lineWidth: 0.16,
  lineY: 0.045,
  slabY: 0.02,
  kerbHeight: 0.16,
  kerbDepth: 0.22,
  chevrons: 3,
  chevronWidth: 0.14,
  /** Beacon rest height. Under the station canopy's 4.35 m posts and
   *  clear of a Longreach with a roof load. */
  beaconY: 3.4,
  beaconBob: 0.16,
  beaconSize: 0.42,
} as const;

/** Colours that are not the marker's own. Paint is highway yellow rather
 *  than the marker tint so the bay reads as painted concrete in daylight;
 *  the marker colour is spent on the beacon, which is what you see from
 *  across the lot. */
const PAINT_COLOR = 0xf2e15c;
const SLAB_COLOR = 0x3b3f45;
const KERB_COLOR = 0x9aa0a6;

export interface MarkerViewOptions {
  /** Editor mode: draw every authored kind, plus the trigger radius that
   *  the game has no reason to show. The game draws only what it
   *  simulates — a ring around a cargo marker nothing reads yet would be
   *  a promise the build cannot keep. */
  preview?: boolean;
}

export class MarkerMeshes {
  readonly group = new THREE.Group();
  /** Beacons bob and turn. Kept in a flat list with their rest height in
   *  userData so update() does no scene-graph search per frame. */
  private beacons: THREE.Object3D[] = [];

  constructor(
    markers: readonly Maps.Marker[],
    terrain: Physics.TerrainData,
    private readonly opts: MarkerViewOptions = {},
  ) {
    for (const marker of markers) {
      // Seated on the sampled ground, not on marker.y: Room parks the
      // vehicle at sampleHeightBilinear too, so anything else would draw
      // the bay off the surface the truck lands on.
      const groundY = Physics.sampleHeightBilinear(terrain, marker.x, marker.z);
      if (marker.kind === 'garageBay') this.buildGarageBay(marker, groundY);
      else if (opts.preview) this.buildAuthoringPuck(marker, groundY);
      if (opts.preview) this.buildRadiusRing(marker, groundY);
    }
  }

  private buildGarageBay(marker: Maps.Marker, groundY: number): void {
    const info = Maps.markerInfo(marker.kind);
    const halfW = marker.radius * BAY.halfWidthPerRadius;
    const halfL = marker.radius * BAY.halfLengthPerRadius;

    const root = new THREE.Group();
    root.position.set(marker.x, groundY, marker.z);
    // yaw rotates local +Z onto the parked heading, matching the spawn and
    // workshop-lease convention: the nose ends up at +Z, so the kerb goes
    // there and you drive in from -Z.
    root.rotation.y = marker.yaw ?? 0;
    this.group.add(root);

    const paint = new THREE.MeshStandardMaterial({ color: PAINT_COLOR, roughness: 0.85 });
    const slabMat = new THREE.MeshStandardMaterial({ color: SLAB_COLOR, roughness: 0.95 });
    const kerbMat = new THREE.MeshStandardMaterial({ color: KERB_COLOR, roughness: 0.8 });

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(halfW * 2, 0.04, halfL * 2),
      slabMat,
    );
    slab.position.set(0, BAY.slabY, 0);
    slab.receiveShadow = true;
    root.add(slab);

    const line = (w: number, d: number, x: number, z: number): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), paint);
      m.position.set(x, BAY.lineY, z);
      root.add(m);
    };
    // Two sides and a head line. The entry edge is deliberately left open
    // so the bay reads as something to drive into rather than a box.
    line(BAY.lineWidth, halfL * 2, -halfW, 0);
    line(BAY.lineWidth, halfL * 2, halfW, 0);
    line(halfW * 2, BAY.lineWidth, 0, halfL);

    // Chevrons pointing at the head of the bay, so the facing is readable
    // from the driver's seat on the way in rather than only from above.
    const armLength = halfW * 0.85;
    for (let i = 0; i < BAY.chevrons; i++) {
      const z = -halfL * 0.75 + (i * halfL * 1.1) / BAY.chevrons;
      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(
          new THREE.BoxGeometry(armLength, 0.05, BAY.chevronWidth),
          paint,
        );
        arm.position.set((side * armLength) / 2, BAY.lineY, z);
        arm.rotation.y = side * 0.62;
        root.add(arm);
      }
    }

    const kerb = new THREE.Mesh(
      new THREE.BoxGeometry(halfW * 1.1, BAY.kerbHeight, BAY.kerbDepth),
      kerbMat,
    );
    kerb.position.set(0, BAY.kerbHeight / 2, halfL - BAY.kerbDepth);
    kerb.castShadow = true;
    root.add(kerb);

    root.add(this.buildBeacon(info.color, halfL));
  }

  /** The floating "park here" chevron, pointing down into the bay.
   *
   *  Unlit on purpose: it has to stay legible in the shadow of the
   *  workshop roof, which is exactly where every bay on the shipped map
   *  sits. It bobs but deliberately does not spin — a flat chevron turned
   *  about Y goes edge-on twice a revolution, and a marker that stops
   *  reading as an arrow half the time is worse than a still one. Held
   *  square to the bay instead, which faces the driver: you approach from
   *  the open end, so the arrow is face-on the whole way in. */
  private buildBeacon(color: number, halfL: number): THREE.Object3D {
    const beacon = new THREE.Group();
    beacon.position.set(0, BAY.beaconY, halfL * 0.15);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(BAY.beaconSize * 1.6, BAY.beaconSize * 0.28, BAY.beaconSize * 0.28),
        mat,
      );
      arm.position.set((side * BAY.beaconSize * 1.6) / 2, 0, 0);
      // Peak up, ends down: an arrowhead aimed at the ground under it.
      arm.rotation.z = side * 0.7;
      beacon.add(arm);
    }
    beacon.userData.restY = beacon.position.y;
    this.beacons.push(beacon);
    return beacon;
  }

  /** Editor-only stand-in for the kinds with no simulation behind them
   *  yet: a post you can see from the fly camera, tinted by kind. */
  private buildAuthoringPuck(marker: Maps.Marker, groundY: number): void {
    const info = Maps.markerInfo(marker.kind);
    const mat = new THREE.MeshBasicMaterial({ color: info.color });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 2.2, 8), mat);
    post.position.set(marker.x, groundY + 1.1, marker.z);
    this.group.add(post);
    const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.42), mat);
    head.position.set(marker.x, groundY + 2.5, marker.z);
    this.group.add(head);
  }

  /** The trigger volume as authored. Drawn as a ground-following ring for
   *  the same reason the brush cursor is one: a flat circle on a slope
   *  reads as a smaller radius than the check actually uses. */
  private buildRadiusRing(marker: Maps.Marker, groundY: number): void {
    const info = Maps.markerInfo(marker.kind);
    const segments = 48;
    const points = new Float32Array((segments + 1) * 3);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      points[i * 3] = marker.x + Math.cos(a) * marker.radius;
      points[i * 3 + 1] = groundY + 0.12;
      points[i * 3 + 2] = marker.z + Math.sin(a) * marker.radius;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
    const ring = new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color: info.color,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    }));
    ring.renderOrder = 997;
    this.group.add(ring);
  }

  /** Self-ticking from performance.now(), like Sky and WaterMesh, so
   *  WorldView.render(camera) keeps its signature. */
  update(): void {
    if (this.beacons.length === 0) return;
    const t = performance.now() / 1000;
    for (const beacon of this.beacons) {
      beacon.position.y = (beacon.userData.restY as number) + Math.sin(t * 1.6) * BAY.beaconBob;
    }
  }

  get isPreview(): boolean {
    return this.opts.preview === true;
  }

  dispose(): void {
    disposeObject3D(this.group);
    this.beacons = [];
  }
}
