// Not a real test - tagged @screenshot so it only runs when explicitly
// asked for. Drives a vehicle around and saves a series of screenshots
// so we have visual proof the game looks right.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test.describe('@screenshot', () => {
  test('drive a lap and capture frames', async ({ page }) => {
    test.setTimeout(180_000);
    const outDir = join(process.cwd(), 'screenshots');
    mkdirSync(outDir, { recursive: true });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?auto=1');
    await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });

    // Expose diagnostics from the running scene.
    await page.evaluate(() => {
      const w = window as unknown as { __scene?: unknown };
      // The Scene instance is a module-level local; we can't reach it directly.
      // Instead, walk the renderer canvas to read scene children.
    });

    // Wait a beat for terrain mesh to render.
    await page.waitForTimeout(800);
    const diag = await page.evaluate(() => {
      const out: Record<string, unknown> = {};
      const w = window as unknown as { __scene?: any; __localSimulation?: any };
      out.hud = (document.querySelector('#hud') as HTMLElement | null)?.textContent;
      if (w.__scene) {
        const s = w.__scene;
        out.cameraPos = s.camera?.position?.toArray?.();
        out.cameraYaw = s.cameraYaw;
        out.cameraTarget = s.cameraTarget?.toArray?.();
        out.cameraMode = s.cameraMode;
        out.sceneChildren = s.scene?.children?.length;
        const ids = [...(s.vehicles?.keys?.() ?? [])];
        out.vehicleIds = ids;
        out.localId = s.localId;
      }
      if (w.__localSimulation) {
        out.localState = w.__localSimulation.state?.();
      }
      return out;
    });
    console.log('DIAG@01', JSON.stringify(diag));
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

  // The river ford across the main road.
  //
  // The establishing shot uses the setReviewView debug hook rather than
  // driving to a position: the truck is being shoved downstream while it
  // crosses, so a "drive until x > N" poll frames a different piece of
  // river every run and the sequence comes out in the wrong order.
  test('cross the river ford', async ({ page }) => {
    test.setTimeout(180_000);
    const outDir = join(process.cwd(), 'screenshots');
    mkdirSync(outDir, { recursive: true });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?auto=1&car=patrol');
    await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });
    await page.waitForTimeout(800);

    // Locked overview looking east down the road at the crossing.
    await page.evaluate(() => {
      const w = window as unknown as { __scene: { setReviewView: (p: unknown, l: unknown) => void } };
      w.__scene.setReviewView({ x: -78, y: 14, z: -50 }, { x: -30, y: -1, z: -52 });
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(outDir, '30-ford-overview.png') });

    // Downstream, where the river is deep enough to float a truck.
    await page.evaluate(() => {
      const w = window as unknown as { __scene: { setReviewView: (p: unknown, l: unknown) => void } };
      w.__scene.setReviewView({ x: -70, y: 20, z: -95 }, { x: -42, y: -1, z: -78 });
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(outDir, '31-river-downstream.png') });

    // Back to the chase camera and drive in.
    await page.evaluate(() => {
      const w = window as unknown as { __scene: { setReviewView: (p: unknown, l: unknown) => void } };
      w.__scene.setReviewView(null, null);
    });
    await page.waitForTimeout(300);

    // Drive until the HUD reports water, then hold for the wading shot.
    await page.keyboard.down('KeyW');
    await expect(page.locator('#hud-surface')).toContainText(/water \d/, { timeout: 40_000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(outDir, '32-ford-wading.png') });

    await page.waitForTimeout(1400);
    await page.screenshot({ path: join(outDir, '33-ford-crossing.png') });
    await page.keyboard.up('KeyW');
  });

  // The bike drowns at the ford: the per-kind air intake, made visible.
  test('drown the motorbike', async ({ page }) => {
    test.setTimeout(180_000);
    const outDir = join(process.cwd(), 'screenshots');
    mkdirSync(outDir, { recursive: true });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?auto=1&car=motorbike');
    await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });
    await page.waitForTimeout(800);

    await page.keyboard.down('KeyW');
    // The flooded-engine prompt is the whole point of the shot.
    await expect(page.locator('#hud-engine-status'))
      .toContainText('FLOODED', { timeout: 60_000 });
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, '34-bike-drowned.png') });
  });
});
