import { beforeEach, describe, expect, it } from 'vitest';
import {
  QUALITY,
  detectTier,
  glslPrelude,
  resetQuality,
  resolveTier,
  type QualitySettings,
} from '../quality.js';

const storageData = new Map<string, string>();
const storage: Storage = {
  get length() { return storageData.size; },
  clear() { storageData.clear(); },
  getItem(key) { return storageData.get(key) ?? null; },
  key(index) { return [...storageData.keys()][index] ?? null; },
  removeItem(key) { storageData.delete(key); },
  setItem(key, value) { storageData.set(key, String(value)); },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

/** jsdom has no layout and no matchMedia by default, so the heuristic's two
 *  inputs are stubbed directly. */
function stubDevice(opts: { coarse: boolean; width: number; height: number; uaMobile?: boolean }): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('coarse') && opts.coarse }),
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: opts.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: opts.height });
  Object.defineProperty(navigator, 'userAgentData', {
    configurable: true,
    value: opts.uaMobile === undefined ? undefined : { mobile: opts.uaMobile },
  });
}

function stubSearch(search: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, search },
  });
}

beforeEach(() => {
  localStorage.clear();
  resetQuality();
  stubSearch('');
  stubDevice({ coarse: false, width: 1920, height: 1080 });
});

describe('device heuristic', () => {
  it('trusts userAgentData.mobile when the browser reports it', () => {
    stubDevice({ coarse: false, width: 1920, height: 1080, uaMobile: true });
    expect(detectTier()).toBe('low');
    stubDevice({ coarse: true, width: 390, height: 844, uaMobile: false });
    expect(detectTier()).toBe('high');
  });

  it('needs BOTH a coarse pointer and a small viewport', () => {
    // A touchscreen laptop or 2-in-1 reports a coarse pointer and is not
    // fill-bound. Demoting it on the pointer alone would cost those users
    // the full-detail image for nothing.
    stubDevice({ coarse: true, width: 1920, height: 1200 });
    expect(detectTier()).toBe('high');

    stubDevice({ coarse: true, width: 390, height: 844 });
    expect(detectTier()).toBe('low');

    // A small window on a desktop is still a desktop.
    stubDevice({ coarse: false, width: 640, height: 480 });
    expect(detectTier()).toBe('high');
  });
});

describe('tier resolution', () => {
  it('lets the URL override a saved choice and the device', () => {
    localStorage.setItem('mydrunner.options.v1', JSON.stringify({ graphics: 'low' }));
    stubDevice({ coarse: true, width: 390, height: 844 });
    stubSearch('?q=high');
    expect(resolveTier()).toBe('high');
  });

  it('lets a saved choice override the device', () => {
    localStorage.setItem('mydrunner.options.v1', JSON.stringify({ graphics: 'low' }));
    expect(resolveTier()).toBe('low');
  });

  it('falls through to the device on auto', () => {
    localStorage.setItem('mydrunner.options.v1', JSON.stringify({ graphics: 'auto' }));
    stubDevice({ coarse: true, width: 390, height: 844 });
    expect(resolveTier()).toBe('low');
  });

  it('ignores an unrecognised URL value rather than resolving to nothing', () => {
    stubSearch('?q=ultra');
    expect(resolveTier()).toBe('high');
  });
});

describe('the quality table', () => {
  it('never makes the low tier more expensive than the high one', () => {
    // The guard against someone adding a knob and wiring it backwards. Every
    // numeric field is a budget and every boolean is a feature, so low must
    // be <= high on the numbers and must not enable anything high disables.
    const budgets: (keyof QualitySettings)[] = [
      'pixelRatioCap', 'terrainOctaves', 'cloudOctaves', 'waterOctaves',
      'maxParticles', 'particleDensity', 'particleAtlasFrames', 'softParticles',
      'effectDrawDistance', 'trackSegments', 'menuPanoramaHz',
      'groundCoverDensity', 'groundCoverDrawDistance',
    ];
    for (const field of budgets) {
      expect(QUALITY.low[field], field).toBeLessThanOrEqual(QUALITY.high[field] as number);
    }

    const features: (keyof QualitySettings)[] = [
      'antialias', 'shadows', 'terrainSecondaryBlend', 'cloudFineLayer',
      'waterRippleNormal', 'waterFilaments', 'detailedSuspension',
    ];
    for (const field of features) {
      if (QUALITY.low[field]) expect(QUALITY.high[field], field).toBe(true);
    }
  });

  it('keeps high-tier terrain detail past anything the camera can reach', () => {
    // The far plane is 500 m. Pushing the fade band beyond it is what makes
    // the high-tier `detail` term a constant 1.0, so the desktop image is
    // the same shader output it was before the low tier existed.
    expect(QUALITY.high.terrainDetailNear).toBeGreaterThan(500);
    expect(QUALITY.high.terrainDetailFar).toBeGreaterThan(QUALITY.high.terrainDetailNear);
  });
});

describe('glsl prelude', () => {
  it('states every octave count as a preprocessor constant', () => {
    // GLSL ES 1.00 requires a constant loop bound, so these must be #defines
    // rather than uniforms.
    const high = glslPrelude(QUALITY.high);
    expect(high).toContain('#define TERRAIN_OCTAVES 3');
    expect(high).toContain('#define CLOUD_OCTAVES 5');
    expect(high).toContain('#define WATER_OCTAVES 3');

    const low = glslPrelude(QUALITY.low);
    expect(low).toContain('#define TERRAIN_OCTAVES 2');
    expect(low).toContain('#define CLOUD_OCTAVES 3');
    expect(low).toContain('#define WATER_OCTAVES 2');
  });

  it('gates the optional passes on the high tier only', () => {
    const high = glslPrelude(QUALITY.high);
    for (const flag of ['TERRAIN_BLEND2', 'CLOUD_FINE', 'WATER_RIPPLE_NORMAL', 'WATER_FILAMENTS']) {
      expect(high).toContain(`#define ${flag} 1`);
    }
    const low = glslPrelude(QUALITY.low);
    for (const flag of ['TERRAIN_BLEND2', 'CLOUD_FINE', 'WATER_RIPPLE_NORMAL', 'WATER_FILAMENTS']) {
      expect(low).not.toContain(flag);
    }
  });

  it('never lowers float precision', () => {
    // This is the one that matters most and is the hardest to catch by eye.
    //
    // terrainShader scales world coordinates (+/-160 m) by up to 18 and
    // hash21 then multiplies by 456.21, so intermediates reach ~1.3e6.
    // mediump is fp16 on Mali/Adreno/Apple with a max finite value of 65504:
    // the hash overflows to inf and fract(inf) is undefined. Desktop GL
    // treats mediump as fp32, so lowering it would look perfect on every
    // machine we can test on and be garbage on the phones this tier exists
    // for. Cut the number of noise taps, never the precision.
    for (const tier of [QUALITY.high, QUALITY.low]) {
      expect(glslPrelude(tier)).not.toContain('mediump');
      expect(glslPrelude(tier)).not.toContain('lowp');
    }
  });
});
