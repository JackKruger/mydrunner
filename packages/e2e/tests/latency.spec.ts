// Local input-to-motion latency measurement.
//
// The browser owns the truck, so this deliberately measures keyboard event ->
// next owner-physics response -> rendered chassis yaw. No WebSocket or server
// snapshot is involved in any stage of the measurement.

import { test, expect, type Page } from '@playwright/test';

async function waitConnected(page: Page): Promise<void> {
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as {
      __scene?: { localId?: string | null; vehicles?: Map<string, unknown> };
      __localSimulation?: unknown;
    };
    const s = w.__scene;
    return Boolean(w.__localSimulation && s?.localId && s?.vehicles?.has?.(s.localId));
  }), { timeout: 10_000 }).toBe(true);
}

interface LatencyResult {
  steerResponseMs: number;
  angularVelocityMs: number;
  visibleYawMs: number;
  yawDelta: number;
}

test.describe('latency', () => {
  test('steer input reaches owner physics and visible chassis yaw locally', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);

    // Steering needs forward velocity before tire force can rotate the chassis.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);

    const measurement: Promise<LatencyResult> = page.evaluate(async () => {
      const STEER_THRESHOLD = 0.03;
      const ANGULAR_VELOCITY_THRESHOLD = 0.1;
      const YAW_THRESHOLD = 0.02;
      const TIMEOUT_MS = 2000;
      const w = window as unknown as {
        __scene: {
          localId: string;
          vehicles: Map<string, {
            group: { quaternion: { x: number; y: number; z: number; w: number } };
          }>;
        };
        __localSimulation: {
          state: () => { wheels: { steer: number }[] };
          vehicleState: () => { angVel: { y: number } };
        };
      };
      const visual = w.__scene.vehicles.get(w.__scene.localId)!;
      const sim = w.__localSimulation;
      const renderedYaw = (): number => {
        const q = visual.group.quaternion;
        return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
      };
      const angleDelta = (a: number, b: number): number =>
        Math.atan2(Math.sin(a - b), Math.cos(a - b));

      const baselineYaw = renderedYaw();
      const baselineSteer = sim.state().wheels[0]?.steer ?? 0;
      const baselineAngVel = sim.vehicleState().angVel.y;
      let keyDownAt = 0;
      window.addEventListener('keydown', (event) => {
        if (event.code === 'KeyA' && keyDownAt === 0) keyDownAt = performance.now();
      }, { capture: true, once: true });

      while (keyDownAt === 0) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      let steerAt = 0;
      let angularVelocityAt = 0;
      let visibleYawAt = 0;
      let yawDelta = 0;
      while (performance.now() - keyDownAt < TIMEOUT_MS && visibleYawAt === 0) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        const steer = sim.state().wheels[0]?.steer ?? baselineSteer;
        const angularVelocity = sim.vehicleState().angVel.y;
        yawDelta = angleDelta(renderedYaw(), baselineYaw);
        if (steerAt === 0 && Math.abs(steer - baselineSteer) >= STEER_THRESHOLD) steerAt = now;
        if (
          angularVelocityAt === 0
          && Math.abs(angularVelocity - baselineAngVel) >= ANGULAR_VELOCITY_THRESHOLD
        ) angularVelocityAt = now;
        if (Math.abs(yawDelta) >= YAW_THRESHOLD) visibleYawAt = now;
      }

      return {
        steerResponseMs: steerAt === 0 ? -1 : steerAt - keyDownAt,
        angularVelocityMs: angularVelocityAt === 0 ? -1 : angularVelocityAt - keyDownAt,
        visibleYawMs: visibleYawAt === 0 ? -1 : visibleYawAt - keyDownAt,
        yawDelta,
      };
    });

    // Let the page install its key listener before dispatching the input.
    await page.waitForTimeout(50);
    await page.keyboard.down('KeyA');
    const result = await measurement;
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');

    console.log(
      `LOCAL LATENCY (ms after KeyA):\n`
      + `  steering rack = ${result.steerResponseMs.toFixed(0)}\n`
      + `  angular velocity = ${result.angularVelocityMs.toFixed(0)}\n`
      + `  visible yaw = ${result.visibleYawMs.toFixed(0)}\n`
      + `  yaw delta = ${result.yawDelta.toFixed(3)} rad`,
    );

    expect(result.steerResponseMs, 'owner physics did not see KeyA').toBeGreaterThan(0);
    expect(result.steerResponseMs).toBeLessThan(250);
    expect(result.visibleYawMs, 'failed to detect visible yaw within 2 seconds').toBeGreaterThan(0);
    expect(result.visibleYawMs).toBeLessThan(750);
  });
});
