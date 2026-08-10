// Driving tests. Trimmed to the two checks that have caught real bugs and
// don't break every time we tune gameplay feel:
//   - Rendered wheel rotation composition (caught the YXZ rotation-order bug
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
  test('rendered front wheels follow the progressive steering rack', async ({ page }) => {
    await page.goto('/?auto=1&q=low');
    await waitConnected(page);
    await page.waitForTimeout(800);

    const measurement = page.evaluate(async () => {
      const w = window as unknown as {
        __scene: {
          localId: string;
          vehicles: Map<string, { wheels: { rotation: { y: number } }[] }>;
        };
      };
      await new Promise<void>((resolve) => {
        window.addEventListener('keydown', (event) => {
          if (event.code === 'KeyA') resolve();
        }, { capture: true, once: true });
      });

      const startedAt = performance.now();
      let earlyPeak = 0;
      let finalAngle = 0;
      while (performance.now() - startedAt < 600) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const vehicle = w.__scene.vehicles.get(w.__scene.localId);
        finalAngle = Math.abs(vehicle?.wheels[0]?.rotation.y ?? 0);
        if (performance.now() - startedAt <= 120) earlyPeak = Math.max(earlyPeak, finalAngle);
      }
      return { earlyPeak, finalAngle };
    });

    await page.waitForTimeout(50);
    await page.keyboard.down('KeyA');
    const result = await measurement;
    await page.keyboard.up('KeyA');

    // A raw-input visual override jumps straight to maxSteer (0.72 rad).
    // The simulated rack should still be travelling at 120 ms, then reach
    // lock comfortably within the 600 ms measurement window.
    expect(result.earlyPeak).toBeGreaterThan(0.05);
    expect(result.earlyPeak).toBeLessThan(0.45);
    expect(result.finalAngle).toBeGreaterThan(0.6);
  });

  test('rendered wheels use turn-then-roll rotation while driving + turning', async ({ page }) => {
    await page.goto('/?auto=1&q=low');
    await waitConnected(page);
    await page.waitForTimeout(800);

    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyA');
    // The software renderer used by CI can run at only a few frames per
    // second. Wait for the rendered rack to reach lock rather than assuming
    // a fixed wall-clock delay produced enough frames.
    await expect.poll(() => page.evaluate(() => {
      const w = window as unknown as {
        __scene?: { localId: string; vehicles: Map<string, { wheels: { rotation: { y: number } }[] }> };
      };
      const scene = w.__scene;
      return Math.abs(scene?.vehicles.get(scene.localId)?.wheels[0]?.rotation.y ?? 0);
    }), { timeout: 10_000 }).toBeGreaterThan(0.6);

    const initialSpin = await page.evaluate(() => {
      const w = window as unknown as {
        __scene: { localId: string; vehicles: Map<string, { wheels: { rotation: { x: number } }[] }> };
      };
      const scene = w.__scene;
      return scene.vehicles.get(scene.localId)!.wheels[0]!.rotation.x;
    });
    await expect.poll(() => page.evaluate((start) => {
      const w = window as unknown as {
        __scene: { localId: string; vehicles: Map<string, { wheels: { rotation: { x: number } }[] }> };
      };
      const scene = w.__scene;
      const spin = scene.vehicles.get(scene.localId)!.wheels[0]!.rotation.x;
      return Math.abs(Math.atan2(Math.sin(spin - start), Math.cos(spin - start)));
    }, initialSpin), { timeout: 10_000 }).toBeGreaterThan(0.1);

    const renderedWheel = await page.evaluate(() => {
      const w = window as unknown as {
        __scene: {
          localId: string;
          vehicles: Map<string, { wheels: { rotation: { order: string; y: number } }[] }>;
        };
      };
      const scene = w.__scene;
      const wheel = scene.vehicles.get(scene.localId)!.wheels[0]!;
      return { order: wheel.rotation.order, steer: Math.abs(wheel.rotation.y) };
    });

    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');

    // YXZ composes the wheel's steering rotation after its axle spin. The
    // previous default XYZ order made a spinning, steered wheel tumble around
    // the chassis axis even though both scalar angles looked reasonable.
    expect(renderedWheel.order).toBe('YXZ');
    expect(renderedWheel.steer).toBeGreaterThan(0.6);
  });

  test('holding A produces a stable left steer angle (no flicker)', async ({ page }) => {
    await page.goto('/?auto=1&q=low');
    await waitConnected(page);
    await page.waitForTimeout(800);

    await page.keyboard.down('KeyA');
    await page.waitForTimeout(800);
    // Run sampling loop inside the browser to avoid 20 cross-process evaluate
    // roundtrips, which time out on slow CI runners. We sample the rendered
    // mesh's wheel y-rotation directly: in scene.ts that's set to -steer
    // (mesh sign convention), so we negate to recover the player-intent
    // sign that the owner simulation's front-wheel steer reported.
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
