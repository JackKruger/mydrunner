// What each tier actually compiles.
//
// These run without a GPU, which is the point: they catch the class of bug
// that otherwise only shows up on a device — a #ifdef that gates the wrong
// block, an octave count that stopped being a constant expression, or a
// high-tier cut that was never meant to reach the desktop image.
//
// The other half of the "high tier is unchanged" argument is the committed
// Playwright screenshots; this half is the one that fails in CI in 20 ms.

import { describe, expect, it } from 'vitest';
import { Physics } from '@mydrunner/shared';
import { QUALITY } from '../quality.js';
import { makeTerrainMaterial } from '../terrainShader.js';
import { makeWaterMaterial } from '../waterShader.js';

function terrain(): Physics.TerrainData {
  return Physics.generateTerrain({ size: 64, resolution: 16, seed: 1 });
}

function terrainSource(tier: 'high' | 'low'): string {
  return makeTerrainMaterial(terrain(), QUALITY[tier]).fragmentShader;
}

function waterSource(tier: 'high' | 'low'): string {
  return makeWaterMaterial(terrain(), QUALITY[tier]).fragmentShader;
}

describe('terrain shader', () => {
  it('keeps the whole boundary-blend pass at high tier and drops it at low', () => {
    // The blend pass is a second dependent texture fetch plus a second full
    // surfaceColor() on roughly a third of ground fragments — the single most
    // expensive thing in the shader.
    expect(terrainSource('high')).toContain('#define TERRAIN_BLEND2 1');
    expect(terrainSource('low')).not.toContain('TERRAIN_BLEND2 1');
  });

  it('compiles the distance fade out entirely at high tier', () => {
    // This is what makes the desktop image bit-identical rather than merely
    // close: with the macro undefined, DETAIL() expands to a bare vnoise call
    // and no mix, branch or uniform read is generated at all.
    expect(terrainSource('high')).not.toContain('#define TERRAIN_DETAIL_FADE');
    expect(terrainSource('low')).toContain('#define TERRAIN_DETAIL_FADE 1');
  });

  it('still interpolates every Surface id into a branch', () => {
    // terrainShader's stated guarantee: renumbering the enum repaints
    // correctly instead of silently painting grass on the road. The refactor
    // that added the `detail` parameter went through this function, so pin it.
    for (const tier of ['high', 'low'] as const) {
      const source = terrainSource(tier);
      for (const id of Object.values(Physics.Surface)) {
        if (typeof id !== 'number') continue;
        expect(source, `${tier} tier, surface ${id}`).toContain(`if (s == ${id})`);
      }
    }
  });

  it('states octave counts as preprocessor constants', () => {
    // GLSL ES 1.00 requires a constant loop bound; a uniform would not link.
    expect(terrainSource('high')).toContain('#define TERRAIN_OCTAVES 3');
    expect(terrainSource('low')).toContain('#define TERRAIN_OCTAVES 2');
  });
});

describe('water shader', () => {
  it('keeps the depth tint and the flow advection at BOTH tiers', () => {
    // Not decoration. The depth tint is the readout a player picks a crossing
    // line by, and the ripples advecting along the flow field are what make a
    // river read as moving and a pond as still. Cutting either would change
    // what the player can tell about the water, which is out of scope for a
    // performance tier.
    for (const tier of ['high', 'low'] as const) {
      const source = waterSource(tier);
      expect(source, tier).toContain('mix(uShallowColor, uDeepColor, t)');
      expect(source, tier).toContain('vec2 q = p - flow * uTime;');
      expect(source, tier).toContain('float frontSlope = cos(frontPhase)');
    }
  });

  it('drops the ripple gradient and filament taps at low tier only', () => {
    expect(waterSource('high')).toContain('#define WATER_RIPPLE_NORMAL 1');
    expect(waterSource('high')).toContain('#define WATER_FILAMENTS 1');
    expect(waterSource('low')).not.toContain('WATER_RIPPLE_NORMAL 1');
    expect(waterSource('low')).not.toContain('WATER_FILAMENTS 1');
  });
});

describe('float precision', () => {
  it('never drops below highp in the procedural shaders', () => {
    // terrainShader scales world coordinates (+/-160 m) by up to 18 and
    // hash21 then multiplies by 456.21, reaching ~1.3e6. mediump is fp16 on
    // Mali/Adreno/Apple (max finite 65504), so the hash overflows to inf and
    // fract(inf) is undefined. Desktop GL treats mediump as fp32, so this
    // would look perfect everywhere it could be tested and be garbage on the
    // phones the low tier exists for.
    for (const tier of ['high', 'low'] as const) {
      expect(terrainSource(tier), tier).toContain('precision highp float;');
      expect(terrainSource(tier), tier).not.toContain('mediump');
      expect(waterSource(tier), tier).toContain('precision highp float;');
      expect(waterSource(tier), tier).not.toContain('mediump');
    }
  });
});
