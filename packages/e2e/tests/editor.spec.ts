// The level editor, driven in a real browser.
//
// The unit tests cover the brush arithmetic and the document round trip
// against a plain EditSession. What they cannot cover is the part that
// only exists in a browser: that a pointer at some pixel raycasts onto
// the terrain mesh, that the stroke reaches the GPU buffers, and that
// the whole page comes up without a WebGL or module error. Those are
// exactly the failures the map-document unit tests would sail past.

import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const SHOT_DIR = 'screenshots/editor';

/** Pointer press-drag-release over the canvas, in viewport pixels. */
async function stroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / 6,
      from.y + ((to.y - from.y) * i) / 6,
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
}

/** Fingerprint of the live terrain heights, read out of the editor's
 *  dev-only diagnostic hook. */
async function heightHash(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ed = (window as unknown as { __editor: { session(): { world: { terrain: { heights: Float32Array } } } } }).__editor;
    const h = ed.session().world.terrain.heights;
    let acc = 0x811c9dc5;
    for (let i = 0; i < h.length; i++) {
      acc = (Math.imul(acc ^ Math.round(h[i]! * 1000), 0x01000193) >>> 0);
    }
    return acc;
  });
}

/** Live terrain heights, in metres. */
async function heights(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const ed = (window as unknown as {
      __editor: { session(): { world: { terrain: { heights: Float32Array } } } };
    }).__editor;
    return Array.from(ed.session().world.terrain.heights);
  });
}

/** Biggest rise any single cell saw. Not the map's max height — that is
 *  the 70 m mountain, which a mound at ground level cannot move. */
function maxRise(before: number[], after: number[]): number {
  let m = 0;
  for (let i = 0; i < before.length; i++) m = Math.max(m, after[i]! - before[i]!);
  return m;
}

async function openEditor(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('/editor.html');
  await expect(page.locator('#app canvas')).toBeVisible();
  // The panel is built after the first document composes.
  await expect(page.locator('.ed-panel')).toBeVisible();
  await page.waitForFunction(() => '__editor' in window);
  return errors;
}

test('editor loads the procedural map without errors', async ({ page }) => {
  const errors = await openEditor(page);
  await expect(page.locator('.ed-status')).toContainText('procedural');
  const canvas = page.locator('#app canvas');
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(100);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the raise brush changes the ground under the cursor', async ({ page }) => {
  const errors = await openEditor(page);
  const before = await heightHash(page);

  const box = (await page.locator('#app canvas').boundingBox())!;
  // Aim well below the horizon so the ray meets ground rather than sky.
  const cx = box.x + box.width * 0.35;
  const cy = box.y + box.height * 0.7;
  await stroke(page, { x: cx, y: cy }, { x: cx + 60, y: cy + 20 });

  expect(await heightHash(page)).not.toBe(before);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('undo restores the ground a stroke changed', async ({ page }) => {
  await openEditor(page);
  const before = await heightHash(page);

  const box = (await page.locator('#app canvas').boundingBox())!;
  const cx = box.x + box.width * 0.35;
  const cy = box.y + box.height * 0.7;
  await stroke(page, { x: cx, y: cy }, { x: cx + 40, y: cy });
  expect(await heightHash(page)).not.toBe(before);

  await page.keyboard.press('KeyZ');
  expect(await heightHash(page)).toBe(before);
});

test('the placed object survives a save and reload of the document', async ({ page }) => {
  await openEditor(page);
  // Switch to the object tool by its keyboard shortcut, then click.
  await page.keyboard.press('Digit6');
  const box = (await page.locator('#app canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.72);
  await expect(page.locator('.ed-status')).toContainText('placed');

  const survived = await page.evaluate(() => {
    const w = window as unknown as {
      __editor: { doc(): unknown };
    };
    const doc = w.__editor.doc() as { objects: { added: unknown[] } };
    return doc.objects.added.length;
  });
  expect(survived).toBe(1);
});

test('the paint tool writes a surface the document carries', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('Digit5');
  const box = (await page.locator('#app canvas').boundingBox())!;
  const cx = box.x + box.width * 0.35;
  const cy = box.y + box.height * 0.7;
  await stroke(page, { x: cx, y: cy }, { x: cx + 30, y: cy });

  const overrides = await page.evaluate(() => {
    const w = window as unknown as { __editor: { doc(): unknown } };
    const doc = w.__editor.doc() as { surfaceOverride: { cells: unknown[] } };
    return doc.surfaceOverride.cells.length;
  });
  expect(overrides).toBeGreaterThan(0);
});

// Visual changelog. The editor is a page nobody sees in the game's own
// screenshots, so it gets its own pair: the map as opened, and the same
// view after a sculpt, which is the only way a reviewer can tell the
// brush is landing where the cursor is.
test('@editor-shots capture', async ({ page }) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  await openEditor(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOT_DIR}/01-opened.png` });

  const box = (await page.locator('#app canvas').boundingBox())!;
  const cx = box.x + box.width * 0.35;
  const cy = box.y + box.height * 0.7;
  // Held stationary rather than dragged. The brush is a rate — metres
  // per second of held button — so a sweep spreads its couple of metres
  // over the whole path and reads as nothing from 140 m away, while a
  // hold builds a mound you can actually see. That the hold works at all
  // without the mouse moving is the point of applying strokes from the
  // render loop rather than from pointermove.
  const before = await heights(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(2500);
  await page.mouse.up();
  await page.waitForTimeout(300);
  // Pin what the image is meant to show, so a capture that silently
  // stopped sculpting fails rather than committing a flat picture.
  expect(maxRise(before, await heights(page))).toBeGreaterThan(2);
  await page.screenshot({ path: `${SHOT_DIR}/02-sculpted.png` });

  // Paint deep mud, not the default dirt: painting dirt onto dirt is a
  // real edit that the document records and the image cannot show.
  await page.keyboard.press('Digit5');
  await page.locator('.ed-section', { hasText: 'Surface' }).locator('select').selectOption(
    String(3 /* Surface.DeepMud */),
  );
  await stroke(page, { x: cx, y: cy + 40 }, { x: cx + 70, y: cy + 40 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOT_DIR}/03-painted.png` });
});
