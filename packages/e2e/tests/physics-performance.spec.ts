import { expect, test } from '@playwright/test';

test('owner physics stays below 4 ms p95 under 4x CPU throttling', async ({ page }) => {
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
  expect(result.p95).toBeLessThan(4);
});
