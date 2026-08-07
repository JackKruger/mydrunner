// The water mesh's contract with its shader: which vertices are flagged
// wet, how deep they say they are, and where the dry ones sit.

import { describe, expect, it } from 'vitest';
import { Physics } from '@mydrunner/shared';
import * as THREE from 'three';
import { WaterMesh } from '../water.js';

const SIZE = 40;
const RES = 8;

function terrain(): Physics.TerrainData {
  return {
    size: SIZE,
    resolution: RES,
    heights: new Float32Array(RES * RES),
    surfaces: new Uint8Array(RES * RES),
    seed: 0,
    mountain: Physics.mountainFor(SIZE),
    petrolStation: Physics.petrolStationPadFor(SIZE),
    ...Physics.dryWater(RES),
    bogs: [],
    roads: [],
  };
}

function attr(mesh: WaterMesh, name: string): Float32Array {
  return (mesh.mesh.geometry.getAttribute(name) as THREE.BufferAttribute).array as Float32Array;
}

function positionY(mesh: WaterMesh, i: number): number {
  return attr(mesh, 'position')[i * 3 + 1]!;
}

describe('WaterMesh', () => {
  it('flags only the wet cells', () => {
    const t = terrain();
    t.waterLevel[10] = 0.5;
    t.waterLevel[11] = 0.5;
    const m = new WaterMesh(t);
    const wet = attr(m, 'aWet');
    expect(wet[10]).toBe(1);
    expect(wet[11]).toBe(1);
    expect(wet[12]).toBe(0);
    expect(wet[0]).toBe(0);
    m.dispose();
  });

  it('carries depth per vertex, not level', () => {
    // The shader tints by depth; handing it the absolute level would make
    // a pond high on a hill read as deeper than one in a valley.
    const t = terrain();
    t.heights[10] = -1.2;
    t.waterLevel[10] = 0.3;
    const m = new WaterMesh(t);
    expect(attr(m, 'aDepth')[10]).toBeCloseTo(1.5, 5);
    m.dispose();
  });

  it('puts wet vertices at the water level', () => {
    const t = terrain();
    t.heights[20] = -2;
    t.waterLevel[20] = 0.75;
    const m = new WaterMesh(t);
    expect(positionY(m, 20)).toBeCloseTo(0.75, 5);
    m.dispose();
  });

  it('parks dry vertices on the bed, never at the sentinel', () => {
    // A vertex left at WATER_NONE (-1e9) blows up the bounding sphere,
    // which stops the mesh being culled and breaks editor raycasts
    // against it. The fragment shader discards dry vertices either way,
    // so the position is invisible - and that is exactly why getting it
    // wrong would be hard to spot.
    const t = terrain();
    t.heights.fill(3.5);
    t.waterLevel[5] = 4;
    const m = new WaterMesh(t);
    expect(positionY(m, 0)).toBeCloseTo(3.5, 5);
    const sphere = m.mesh.geometry.boundingSphere;
    expect(sphere).not.toBeNull();
    expect(Number.isFinite(sphere!.radius)).toBe(true);
    expect(sphere!.radius).toBeLessThan(SIZE * 2);
    m.dispose();
  });

  it('treats water below the bed as dry', () => {
    const t = terrain();
    t.heights[7] = 2;
    t.waterLevel[7] = 1; // authored under the ground
    const m = new WaterMesh(t);
    expect(attr(m, 'aWet')[7]).toBe(0);
    m.dispose();
  });

  it('picks up edits through updateWater', () => {
    const t = terrain();
    const m = new WaterMesh(t);
    expect(attr(m, 'aWet')[30]).toBe(0);

    t.waterLevel[30] = 1.25;
    m.updateWater({ r0: 0, c0: 0, rows: RES, cols: RES });
    expect(attr(m, 'aWet')[30]).toBe(1);
    expect(positionY(m, 30)).toBeCloseTo(1.25, 5);
    m.dispose();
  });

  it('re-reads depth when the bed moves under standing water', () => {
    // Sculpting under a pond changes its depth without touching the
    // water grid, so the editor has to be able to refresh from a height
    // edit alone.
    const t = terrain();
    t.waterLevel[30] = 0;
    const m = new WaterMesh(t);
    expect(attr(m, 'aDepth')[30]).toBeCloseTo(0, 5);

    t.heights[30] = -2;
    m.updateWater({ r0: 0, c0: 0, rows: RES, cols: RES });
    expect(attr(m, 'aDepth')[30]).toBeCloseTo(2, 5);
    m.dispose();
  });

  it('advances its own ripple clock', () => {
    const t = terrain();
    t.waterLevel.fill(1);
    const m = new WaterMesh(t);
    const mat = m.mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.uTime!.value).toBe(0);
    m.update();
    expect(mat.uniforms.uTime!.value).toBeGreaterThanOrEqual(0);
    m.dispose();
  });

  it('keeps the packed flow range available to the shader in m/s', () => {
    // The texture stores a normalised byte pair, but animation happens in
    // world metres. Losing this decode scale made a 1 m/s river appear to
    // crawl at one quarter speed even though the physics current was real.
    const t = terrain();
    t.waterLevel.fill(1);
    t.waterFlowX.fill(2);
    const m = new WaterMesh(t);
    const mat = m.mesh.material as THREE.ShaderMaterial;
    const range = mat.uniforms.uFlowRange!.value as number;
    const tex = mat.uniforms.uFlowMap!.value as THREE.DataTexture;
    const packed = (tex.image.data as Uint8Array)[0]! / 255;
    const decoded = (packed * 2 - 1) * range;
    expect(range).toBe(4);
    expect(decoded).toBeCloseTo(2, 1);
    m.dispose();
  });

  it('draws transparent and after the opaque world', () => {
    const t = terrain();
    t.waterLevel.fill(1);
    const m = new WaterMesh(t);
    const mat = m.mesh.material as THREE.ShaderMaterial;
    expect(mat.transparent).toBe(true);
    // depthWrite off is what lets the bed show through the shallow tint.
    expect(mat.depthWrite).toBe(false);
    expect(m.mesh.renderOrder).toBeGreaterThan(0);
    m.dispose();
  });
});
