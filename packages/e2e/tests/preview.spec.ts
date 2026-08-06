// Driving the map you're editing, with no server involved.
//
// The unit tests cover the handoff envelope and the spawn rule. What they
// cannot cover is the part that only exists in a browser: that the popup
// inherits the editor tab's sessionStorage at all, that the game page
// builds a world from a document it was never compiled with, and that
// Scene draws a truck with no snapshot stream — a path that did not exist
// before this feature and that no amount of unit testing would have caught.

import { test, expect, type Page } from '@playwright/test';

async function openEditor(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('/editor.html');
  await expect(page.locator('#app canvas')).toBeVisible();
  await expect(page.locator('.ed-panel')).toBeVisible();
  await page.waitForFunction(() => '__editor' in window);
  return errors;
}

/** The local truck's position out of the game page's dev hook. */
async function localPos(page: Page): Promise<{ x: number; y: number; z: number } | null> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __scene: { localPosition(): { x: number; y: number; z: number } | null };
    };
    return w.__scene.localPosition();
  });
}

test('previewing an edited map drives it offline', async ({ page, context }) => {
  const editorErrors = await openEditor(page);

  // Place something, so the map being previewed is demonstrably not the
  // one the client compiled in.
  await page.keyboard.press('Digit6');
  const box = (await page.locator('#app canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.72);
  await expect(page.locator('.ed-status')).toContainText('placed');

  const [preview] = await Promise.all([
    context.waitForEvent('page'),
    page.locator('.ed-primary').click(),
  ]);

  const previewErrors: string[] = [];
  preview.on('pageerror', (err) => previewErrors.push(err.message));
  preview.on('console', (msg) => {
    if (msg.type() === 'error') previewErrors.push(msg.text());
  });

  await preview.waitForLoadState('domcontentloaded');
  expect(new URL(preview.url()).searchParams.get('preview')).toBe('1');

  // No join screen, no socket: straight into the world.
  await expect(preview.locator('#hud')).toContainText('PREVIEW', { timeout: 20_000 });
  await preview.waitForFunction(() => '__scene' in window);

  // A truck is actually rendered. This is the branch that did not exist:
  // Scene used to create vehicle visuals only while iterating a snapshot.
  await preview.waitForFunction(() => {
    const w = window as unknown as { __scene: { localPosition(): unknown } };
    return w.__scene.localPosition() !== null;
  }, undefined, { timeout: 20_000 });

  const start = await localPos(preview);
  expect(start).not.toBeNull();

  // Hold throttle: the local Rapier sim is the only thing moving it.
  await preview.keyboard.down('KeyW');
  await preview.waitForTimeout(2500);
  await preview.keyboard.up('KeyW');

  const end = await localPos(preview);
  expect(end).not.toBeNull();
  const travelled = Math.hypot(end!.x - start!.x, end!.z - start!.z);
  expect(travelled, `truck moved ${travelled.toFixed(2)} m`).toBeGreaterThan(3);

  // The HUD reads telemetry off the local sim, not off snapshots.
  await expect(preview.locator('#hud')).toContainText('km/h');

  expect(previewErrors, previewErrors.join('\n')).toEqual([]);
  expect(editorErrors, editorErrors.join('\n')).toEqual([]);
});

test('the game page says so when there is no map to preview', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  // Straight to the URL with nothing stashed — the state a bookmarked or
  // shared preview link lands in.
  await page.goto('/index.html?preview=1');
  await expect(page.locator('#hud')).toContainText('no preview map', { timeout: 20_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});
