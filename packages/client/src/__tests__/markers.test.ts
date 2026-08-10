// What a garage bay looks like, and what the game is willing to draw.
//
// The bay is the only marker the simulation reads, and the whole point of
// building it from the marker rather than from the petrol station's
// hardcoded stripes is that the paint and the trigger volume are the same
// number. These tests pin that, plus the split between what the editor
// shows an author and what the game shows a player.

import { describe, expect, it } from 'vitest';
import { Maps, Physics } from '@mydrunner/shared';
import * as THREE from 'three';
import { MarkerMeshes } from '../markers.js';

const SIZE = 40;
const RES = 8;

function terrain(groundY = 0): Physics.TerrainData {
  return {
    size: SIZE,
    resolution: RES,
    heights: new Float32Array(RES * RES).fill(groundY),
    surfaces: new Uint8Array(RES * RES),
    seed: 0,
    mountain: Physics.mountainFor(SIZE),
    petrolStation: Physics.petrolStationPadFor(SIZE),
    ...Physics.dryWater(RES),
    bogs: [],
    roads: [],
  };
}

function marker(over: Partial<Maps.Marker> = {}): Maps.Marker {
  return {
    id: 'bay-1',
    kind: 'garageBay',
    x: 4,
    y: 0,
    z: -6,
    yaw: Math.PI,
    radius: 1.65,
    label: 'Workshop bay 1',
    ...over,
  };
}

/** Every mesh in the tree, world transforms resolved. */
function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((n) => { if ((n as THREE.Mesh).isMesh) out.push(n as THREE.Mesh); });
  return out;
}

describe('the garage bay visual', () => {
  it('sits on the ground at the marker, turned to its parked facing', () => {
    const view = new MarkerMeshes([marker()], terrain(3.5));
    const bay = view.group.children[0]!;
    expect(bay.position.x).toBeCloseTo(4, 6);
    expect(bay.position.z).toBeCloseTo(-6, 6);
    // Seated on sampled ground, not on the marker's own y field — Room
    // parks the vehicle at the sampled height too.
    expect(bay.position.y).toBeCloseTo(3.5, 6);
    expect(bay.rotation.y).toBeCloseTo(Math.PI, 6);
    view.dispose();
  });

  it('scales its painted box from the marker radius', () => {
    const small = new MarkerMeshes([marker({ radius: 1.65 })], terrain());
    const large = new MarkerMeshes([marker({ radius: 3 })], terrain());
    const spread = (view: MarkerMeshes): number => {
      const box = new THREE.Box3().setFromObject(view.group);
      return box.max.x - box.min.x;
    };
    // A bay you can drive a 1.7 m wide truck into, and one you could park
    // two in — the same marker field drives both.
    expect(spread(small)).toBeGreaterThan(1.7);
    expect(spread(large)).toBeGreaterThan(spread(small) * 1.5);
    small.dispose();
    large.dispose();
  });

  it('paints the head of the bay on the side the nose ends up', () => {
    // yaw 0 means the parked vehicle faces world +Z, so the kerb it stops
    // against belongs at +Z. A sign error here puts the wheel stop behind
    // the driver and the chevrons pointing out of the bay.
    const view = new MarkerMeshes([marker({ yaw: 0, x: 0, z: 0 })], terrain());
    // Everything standing off the ground: the wheel stop and the beacon.
    // The paint itself is centred, so it is the raised pieces that carry
    // the facing.
    const raised = meshes(view.group)
      .map((m) => new THREE.Box3().setFromObject(m))
      .filter((b) => b.max.y > 0.1);
    expect(raised.length).toBeGreaterThan(0);
    for (const box of raised) expect((box.min.z + box.max.z) / 2).toBeGreaterThan(0);
    view.dispose();
  });

  it('bobs the beacon without moving the paint', () => {
    const view = new MarkerMeshes([marker()], terrain());
    const painted = meshes(view.group).map((m) => m.getWorldPosition(new THREE.Vector3()).y);
    view.update();
    view.update();
    const after = meshes(view.group).map((m) => m.getWorldPosition(new THREE.Vector3()).y);
    // The beacon arms move; everything on the ground stays where it was.
    const moved = after.filter((y, i) => Math.abs(y - painted[i]!) > 1e-6);
    expect(moved.length).toBeGreaterThan(0);
    for (const y of moved) expect(y).toBeGreaterThan(2);
    view.dispose();
  });
});

describe('what each surface draws', () => {
  const kinds = Maps.MARKER_KINDS.map((kind) =>
    marker({ id: kind, kind, x: 0, z: 0, radius: Maps.markerInfo(kind).defaultRadius }));

  it('draws only the simulated kind in the game', () => {
    const view = new MarkerMeshes(kinds, terrain());
    // One bay, and nothing for the four kinds with no behaviour behind
    // them yet — a ring the player cannot use is a promise the build
    // does not keep.
    expect(view.group.children).toHaveLength(1);
    expect(view.isPreview).toBe(false);
    view.dispose();
  });

  it('draws every kind plus its trigger radius in the editor', () => {
    const view = new MarkerMeshes(kinds, terrain(), { preview: true });
    const rings = view.group.children.filter((c) => (c as THREE.Line).isLine);
    expect(rings).toHaveLength(kinds.length);
    expect(view.group.children.length).toBeGreaterThan(kinds.length);
    expect(view.isPreview).toBe(true);
    view.dispose();
  });

  it('draws nothing at all for a map with no markers', () => {
    const view = new MarkerMeshes([], terrain(), { preview: true });
    expect(view.group.children).toHaveLength(0);
    view.update();
    view.dispose();
  });
});
