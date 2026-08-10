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

    // The river runs north-south down the map's eastern side and crosses the
    // main road ~190 m along from the spawn grid, and at road speed the truck
    // is through the crossing in about a second. Watch for the readout from
    // inside the page rather than sampling it: an assertion poll fast enough
    // to catch a one-second window competes with rAF for the main thread,
    // which starves the sim of steps and leaves the truck short of the water.
    await page.evaluate(() => {
      const el = document.querySelector('#hud-surface');
      const w = window as unknown as { __sawWater?: boolean };
      w.__sawWater = false;
      if (!el) return;
      const check = (): void => {
        if (/water \d/.test(el.textContent ?? '')) w.__sawWater = true;
      };
      new MutationObserver(check).observe(el, { childList: true, characterData: true, subtree: true });
      check();
    });

    // Pinned throttle is not the way there either: the truck tops 80 km/h
    // within a few seconds, launches off the road's crown and beaches in
    // scenery well short of the river. Lift off periodically so it stays
    // around road speed and tracks the bends.
    let sawWater = false;
    const deadline = Date.now() + 75_000;
    await page.keyboard.down('KeyW');
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_200);
      sawWater = await page.evaluate(
        () => (window as unknown as { __sawWater?: boolean }).__sawWater === true,
      );
      if (sawWater) break;
      await page.keyboard.up('KeyW');
      await page.waitForTimeout(600);
      await page.keyboard.down('KeyW');
    }
    await page.keyboard.up('KeyW');

    expect(sawWater, 'never reached the ford').toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
