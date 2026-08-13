// Visual record of the touch HUD. Tagged @screenshot so it only runs when
// explicitly invoked.
//
// The mobile layout is the one part of the UI whose failure mode is "it
// works, it is just in the way", and no assertion catches that. The overlap
// test in player-ui.spec.ts pins that the panels do not collide; these
// frames are what tells a reader how much of the windscreen they cost.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PHONES = [
  { name: 'landscape', width: 851, height: 393 },
  { name: 'portrait', width: 393, height: 851 },
] as const;

test.describe('@screenshot', () => {
  test('touch HUD over the world, tray closed and open', async ({ page }) => {
    test.setTimeout(180_000);
    const outDir = join(process.cwd(), 'screenshots', 'mobile');
    mkdirSync(outDir, { recursive: true });

    await page.setViewportSize({ width: PHONES[0].width, height: PHONES[0].height });
    await page.goto('/?auto=1&name=mobile-hud');
    await expect(page.locator('#hud')).toContainText('connected', { timeout: 60_000 });
    // The real device path adds this from `initTouchInput`; a desktop
    // Chromium never reports touch, so the layout has to be asked for.
    await page.evaluate(() => document.body.classList.add('touch'));

    // Roll forward a little so the frames show the HUD over ground and
    // horizon rather than over the spawn pad.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2200);
    await page.keyboard.up('KeyW');

    for (const phone of PHONES) {
      await page.setViewportSize({ width: phone.width, height: phone.height });
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(outDir, `${phone.name}-trail.png`) });

      // Worst case: the pit half of the tray out and the gear gate open.
      await page.locator('#aux-more-btn').dispatchEvent('pointerdown', { pointerId: 11 });
      await page.locator('#shifter-collapse').click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(outDir, `${phone.name}-open.png`) });

      await page.locator('#aux-more-btn').dispatchEvent('pointerdown', { pointerId: 11 });
      await page.locator('#shifter-collapse').click();
    }
  });
});
