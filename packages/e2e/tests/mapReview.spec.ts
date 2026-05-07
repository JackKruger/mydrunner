// Map review screenshot capture.
//
// Loads the game (auto join), positions the camera at fixed world
// coordinates over key terrain features, and saves PNGs. Uses the
// scene.setReviewView() debug hook so each shot is locked to absolute
// coords rather than tied to the local truck. Output goes to
// packages/e2e/screenshots/map-review/.
//
// Run alone:
//   pnpm --filter @mydrunner/e2e exec playwright test tests/mapReview.spec.ts
//
// The shots are framed against the seed-1337 / size-200 terrain
// (mountain centre near (46, 72), peak ~70 m, sigma=38 m). Update the
// coordinates if TERRAIN.mtnXRatio / mtnZRatio / mtnSigmaRatio change.

import { test } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

interface View {
  name: string;
  cam: [number, number, number];     // world (x, y, z)
  look: [number, number, number];    // world target
  hold?: number;                     // ms after setReviewView before screenshotting
}

// All coordinates in world space (200 m map, terrain seed 1337).
// Mountain centre ≈ (46, 72), trail base ≈ (31, 11).
// Switchback waypoints (start → end):
//   T1: (31, 11)  → (84, 26)   — lower east, mud puddle ~(64, 21)
//   T2: (84, 26)  → (16, 42)   — mid west, whoops ~(50, 34)
//   T3: (16, 42)  → (76, 55)   — mid east
//   T4: (76, 55)  → (36, 67)   — upper west, rocky step ~(56, 61)
//   T5: (36, 67)  → (46, 72)   — summit approach
const VIEWS: View[] = [
  {
    name: '01-overhead-full-map',
    cam: [0, 220, 30],
    look: [0, 0, 0],
  },
  {
    name: '02-mountain-overview-from-south',
    cam: [46, 90, -45],
    look: [46, 35, 60],
  },
  {
    name: '03-trail-base-entry-top',
    // Top-down on the trail base (where dirt roads meet hill climb T1).
    cam: [31, 60, 11],
    look: [31, 0, 11],
  },
  {
    name: '04-T1-mud-puddle-top',
    // Top-down on the T1 mud puddle (Mud surface band, dip).
    cam: [64, 50, 21],
    look: [64, 0, 21],
  },
  {
    name: '05-T2-whoops-top',
    // Top-down on T2 whoops (~6 bumps in a row mid-traverse).
    cam: [50, 60, 34],
    look: [50, 0, 34],
  },
  {
    name: '06-T4-rocky-step-top',
    // Top-down on T4 rocky step.
    cam: [56, 80, 61],
    look: [56, 0, 61],
  },
  {
    name: '07-summit-approach',
    cam: [80, 80, 60],
    look: [46, 65, 72],
  },
  {
    name: '08-mountain-oblique-east',
    cam: [120, 60, 30],
    look: [46, 30, 60],
  },
  {
    name: '09-T2-whoops-side',
    // Side view of the whoops sequence so the bumps' silhouettes
    // read clearly. T2 forward direction (start->end) is roughly
    // (-1, 0, 0.22) normalised. Camera placed perpendicular and
    // slightly above the trail centre.
    cam: [50, 32, 50],
    look: [50, 30, 34],
  },
  {
    name: '10-T4-step-side',
    // Side view of the rocky step.
    cam: [56, 58, 75],
    look: [56, 55, 61],
  },
];

test.describe('@map-review', () => {
  test('capture', async ({ page }) => {
    test.slow();
    const outDir = join(process.cwd(), 'screenshots', 'map-review');
    mkdirSync(outDir, { recursive: true });

    await page.goto('/?auto=1');
    // Wait until terrain has rendered. Same probe as drive.spec.ts
    // (scene exposed in DEV) plus a beat for terrain mesh build.
    await page.waitForFunction(() => {
      const w = window as unknown as { __scene?: { localId?: string | null } };
      return Boolean(w.__scene?.localId);
    }, { timeout: 10_000 });
    await page.waitForTimeout(1500);

    for (const v of VIEWS) {
      await page.evaluate(([cx, cy, cz, lx, ly, lz]) => {
        const w = window as unknown as { __scene: { setReviewView: (p: unknown, l: unknown) => void } };
        w.__scene.setReviewView({ x: cx, y: cy, z: cz }, { x: lx, y: ly, z: lz });
      }, [...v.cam, ...v.look]);
      // Small hold so the next rAF has applied the override before the
      // screenshot fires. The game keeps animating in the background;
      // each frame the override reasserts, so the screenshot is
      // guaranteed to hit a frame with the override applied.
      await page.waitForTimeout(v.hold ?? 200);
      await page.screenshot({ path: join(outDir, `${v.name}.png`), fullPage: false });
      console.log(`[map-review] saved ${v.name}.png`);
    }
    // Restore default view so the test doesn't leave a stuck override.
    await page.evaluate(() => {
      const w = window as unknown as { __scene: { setReviewView: (p: unknown) => void } };
      w.__scene.setReviewView(null);
    });
  });
});
