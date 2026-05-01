// Not a real test - tagged @screenshot so it only runs when explicitly
// asked for. Drives a vehicle around and saves a series of screenshots
// so we have visual proof the game looks right.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test.describe('@screenshot', () => {
  test('drive a lap and capture frames', async ({ page }) => {
    const outDir = join(process.cwd(), 'screenshots');
    mkdirSync(outDir, { recursive: true });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });

    // Wait a beat for terrain mesh to render.
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, '01-spawn.png') });

    // Drive forward.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(outDir, '02-driving.png') });

    // Steer right.
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, '03-turning.png') });

    await page.keyboard.up('KeyD');
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, '04-counter-steer.png') });

    await page.keyboard.up('KeyA');
    // Go off road into mud.
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(2500);
    await page.keyboard.up('KeyD');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(outDir, '05-into-mud.png') });

    // Cycle camera mode (chase -> hood).
    await page.keyboard.up('KeyW');
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(500);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, '06-hood-cam.png') });

    await page.keyboard.up('KeyW');
  });
});
