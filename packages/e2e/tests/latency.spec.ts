// Input-to-yaw-visible latency measurement.
//
// Drives the truck up to cruise speed with W, then presses A and times
// how long until the rendered chassis yaw deviates from baseline by a
// just-perceptible threshold. The measurement is end-to-end: keyboard
// event -> sampleInput -> NetClient.send -> WebSocket -> server tick ->
// steer ramp -> tire bite -> snapshot send -> client receive ->
// extrapolated render -> rendered quaternion.
//
// Reports a number rather than asserting strict bounds; tuning changes
// (steerSpeed, RENDER_DELAY_MS, tire grip, extrapolation lookahead) move
// the number, and we want to see by how much. The hard upper bound is
// generous so flakes from CI / cold-start GC don't fail the suite.
//
// Run alone:
//   pnpm --filter @mydrunner/e2e exec playwright test tests/latency.spec.ts

import { test, expect, type Page } from '@playwright/test';

async function waitConnected(page: Page): Promise<void> {
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as { __scene?: { localId?: string | null; vehicles?: Map<string, unknown> } };
    const s = w.__scene;
    return Boolean(s?.localId && s?.vehicles?.has?.(s.localId));
  }), { timeout: 10_000 }).toBe(true);
}

interface LatencyResult {
  latencyMs: number;
  baselineYaw: number;
  finalYaw: number;
  yawDelta: number;
}

test.describe('latency', () => {
  test('steer input -> visible chassis yaw', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);

    // Drive forward to gain speed. A vehicle at rest can't yaw from
    // steering alone (no slip angle without forward velocity), so the
    // measurement must be taken in motion - that's what the player
    // actually feels when "the controls are unresponsive".
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);

    // Set up the in-page measurement loop: capture a baseline yaw,
    // listen for KeyA, then poll the rendered chassis quaternion until
    // the heading deviates by THRESHOLD radians. We poll on
    // requestAnimationFrame so the resolution is ~1 frame (~13 ms at
    // 75 FPS, ~17 ms at 60 FPS).
    const measurement: Promise<LatencyResult> = page.evaluate(async () => {
      const THRESHOLD_RAD = 0.02; // ~1.15 deg, just-perceptible turn.
      const w = window as unknown as { __scene: { localId: string; vehicles: Map<string, { group: { quaternion: { x: number; y: number; z: number; w: number } } }> } };
      const s = w.__scene;
      const v = s.vehicles.get(s.localId)!;
      const yaw = (): number => {
        const q = v.group.quaternion;
        return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
      };
      const baseline = yaw();
      let tDown = 0;
      const onKey = (e: KeyboardEvent): void => {
        if (e.code === 'KeyA' && tDown === 0) {
          tDown = performance.now();
          window.removeEventListener('keydown', onKey, true);
        }
      };
      window.addEventListener('keydown', onKey, true);
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          if (tDown > 0) resolve();
          else requestAnimationFrame(tick);
        };
        tick();
      });
      let tVisible = 0;
      let lastYaw = baseline;
      const startPoll = performance.now();
      while (tVisible === 0 && performance.now() - startPoll < 2000) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        lastYaw = yaw();
        if (Math.abs(lastYaw - baseline) > THRESHOLD_RAD) {
          tVisible = performance.now();
        }
      }
      return {
        latencyMs: tVisible > 0 ? tVisible - tDown : -1,
        baselineYaw: baseline,
        finalYaw: lastYaw,
        yawDelta: lastYaw - baseline,
      };
    });

    // Small grace period so the in-page listener is attached before
    // Playwright dispatches the key. Without this, the keydown can
    // race the listener install.
    await page.waitForTimeout(50);
    await page.keyboard.down('KeyA');
    const result = await measurement;
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');

    console.log(`LATENCY input -> yaw visible: ${result.latencyMs.toFixed(0)} ms (yaw ${result.baselineYaw.toFixed(3)} -> ${result.finalYaw.toFixed(3)} rad, delta ${result.yawDelta.toFixed(3)})`);

    expect(result.latencyMs, 'failed to detect any yaw within 2 s of KeyA').toBeGreaterThan(0);
    // Generous upper bound. Used as a smoke check, not a tuning gate.
    expect(result.latencyMs).toBeLessThan(1000);
  });
});
