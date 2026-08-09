import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASES = [
  'ridgeback',
  'overlander',
  'stockman-single',
  'stockman-dual',
  'longreach',
  'outclaw',
  'dustback-rs',
] as const;

async function setReviewBuild(page: Page, baseId: typeof BASES[number], rear = 'option-b'): Promise<void> {
  await page.evaluate(({ baseId, rear }) => {
    const workshop = (window as unknown as {
      __workshop: {
        setReviewBuild(build: Record<string, unknown>): void;
      };
    }).__workshop;
    workshop.setReviewBuild({
      version: 1,
      baseId,
      paintColor: '#c84c32',
      paintFinish: 'gloss',
      suspensionId: `${baseId}.suspension.factory`,
      tireId: `${baseId}.tire.factory`,
      wheelId: `${baseId}.wheel.factory`,
      axleId: `${baseId}.axle.factory`,
      frontBarId: baseId === 'dustback-rs' ? `${baseId}.frontBar.lamp-pod` : `${baseId}.frontBar.steel-winch`,
      winchId: baseId === 'dustback-rs' ? `${baseId}.winch.none` : `${baseId}.winch.fitted`,
      snorkelId: baseId === 'dustback-rs' ? `${baseId}.snorkel.none` : `${baseId}.snorkel.fitted`,
      roofId: baseId === 'dustback-rs' ? `${baseId}.roof.rally-vent` : `${baseId}.roof.platform-awning`,
      rearBodyId: `${baseId}.rearBody.${rear}`,
      frontLocker: false,
      rearLocker: false,
    });
  }, { baseId, rear });
  await page.waitForTimeout(100);
}

async function setOrbit(page: Page, yaw: number): Promise<void> {
  await page.evaluate((reviewYaw) => {
    (window as unknown as { __workshop: { setReviewOrbit(yaw: number, pitch: number): void } })
      .__workshop.setReviewOrbit(reviewYaw, 0.24);
  }, yaw);
  await page.waitForTimeout(100);
}

test.describe('@screenshot vehicle attachment placement', () => {
  test('captures every fully fitted base from three review angles', async ({ page }) => {
    test.setTimeout(180_000);
    const outDir = join(process.cwd(), 'screenshots', 'vehicle-placement');
    mkdirSync(outDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?auto=1&name=attachment-review');
    await expect(page.locator('#hud')).toContainText('connected', { timeout: 15_000 });
    await page.waitForFunction(() => Boolean((window as unknown as { __localSimulation?: unknown }).__localSimulation));
    await page.evaluate(() => {
      const simulation = (window as unknown as {
        __localSimulation: { resetTo(pose: { position: { x: number; y: number; z: number }; yaw: number }): void };
      }).__localSimulation;
      simulation.resetTo({ position: { x: -58, y: 2.2, z: -28.5 }, yaw: Math.PI });
    });
    await expect(page.locator('#workshop-prompt')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('KeyF');
    await expect(page.locator('#workshop-overlay')).toBeVisible({ timeout: 10_000 });

    for (const baseId of BASES) {
      await setReviewBuild(page, baseId);
      const stage = page.locator('.workshop-stage');
      await setOrbit(page, 0.65);
      await stage.screenshot({ path: join(outDir, `${baseId}-front-three-quarter.png`) });
      await setOrbit(page, 1.45);
      await stage.screenshot({ path: join(outDir, `${baseId}-side.png`) });
      await setOrbit(page, 2.25);
      await stage.screenshot({ path: join(outDir, `${baseId}-rear-three-quarter.png`) });

      if (baseId === 'stockman-single' || baseId === 'stockman-dual') {
        await setReviewBuild(page, baseId, 'option-a');
        await setOrbit(page, 1.45);
        await stage.screenshot({ path: join(outDir, `${baseId}-low-rear-side.png`) });
      }
    }
  });
});
