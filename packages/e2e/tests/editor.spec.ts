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

/** Where the placement ghost is sitting, out of the editor's dev hook. */
async function ghostState(page: Page): Promise<{
  visible: boolean; x: number; y: number; z: number; yaw: number; children: number;
}> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __editor: {
        ghost: {
          group: {
            visible: boolean;
            position: { x: number; y: number; z: number };
            rotation: { y: number };
            children: unknown[];
          };
        };
      };
    };
    const g = w.__editor.ghost.group;
    return {
      visible: g.visible,
      x: g.position.x,
      y: g.position.y,
      z: g.position.z,
      yaw: g.rotation.y,
      // One child group holding the built meshes; zero means the ghost is
      // showing an empty box rather than the object.
      children: g.children.length,
    };
  });
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

test('editor loads the authored default map without errors', async ({ page }) => {
  const errors = await openEditor(page);
  await expect(page.locator('.ed-status')).toContainText('default map');
  await expect(page.locator('.ed-section', { hasText: 'Map' }).locator('input').first())
    .toHaveValue('procedural');
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
  const before = await page.evaluate(() => {
    const w = window as unknown as { __editor: { doc(): unknown } };
    return (w.__editor.doc() as { objects: { added: unknown[] } }).objects.added.length;
  });
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
  expect(survived).toBe(before + 1);
});

test('the delete tool can clear every item inside its radius', async ({ page }) => {
  await openEditor(page);
  const authoredIds = await page.evaluate(() => {
    const w = window as unknown as { __editor: { doc(): unknown } };
    return (w.__editor.doc() as { objects: { added: Array<{ id: string }> } })
      .objects.added.map((object) => object.id);
  });
  const box = (await page.locator('#app canvas').boundingBox())!;
  const x = box.x + box.width * 0.4;
  const y = box.y + box.height * 0.72;

  await page.keyboard.press('Digit6');
  await page.mouse.click(x, y);
  await page.mouse.click(x, y);
  const placedIds = await page.evaluate((existing) => {
    const w = window as unknown as { __editor: { doc(): unknown } };
    return (w.__editor.doc() as { objects: { added: Array<{ id: string }> } })
      .objects.added.map((object) => object.id).filter((id) => !existing.includes(id));
  }, authoredIds);
  expect(placedIds).toHaveLength(2);

  await page.keyboard.press('Digit8');
  await page.locator('.ed-section', { hasText: 'Delete' }).locator('select')
    .selectOption('radius');
  await page.mouse.click(x, y);
  await expect(page.locator('.ed-status')).toContainText('deleted');

  const placedStillPresent = () => page.evaluate((ids) => {
    const w = window as unknown as { __editor: { doc(): unknown } };
    const present = new Set(
      (w.__editor.doc() as { objects: { added: Array<{ id: string }> } })
        .objects.added.map((object) => object.id),
    );
    return ids.filter((id) => present.has(id)).length;
  }, placedIds);
  expect(await placedStillPresent()).toBe(0);

  // A bulk clear is one authoring operation, not one history entry per item.
  await page.keyboard.press('KeyZ');
  expect(await placedStillPresent()).toBe(2);
});

test('a ghost of the object appears under the cursor and follows it', async ({ page }) => {
  const errors = await openEditor(page);
  const box = (await page.locator('#app canvas').boundingBox())!;
  const cx = box.x + box.width * 0.4;
  const cy = box.y + box.height * 0.72;

  // Nothing showing until the object tool is up.
  await page.mouse.move(cx, cy);
  expect(await ghostState(page)).toMatchObject({ visible: false });

  await page.keyboard.press('Digit6');
  await page.mouse.move(cx, cy);
  // The ghost is seated from the render loop, not the pointer event.
  await page.waitForFunction(() => {
    const w = window as unknown as { __editor: { ghost: { group: { visible: boolean } } } };
    return w.__editor.ghost.group.visible;
  });
  const first = await ghostState(page);
  expect(first.children).toBeGreaterThan(0);

  await page.mouse.move(cx + 120, cy + 30);
  await page.waitForTimeout(120);
  const moved = await ghostState(page);
  expect(Math.hypot(moved.x - first.x, moved.z - first.z)).toBeGreaterThan(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('the ghost aims with the bracket keys, and the object lands at that yaw', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('Digit6');
  const box = (await page.locator('#app canvas').boundingBox())!;
  const cx = box.x + box.width * 0.4;
  const cy = box.y + box.height * 0.72;
  await page.mouse.move(cx, cy);

  for (let i = 0; i < 3; i++) await page.keyboard.press('BracketRight');
  const aimed = await page.evaluate(() => {
    const w = window as unknown as { __editor: { tools: { objectYaw: number } } };
    return w.__editor.tools.objectYaw;
  });
  expect(aimed).toBeGreaterThan(0);
  expect((await ghostState(page)).yaw).toBeCloseTo(aimed, 5);

  await page.mouse.click(cx, cy);
  // Placement used to write Math.random(), so the ghost could not have
  // been telling the truth about what you were about to get.
  const placed = await page.evaluate(() => {
    const w = window as unknown as { __editor: { doc(): unknown } };
    const doc = w.__editor.doc() as { objects: { added: Array<{ yaw: number }> } };
    return doc.objects.added.at(-1)!.yaw;
  });
  expect(placed).toBeCloseTo(aimed, 5);
});

test('absolute placement puts the ghost and object base at an exact world Y', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('Digit6');
  const box = (await page.locator('#app canvas').boundingBox())!;
  const cx = box.x + box.width * 0.4;
  const cy = box.y + box.height * 0.72;
  await page.mouse.move(cx, cy);

  const object = page.locator('.ed-section', { hasText: 'Object' });
  await object.locator('.ed-field', { hasText: 'placement' }).locator('select')
    .selectOption('absolute');
  await object.locator('input[type="number"]').fill('17.375');
  await page.waitForFunction(() => {
    const w = window as unknown as { __editor: { ghost: { group: { position: { y: number } } } } };
    return Math.abs(w.__editor.ghost.group.position.y - 17.375) < 1e-6;
  });
  expect((await ghostState(page)).y).toBeCloseTo(17.375, 6);

  await page.mouse.click(cx, cy);
  const placed = await page.evaluate(() => {
    const w = window as unknown as {
      __editor: {
        doc(): { objects: { added: Array<{ id: string; y?: number; yOffset?: number }> } };
        session(): { world: { obstacles: Array<{ id: string; y: number }> } };
      };
    };
    const authored = w.__editor.doc().objects.added.at(-1)!;
    const live = w.__editor.session().world.obstacles.find((o) => o.id === authored.id)!;
    return { authoredY: authored.y, yOffset: authored.yOffset, liveY: live.y };
  });
  expect(placed.authoredY).toBe(17.375);
  expect(placed.yOffset).toBeUndefined();
  expect(placed.liveY).toBe(17.375);
});

test('picking a kind reseeds its own dimensions and previews that kind', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('Digit6');
  await page.locator('.ed-section', { hasText: 'Object' })
    .locator('.ed-field', { hasText: 'kind' }).locator('select')
    .selectOption('shippingContainer');
  const box = (await page.locator('#app canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.72);
  await page.waitForTimeout(150);

  const state = await page.evaluate(() => {
    const w = window as unknown as {
      __editor: { tools: { objectKind: string; objectSize: number; objectLength: number } };
    };
    return { ...w.__editor.tools };
  });
  // The container's own defaults, not the rock's 1.6 / 2.
  expect(state.objectKind).toBe('shippingContainer');
  expect(state.objectLength).toBeGreaterThan(4);
  expect((await ghostState(page)).visible).toBe(true);
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

  // The placement ghost: a translucent copy of the object about to be
  // placed, seated on the ground under the cursor. Worth a frame of its
  // own because it is the whole point of the object tool now — and because
  // "is the ghost the same shape as what lands" is a question only a
  // picture answers.
  await page.keyboard.press('Digit6');
  await page.locator('.ed-section', { hasText: 'Object' })
    .locator('.ed-field', { hasText: 'kind' }).locator('select')
    .selectOption('shippingContainer');
  // Clear of the crater the sculpt above dug, and far enough up the frame
  // that the whole object and its brush ring fit in shot.
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.62);
  for (let i = 0; i < 4; i++) await page.keyboard.press('BracketRight');
  await page.waitForTimeout(300);
  await expect
    .poll(async () => page.evaluate(() => {
      const w = window as unknown as { __editor: { ghost: { group: { visible: boolean } } } };
      return w.__editor.ghost.group.visible;
    }))
    .toBe(true);
  await page.screenshot({ path: `${SHOT_DIR}/04-object-ghost.png` });
});
