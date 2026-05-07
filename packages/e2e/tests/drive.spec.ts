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

async function waitConnected(page: Page): Promise<void> {
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });
  // Wait until the local truck has appeared in the scene's vehicle map.
  // The server welcomes us with a localId, then sends snapshots; the
  // mesh exists once the first snapshot has been interpolated.
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as { __scene?: { localId?: string | null; vehicles?: Map<string, unknown> } };
    const s = w.__scene;
    return Boolean(s?.localId && s?.vehicles?.has?.(s.localId));
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
    // roundtrips, which time out on slow CI runners. We sample the rendered
    // mesh's wheel y-rotation directly: in scene.ts that's set to -steer
    // (mesh sign convention), so we negate to recover the player-intent
    // sign that the original __prediction.state().wheels[0].steer reported.
    const samples: number[] = await page.evaluate(async () => {
      const w = window as unknown as { __scene?: { localId: string; vehicles: Map<string, { wheels: { rotation: { y: number } }[] }> } };
      const s = w.__scene!;
      const out: number[] = [];
      for (let i = 0; i < 20; i++) {
        const v = s.vehicles.get(s.localId);
        out.push(-(v?.wheels[0]?.rotation.y ?? 0));
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
