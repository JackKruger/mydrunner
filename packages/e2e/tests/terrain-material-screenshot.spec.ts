import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const views = [
  { name: 'grass', cam: [-55, 9, -72], look: [-35, 1, -42] },
  { name: 'mud', cam: [42, 10, 5], look: [64, 2, 21] },
  { name: 'gravel', cam: [38, 62, 76], look: [56, 47, 61] },
  { name: 'steep-slope', cam: [116, 54, 42], look: [53, 34, 66] },
] as const;

test.describe('@terrain-material-shots', () => {
  test('grass, mud, gravel, and cliff projection', async ({ page }) => {
    test.setTimeout(180_000);
    const outDir = join(process.cwd(), 'screenshots', 'terrain-materials');
    mkdirSync(outDir, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?auto=1&q=high');
    await expect(page.locator('#hud')).toContainText('connected', { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelectorAll('canvas').length > 0);
    await page.waitForTimeout(1500); // allow the asynchronous material maps to settle
    for (const view of views) {
      await page.evaluate(({ cam, look }) => {
        const scene = (window as any).__scene;
        scene.setReviewView({ x: cam[0], y: cam[1], z: cam[2] }, { x: look[0], y: look[1], z: look[2] });
      }, view);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(outDir, `${view.name}.png`) });
    }
  });
});
