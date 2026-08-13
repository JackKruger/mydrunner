import { expect, test } from '@playwright/test';

test('live driving leaves one bounded visual tyre-track mesh', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?auto=1&name=track-test');
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 15_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __localSimulation?: unknown }).__localSimulation));

  // Find a broad, fairly flat grass run from the live map rather than baking
  // a coordinate into the test. Authored map changes can then move the grass
  // without turning this visual integration check into a spawn-location test.
  await page.evaluate(() => {
    const w = window as unknown as {
      __scene: any;
      __localSimulation: {
        resetTo(pose: { position: { x: number; y: number; z: number }; yaw: number }): void;
      };
    };
    const scene = w.__scene;
    const terrain = scene.view.terrainMesh.terrain;
    const obstacles = scene.mapWorld?.obstacles ?? [];
    const n = terrain.resolution;
    const toWorld = (cell: number) => (cell / (n - 1) - 0.5) * terrain.size;

    for (let r = 3; r < n - 8; r++) {
      for (let c = 3; c < n - 3; c++) {
        let suitable = true;
        const baseHeight = terrain.heights[r * n + c];
        for (let dr = 0; dr < 6; dr++) {
          const i = (r + dr) * n + c;
          if (terrain.surfaces[i] !== 4 || Math.abs(terrain.heights[i] - baseHeight) > 0.7) {
            suitable = false;
            break;
          }
        }
        if (!suitable) continue;
        const x = toWorld(c);
        const z = toWorld(r);
        if (obstacles.some((o: { x: number; z: number }) => Math.hypot(o.x - x, o.z - z) < 7)) continue;
        w.__localSimulation.resetTo({ position: { x, y: baseHeight + 2.2, z }, yaw: 0 });
        return { x, z };
      }
    }
    throw new Error('No clear grass run found for tyre-track test');
  });

  await page.waitForTimeout(1800);
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => {
    const scene = (window as unknown as { __scene: any }).__scene;
    return scene.effects.tracks.activeSegmentCount as number;
  }), { timeout: 12_000 }).toBeGreaterThan(0);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(250);

  const diagnostics = await page.evaluate(() => {
    const scene = (window as unknown as { __scene: any }).__scene;
    const tracks = scene.effects.tracks;
    return {
      count: tracks.activeSegmentCount as number,
      capacity: tracks.capacity as number,
      meshCount: tracks.group.children.length as number,
      visible: tracks.mesh.visible as boolean,
      meshName: tracks.mesh.name as string,
    };
  });
  expect(diagnostics.count).toBeGreaterThan(0);
  expect(diagnostics.count).toBeLessThanOrEqual(diagnostics.capacity);
  expect(diagnostics.capacity).toBe(8192);
  expect(diagnostics.meshCount).toBe(1);
  expect(diagnostics.visible).toBe(true);
  expect(diagnostics.meshName).toBe('tyre-tracks');
});

// This test used to end by writing screenshots/35-tyre-tracks-grass.png.
// It is the only non-@screenshot spec that wrote into the tracked screenshot
// directory, so every `pnpm test:e2e` left the repository dirty with an image
// nobody had asked for — and the truck's path varies enough run to run that
// the bytes changed each time. The visual changelog is regenerated
// deliberately (`playwright test tests/screenshot.spec.ts`), not as a side
// effect of an assertion run. The capture belongs there if it is wanted back.
