// Diagnostic screenshots of the mountain trail entrance + first traverse.
// Tagged @screenshot so it only runs when explicitly invoked.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';

test.describe('@trail-shots', () => {
  test('trail entrance + climb visualisation', async ({ page }) => {
    test.setTimeout(180_000);
    const outDir = join(process.cwd(), 'screenshots');
    mkdirSync(outDir, { recursive: true });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?auto=1');
    await expect(page.locator('#hud')).toContainText('connected', { timeout: 30_000 });
    await page.waitForTimeout(1500);

    // Move the camera manually to look at specific spots. We override the
    // chase camera's per-frame apply() so it stops resetting position,
    // then store the latest manual pose and have the patched apply() set
    // exactly that pose every frame.
    await page.evaluate(() => {
      const w = window as unknown as { __scene?: any };
      if (!w.__scene) return;
      const s = w.__scene;
      const cam = s.camera;
      const desired = { px: 0, py: 50, pz: -100, lx: 0, ly: 0, lz: 0 };
      (w as any).__desired = desired;
      if (s.cam && typeof s.cam.apply === 'function') {
        s.cam.apply = () => {
          cam.position.set(desired.px, desired.py, desired.pz);
          cam.lookAt(desired.lx, desired.ly, desired.lz);
        };
      }
      (w as any).__setCam = (px: number, py: number, pz: number, lx: number, ly: number, lz: number) => {
        desired.px = px; desired.py = py; desired.pz = pz;
        desired.lx = lx; desired.ly = ly; desired.lz = lz;
      };
    });

    // Production room is 320×320; mountain at (73.6, 115.2), trail at x=58.6
    // running from z=-50 (road) to z=17.9 (mountain base). roadZ = -50.

    // Frame 1: looking north up the trail entrance from on the main road,
    // 30m south of the entrance.
    await page.evaluate(() => (window as any).__setCam(58.6, 6, -78, 58.6, 8, -45));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '20-trail-entrance-from-road.png') });

    // Frame 2: angled overview from the south-west, showing the trail
    // climbing into the mountain face.
    await page.evaluate(() => (window as any).__setCam(20, 30, -85, 60, 18, 18));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '21-trail-overview-sw.png') });

    // Frame 3: looking east along the trail at the trail-to-traverse
    // junction (where the dirt connector meets traverse 1).
    await page.evaluate(() => (window as any).__setCam(40, 22, 18, 70, 22, 22));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '22-trail-junction.png') });

    // Frame 4: high overview of the entire mountain south face so the
    // switchback path is visible end-to-end.
    await page.evaluate(() => (window as any).__setCam(73.6, 110, -120, 73.6, 30, 80));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '23-mountain-overview.png') });

    // Frame 5: ground-level, mid-trail, looking north (uphill).
    await page.evaluate(() => (window as any).__setCam(58.6, 8, -10, 58.6, 14, 18));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, '24-trail-mid-up.png') });
  });
});
