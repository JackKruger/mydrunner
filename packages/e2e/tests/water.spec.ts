// Water in a real browser.
//
// The unit tests cover the force model and the mesh's attributes. What
// only a browser can tell us is whether the water shader actually
// compiles and draws — a GLSL error is a black screen and a console
// message, and nothing headless would catch it.

import { test, expect, type Page } from '@playwright/test';

async function waitConnected(page: Page): Promise<void> {
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as { __scene?: { localId?: string | null; vehicles?: Map<string, unknown> } };
    const s = w.__scene;
    return Boolean(s?.localId && s?.vehicles?.has?.(s.localId));
  }), { timeout: 10_000 }).toBe(true);
}

test.describe('water', () => {
  test('the water surface builds and the shader compiles', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(600);

    const water = await page.evaluate(() => {
      const w = window as unknown as { __scene?: any };
      const mesh = w.__scene?.view?.waterMesh;
      if (!mesh) return null;
      const geo = mesh.mesh.geometry;
      const wet = geo.getAttribute('aWet').array as Float32Array;
      let wetCount = 0;
      for (const v of wet) if (v > 0.5) wetCount += 1;
      return {
        wetCount,
        renderOrder: mesh.mesh.renderOrder,
        transparent: mesh.mesh.material.transparent,
        hasTime: 'uTime' in mesh.mesh.material.uniforms,
      };
    });

    // The default map ships a river, so a null mesh means refreshWater
    // never ran or hasWater() went false.
    expect(water).not.toBeNull();
    expect(water!.wetCount).toBeGreaterThan(100);
    expect(water!.transparent).toBe(true);
    expect(water!.renderOrder).toBeGreaterThan(0);
    expect(water!.hasTime).toBe(true);

    // A GLSL compile failure shows up here and nowhere else.
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the ripple clock advances', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);

    const first = await page.evaluate(() => {
      const w = window as unknown as { __scene?: any };
      return w.__scene?.view?.waterMesh?.mesh.material.uniforms.uTime.value ?? -1;
    });
    await page.waitForTimeout(500);
    const second = await page.evaluate(() => {
      const w = window as unknown as { __scene?: any };
      return w.__scene?.view?.waterMesh?.mesh.material.uniforms.uTime.value ?? -1;
    });
    // Self-ticked from performance.now(), so a still surface over a
    // flowing river would mean render() stopped calling update().
    expect(second).toBeGreaterThan(first);
  });

  test('driving into the ford reports water depth on the HUD', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/?auto=1&car=patrol');
    await waitConnected(page);
    await page.waitForTimeout(500);

    // The ford crosses the main road ~95 m along from the spawn grid.
    await page.keyboard.down('KeyW');
    await expect.poll(async () => page.evaluate(() => {
      const w = window as unknown as { __scene?: any };
      return w.__scene?.localPosition?.()?.x ?? -999;
    }), { timeout: 30_000 }).toBeGreaterThan(-60);

    // Somewhere in the crossing the HUD's surface line should carry a
    // depth readout — the thing a player reads before committing.
    await expect(page.locator('#hud-surface')).toContainText(/water \d/, { timeout: 20_000 });
    await page.keyboard.up('KeyW');

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
