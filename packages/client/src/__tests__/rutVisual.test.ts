import { describe, expect, it } from 'vitest';
import { Physics } from '@mydrunner/shared';
import { RutVisual } from '../rutVisual.js';

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
  it('builds persistent feathered geometry from an authoritative tile', () => {
    const visual = new RutVisual();
    visual.setTerrain(terrain());
    const depths = new Uint8Array(Physics.RUT_TILE_DEPTH_BYTES);
    depths[0] = 128;
    visual.applyTile({ tileX: 2, tileZ: 2, depths });
    expect(visual.activeCellCount).toBe(1);
    expect(visual.mesh.visible).toBe(true);
    const positions = visual.mesh.geometry.getAttribute('position');
    const rutDepth = visual.mesh.geometry.getAttribute('rutDepth');
    // One non-zero field sample contributes to its four adjoining quads so
    // interpolation can fade the track to zero instead of drawing a square.
    expect(positions.count).toBe(24);
    expect(rutDepth.count).toBe(24);
    expect(Array.from({ length: rutDepth.count }, (_, i) => rutDepth.getX(i)))
      .toContain(0);
    expect(Math.max(...Array.from({ length: rutDepth.count }, (_, i) => rutDepth.getX(i))))
      .toBeGreaterThan(0.29);
    // CPU vertices retain terrain height; the shader subtracts rutDepth so
    // the stencil-cut floor is genuinely below the immutable firm layer.
    expect(positions.getY(0)).toBe(2);
    expect(visual.mesh.material.depthTest).toBe(true);
    expect(visual.mesh.material.depthWrite).toBe(true);
    visual.dispose();
  });

  it('replaces a repeated tile instead of duplicating its cells', () => {
    const visual = new RutVisual();
    visual.setTerrain(terrain());
    const depths = new Uint8Array(Physics.RUT_TILE_DEPTH_BYTES);
    depths[4] = 20;
    visual.applyTile({ tileX: 2, tileZ: 2, depths });
    visual.applyTile({ tileX: 2, tileZ: 2, depths });
    expect(visual.activeCellCount).toBe(1);
    visual.dispose();
  });
});
