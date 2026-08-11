import { expect, test } from '@playwright/test';

// Owner physics runs at a fixed 60 Hz, so a step that outgrows the frame it is
// budgeted for is the regression worth catching — the bar is that budget, not a
// round number. The original 4 ms never passed anywhere: it implies ~1 ms
// unthrottled, and the real figure is ~2.2 ms p95 on both this code and the
// commit before the axle work, so it failed every CI run from the day it landed.
//
// Under 4x throttling the measured p95 is 7.6-7.7 ms in CI and 9.3-10.7 ms on a
// loaded dev box. Budget-as-bar keeps ~1.5x headroom over the worst of those
// while still failing a step that genuinely doubles. Throttled timing on a
// shared runner is noisy (individual samples swing 14-44 ms), which is why this
// asserts p95 rather than max.
const FRAME_BUDGET_MS = 1_000 / 60;

test('owner physics stays inside the 60 Hz frame budget under 4x CPU throttling', async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/?auto=1&q=low&e2ePerf=1');
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 15_000 });
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => {
    const perf = (window as unknown as { __physicsPerf?: { count: number } }).__physicsPerf;
    return perf?.count ?? 0;
  }), { timeout: 90_000 }).toBeGreaterThanOrEqual(1_440);
  await page.keyboard.up('KeyW');

  const result = await page.evaluate(() => {
    const perf = (window as unknown as {
      __physicsPerf: { samples: Float32Array; count: number };
    }).__physicsPerf;
    const measured = Array.from(perf.samples.slice(240, 1_440)).sort((a, b) => a - b);
    return {
      samples: measured.length,
      p95: measured[Math.floor(measured.length * 0.95)]!,
    };
  });
  expect(result.samples).toBe(1_200);
  expect(result.p95, `p95 ${result.p95.toFixed(2)} ms exceeds the 60 Hz frame budget`)
    .toBeLessThan(FRAME_BUDGET_MS);
});
