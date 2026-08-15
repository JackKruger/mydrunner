import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Physics } from '@mydrunner/shared';
import { QUALITY } from '../quality.js';
import { RutVisual } from '../rutVisual.js';
import { TerrainMesh } from '../terrain.js';

function terrain(): Physics.TerrainData {
  const resolution = 8;
  return {
    size: 16,
    resolution,
    heights: new Float32Array(resolution * resolution).fill(2),
    surfaces: new Uint8Array(resolution * resolution).fill(Physics.Surface.Mud),
    seed: 0,
    mountain: Physics.mountainFor(16),
    petrolStation: Physics.petrolStationPadFor(16),
    ...Physics.dryWater(resolution),
    bogs: [],
    roads: [],
  };
}

describe('session rut visual', () => {
  it('draws terrain depth before the rut stencil and floor passes', () => {
    const ground = new TerrainMesh(terrain(), QUALITY.low);
    expect(ground.mesh.renderOrder).toBe(-3);
    ground.dispose();
  });

  it('builds reusable indexed 17x17 geometry from an authoritative tile', () => {
    const visual = new RutVisual();
    visual.setTerrain(terrain());
    const depths = new Uint8Array(Physics.RUT_TILE_DEPTH_BYTES);
    depths[0] = 128;
    visual.applyTile({ tileX: 2, tileZ: 2, depths });
    expect(visual.activeCellCount).toBe(1);
    expect(visual.mesh.visible).toBe(true);
    const positions = visual.mesh.geometry.getAttribute('position');
    const rutDepth = visual.mesh.geometry.getAttribute('rutDepth');
    expect(positions.count).toBe(17 * 17);
    expect(rutDepth.count).toBe(17 * 17);
    expect(visual.mesh.geometry.index?.count).toBe(16 * 16 * 6);
    expect(Array.from({ length: rutDepth.count }, (_, i) => rutDepth.getX(i)))
      .toContain(0);
    expect(Math.max(...Array.from({ length: rutDepth.count }, (_, i) => rutDepth.getX(i))))
      .toBeGreaterThan(0.29);
    // CPU vertices retain terrain height; the shader subtracts rutDepth so
    // the stencil-cut floor is genuinely below the immutable firm layer.
    expect(positions.getY(0)).toBe(2);
    // Terrain renders first, then the depth-tested mask. The recessed floor
    // bypasses the terrain depth only inside that visibility-tested stencil,
    // so a rut behind a hill cannot cut through the nearer slope.
    const mask = visual.group.children.find((child) => child.name.startsWith('session-rut-stencil:')) as
      THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(mask.material.depthTest).toBe(true);
    expect(mask.renderOrder).toBe(-2);
    expect(visual.mesh.material.depthTest).toBe(false);
    expect(visual.mesh.material.depthWrite).toBe(false);
    expect(visual.mesh.renderOrder).toBe(-1);
    visual.dispose();
  });

  it('keeps the no-stencil fallback depth-tested against hills', () => {
    const visual = new RutVisual();
    visual.setStencilSupported(false);
    visual.setTerrain(terrain());
    const depths = new Uint8Array(Physics.RUT_TILE_DEPTH_BYTES);
    depths[0] = 80;
    visual.applyTile({ tileX: 2, tileZ: 2, depths });

    const mask = visual.group.children.find((child) => child.name.startsWith('session-rut-stencil:')) as
      THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(mask.visible).toBe(false);
    expect(visual.mesh.material.depthTest).toBe(true);
    expect(visual.mesh.material.depthWrite).toBe(true);
    expect(visual.mesh.material.uniforms.displace!.value).toBe(0);
    visual.dispose();
  });

  it('replaces a repeated tile instead of duplicating its cells', () => {
    const visual = new RutVisual();
    visual.setTerrain(terrain());
    const depths = new Uint8Array(Physics.RUT_TILE_DEPTH_BYTES);
    depths[4] = 20;
    visual.applyTile({ tileX: 2, tileZ: 2, depths });
    const geometry = visual.tileGeometry(2, 2);
    visual.applyTile({ tileX: 2, tileZ: 2, depths });
    expect(visual.activeCellCount).toBe(1);
    expect(visual.tileGeometry(2, 2)).toBe(geometry);
    visual.dispose();
  });

  it('updates boundary neighbours and disposes tiles that become empty', () => {
    const visual = new RutVisual();
    visual.setTerrain(terrain());
    const depths = new Uint8Array(Physics.RUT_TILE_DEPTH_BYTES);
    depths[0] = 80;
    visual.applyTile({ tileX: 2, tileZ: 2, depths });
    const owner = visual.tileGeometry(2, 2)!;
    const neighbour = visual.tileGeometry(1, 2)!;
    expect(owner).toBeDefined();
    expect(neighbour).toBeDefined();
    let ownerDisposed = false;
    let neighbourDisposed = false;
    owner.addEventListener('dispose', () => { ownerDisposed = true; });
    neighbour.addEventListener('dispose', () => { neighbourDisposed = true; });

    visual.applyTile({ tileX: 2, tileZ: 2, depths: new Uint8Array(depths.length) });
    expect(visual.activeCellCount).toBe(0);
    expect(visual.activeTileCount).toBe(0);
    expect(ownerDisposed).toBe(true);
    expect(neighbourDisposed).toBe(true);
    visual.dispose();
  });
});
