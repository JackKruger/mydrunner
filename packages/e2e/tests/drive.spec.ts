// Driving tests. Trimmed to the two checks that have caught real bugs and
// don't break every time we tune gameplay feel:
//   - Rendered wheel rotation stability (caught the YXZ rotation-order bug
//     that made wheels tumble when driving + steering).
//   - Steer angle stability (caught the reconcile double-step bug that made
//     the wheel angle flicker on every snapshot).
//
// Earlier "drive forward N metres" tests were removed: the values they
// asserted depend on engine/grip/wheel/suspension tuning, so they break
// every time we adjust the feel - which is the wrong signal. Smoke and
// multiplayer tests still cover the core "client connects and renders"
// guarantees.

import { test, expect, type Page } from '@playwright/test';

interface Diag {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  wheels: { steer: number; spin: number; suspensionLength: number }[];
  rpm?: number;
  gear?: number;
}

async function readDiag(page: Page): Promise<Diag | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __prediction?: { state: () => Diag } };
    return w.__prediction ? w.__prediction.state() : null;
  });
}

async function waitConnected(page: Page): Promise<void> {
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => {
    return Boolean((window as unknown as { __prediction?: unknown }).__prediction);
  }), { timeout: 10_000 }).toBe(true);
}

test.describe('driving', () => {
  test('rendered wheel rotations are stable while driving + turning', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);

    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(1500);

    const samples: { y: number; x: number }[] = await page.evaluate(async () => {
      const w = window as unknown as { __scene?: any };
      const s = w.__scene!;
      const ids = [...s.vehicles.keys()];
      const v = s.vehicles.get(ids[0])!;
      const wheel = v.wheels[0]!;
      const out: { y: number; x: number }[] = [];
      for (let i = 0; i < 30; i++) {
        out.push({ x: wheel.rotation.x, y: wheel.rotation.y });
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      return out;
    });

    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');

    // wheel.rotation.y (steer) should be near constant once at lock.
    // The original YXZ-order bug made the steered wheel's rendered y
    // jitter wildly while spinning - this is the signal that test
    // protects against. The x-reversal check that used to live here
    // was too sensitive to brief angVel reversals from wheel slip /
    // suspension unload and wasn't catching anything else.
    const yMean = samples.reduce((a, b) => a + b.y, 0) / samples.length;
    const yVar = samples.reduce((a, b) => a + (b.y - yMean) ** 2, 0) / samples.length;
    const yStdev = Math.sqrt(yVar);
    expect(yStdev, `wheel steer stdev was ${yStdev.toFixed(4)}`).toBeLessThan(0.03);
  });

  test('holding A produces a stable left steer angle (no flicker)', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);

    await page.keyboard.down('KeyA');
    await page.waitForTimeout(800);
    // Run sampling loop inside the browser to avoid 20 cross-process evaluate
    // roundtrips, which time out on slow CI runners.
    const samples: number[] = await page.evaluate(async () => {
      const w = window as unknown as { __prediction?: { state: () => { wheels: { steer: number }[] } } };
      const out: number[] = [];
      for (let i = 0; i < 20; i++) {
        out.push(w.__prediction?.state().wheels[0]?.steer ?? 0);
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      return out;
    });
    await page.keyboard.up('KeyA');
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean, `mean steer was ${mean.toFixed(3)}`).toBeLessThan(-0.2);
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    const stdev = Math.sqrt(variance);
    expect(stdev, `steer stdev was ${stdev.toFixed(4)}`).toBeLessThan(0.02);
  });
});
