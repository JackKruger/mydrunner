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

  await page.goto('/');

  // HUD switches from "connecting…" to "connected · …" once snapshots arrive.
  const hud = page.locator('#hud');
  await expect(hud).toContainText('connected', { timeout: 10_000 });
  await expect(hud).toContainText(/tick=\d+/);

  // Canvas should exist and be sized.
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  const size = await canvas.boundingBox();
  expect(size?.width ?? 0).toBeGreaterThan(100);
  expect(size?.height ?? 0).toBeGreaterThan(100);

  // No script errors.
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
});
