// Deliberate high/low pairs for reviewing post-processing. These are artifact
// screenshots rather than golden pixel tests: SSAO varies slightly across GPU
// implementations, while side-by-side framing still exposes crushed shadows,
// sky halos, excess saturation, and bloom leaking beyond water highlights.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const views = [
  ['wheel-wells', { x: -3, y: 3.4, z: -6 }, { x: 0, y: 1, z: 0 }],
  ['rocks', { x: 40, y: 12, z: 12 }, { x: 62, y: 8, z: 22 }],
  ['building-corners', { x: -55, y: 7, z: -12 }, { x: -55, y: 1, z: -29 }],
  ['forest-depth', { x: -102, y: 5, z: 45 }, { x: -90, y: 1, z: 61 }],
  ['water-highlights', { x: -78, y: 14, z: -50 }, { x: -30, y: -1, z: -52 }],
] as const;

async function openAtTier(page: Page, tier: 'high' | 'low'): Promise<void> {
  await page.goto(`/?auto=1&q=${tier}`);
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 30_000 });
  // The HUD must remain a sibling DOM overlay, never a child or texture of
  // the post-processed WebGL canvas.
  await expect.poll(() => page.evaluate(() => {
    const hud = document.querySelector('#hud');
    const canvas = document.querySelector('canvas');
    return Boolean(hud && canvas && !canvas.contains(hud));
  })).toBe(true);
}

test.describe('@screenshot post-processing review', () => {
  test('high tier against the unprocessed low-tier reference', async ({ page }) => {
    test.setTimeout(180_000);
    const outDir = join(process.cwd(), 'screenshots', 'post-processing');
    mkdirSync(outDir, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    for (const tier of ['low', 'high'] as const) {
      await openAtTier(page, tier);
      for (const [name, position, lookAt] of views) {
        await page.evaluate(([p, l]) => {
          (window as any).__scene.setReviewView(p, l);
        }, [position, lookAt]);
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(outDir, `${name}-${tier}.png`) });
      }
    }
  });
});
