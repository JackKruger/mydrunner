// Browser smoke test: loads the page, waits for the WebSocket to connect,
// and confirms the HUD updates and snapshots arrive. Catches client-side
// regressions that unit tests can't (WASM init, Three.js render, etc.).

import { test, expect } from '@playwright/test';

test('client loads, connects, and renders snapshots', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/?auto=1');

  // HUD switches from "connecting…" to "connected · …" once snapshots arrive.
  const hud = page.locator('#hud');
  await expect(hud).toContainText('connected', { timeout: 10_000 });
  // The HUD no longer prints the server tick (removed in the deca505 HUD
  // redesign), so read the snapshot stream itself: at least two buffered
  // snapshots with an advancing server tick.
  await expect.poll(() => page.evaluate(() => {
    const buffer = (window as unknown as {
      __scene?: { buffer?: Array<{ snap: { tick: number } }> };
    }).__scene?.buffer ?? [];
    return buffer.length >= 2 && buffer[buffer.length - 1]!.snap.tick > buffer[0]!.snap.tick;
  }), { timeout: 15_000 }).toBe(true);

  // Canvas should exist and be sized.
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  const size = await canvas.boundingBox();
  expect(size?.width ?? 0).toBeGreaterThan(100);
  expect(size?.height ?? 0).toBeGreaterThan(100);

  // No script errors.
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});

test('the reduced graphics tier compiles and renders', async ({ page }) => {
  // The low tier rewrites three fragment shaders through the preprocessor,
  // and a bad #ifdef or a non-constant loop bound produces a shader that
  // fails to link — which three reports through console.error with the
  // driver's info log rather than by throwing. So this assertion is the
  // whole GLSL check for the tier: without it, the low path could be broken
  // on every device and nothing in CI would notice.
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/?auto=1&q=low');

  const hud = page.locator('#hud');
  await expect(hud).toContainText('connected', { timeout: 10_000 });
  // The HUD no longer prints the server tick (removed in the deca505 HUD
  // redesign), so read the snapshot stream itself: at least two buffered
  // snapshots with an advancing server tick.
  await expect.poll(() => page.evaluate(() => {
    const buffer = (window as unknown as {
      __scene?: { buffer?: Array<{ snap: { tick: number } }> };
    }).__scene?.buffer ?? [];
    return buffer.length >= 2 && buffer[buffer.length - 1]!.snap.tick > buffer[0]!.snap.tick;
  }), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('canvas').first()).toBeVisible();

  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
