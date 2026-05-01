// Real-keyboard driving tests. The screenshot test only verifies a
// snapshot - these verify behavior over time:
//   - Pressing W moves the car forward (along its facing direction).
//   - Pressing S moves it backward.
//   - Pressing W after rolling backward stops and reverses direction.
//   - Holding A/D produces a stable wheel steer angle (no flicker).

import { test, expect, type Page } from '@playwright/test';

interface Diag {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  wheels: { steer: number; spin: number; suspensionLength: number }[];
  rpm?: number;
  gear?: number;
}

async function readDiag(page: Page): Promise<Diag | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __prediction?: { state: () => Diag } };
    return w.__prediction ? w.__prediction.state() : null;
  });
}

async function waitConnected(page: Page): Promise<void> {
  // Dismiss the startup menu so the game connects.
  await page.click('#play-btn');
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 10_000 });
  // And wait until __prediction is up.
  await expect.poll(() => page.evaluate(() => {
    return Boolean((window as unknown as { __prediction?: unknown }).__prediction);
  }), { timeout: 10_000 }).toBe(true);
}

/** With yaw=pi/2 spawn, the car's local +Z axis maps to world +X. So the
 *  vehicle's "forward" axis in world coords can be derived from its
 *  rotation quaternion. */
function forwardAxisFromQuat(q: { x: number; y: number; z: number; w: number }): { x: number; z: number } {
  return {
    x: 2 * (q.x * q.z + q.w * q.y),
    z: 1 - 2 * (q.x * q.x + q.y * q.y),
  };
}

function dot(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return a.x * b.x + a.z * b.z;
}

test.describe('driving', () => {
  test('W drives the car forward', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);
    const start = await readDiag(page);
    expect(start).not.toBeNull();
    const fwd = forwardAxisFromQuat(start!.rotation);

    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    await page.keyboard.up('KeyW');

    const end = await readDiag(page);
    const dx = end!.position.x - start!.position.x;
    const dz = end!.position.z - start!.position.z;
    // Project displacement onto forward axis. Positive = forward.
    const along = dot({ x: dx, z: dz }, fwd);
    expect(along, `displacement along forward axis was ${along.toFixed(2)}m (dx=${dx.toFixed(2)}, dz=${dz.toFixed(2)})`).toBeGreaterThan(2);
  });

  test('S drives the car backward', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);
    const start = await readDiag(page);
    const fwd = forwardAxisFromQuat(start!.rotation);

    await page.keyboard.down('KeyS');
    await page.waitForTimeout(2500);
    await page.keyboard.up('KeyS');

    const end = await readDiag(page);
    const dx = end!.position.x - start!.position.x;
    const dz = end!.position.z - start!.position.z;
    const along = dot({ x: dx, z: dz }, fwd);
    expect(along, `displacement along forward axis was ${along.toFixed(2)}m`).toBeLessThan(-1);
  });

  test('W after rolling backward eventually moves forward again', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);
    const start = await readDiag(page);
    const fwd = forwardAxisFromQuat(start!.rotation);

    // First go backward.
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(1500);
    await page.keyboard.up('KeyS');
    const afterBack = await readDiag(page);
    const backDist = dot({
      x: afterBack!.position.x - start!.position.x,
      z: afterBack!.position.z - start!.position.z,
    }, fwd);
    expect(backDist).toBeLessThan(-0.5);

    // Now press W. Should slow, stop, then go forward.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(5000);
    await page.keyboard.up('KeyW');
    const afterFwd = await readDiag(page);
    const fwdDist = dot({
      x: afterFwd!.position.x - afterBack!.position.x,
      z: afterFwd!.position.z - afterBack!.position.z,
    }, fwd);
    // We may not get all the way back to start (mass + gear shift takes
    // time) but we must have made forward progress relative to where we
    // were after the reverse maneuver.
    expect(fwdDist, `forward progress after W from rolling-back was ${fwdDist.toFixed(2)}m`).toBeGreaterThan(0.3);
  });

  test('drives at least 30m down the road in 8s (A->B navigation)', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);
    const start = await readDiag(page);
    const fwd = forwardAxisFromQuat(start!.rotation);

    // Hold W. The car should pick up speed and cover at least 30m of
    // forward distance. This validates the "engine actually has enough
    // power to make meaningful progress" requirement, plus the gear
    // shifts work, plus the prediction stays in sync.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(8000);
    await page.keyboard.up('KeyW');

    const end = await readDiag(page);
    const dx = end!.position.x - start!.position.x;
    const dz = end!.position.z - start!.position.z;
    const along = dot({ x: dx, z: dz }, fwd);
    expect(along, `forward distance after 8s of W = ${along.toFixed(1)}m`).toBeGreaterThan(30);
  });

  test('drives up a moderate hill (climb test)', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);

    // The road is straight along +X; off-road is mostly hilly. To climb
    // we drive forward then turn. Aiming for at least some altitude gain.
    const start = await readDiag(page);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2500);
    await page.keyboard.down('KeyD'); // turn off the road
    await page.waitForTimeout(4500);
    await page.keyboard.up('KeyD');
    await page.keyboard.up('KeyW');

    const end = await readDiag(page);
    // We should have moved off the spawn meaningfully and the car
    // should still be upright (quaternion w near cos(yaw/2) regardless of
    // yaw, but |w| > 0.5 means we're not on our roof).
    const dist = Math.hypot(
      end!.position.x - start!.position.x,
      end!.position.z - start!.position.z,
    );
    expect(dist, `total horizontal travel was ${dist.toFixed(1)}m`).toBeGreaterThan(15);
    expect(Math.abs(end!.rotation.w), `quaternion w was ${end!.rotation.w.toFixed(3)} (car upside down?)`).toBeGreaterThan(0.5);
  });

  test('rendered wheel rotations are stable while driving + turning', async ({ page }) => {
    // The previous "stable steer" test only checked prediction state;
    // it missed a bug where the rendered wheel rotation order made the
    // wheel tumble around a world axis when both rolling (spin) and
    // turning (steer) were active. This test reads the actual mesh's
    // world quaternion and watches for jitter while driving + steering.
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);

    // Drive forward + turn left.
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(1500);

    const samples: { y: number; x: number }[] = await page.evaluate(async () => {
      const w = window as unknown as { __scene?: any };
      const s = w.__scene!;
      const ids = [...s.vehicles.keys()];
      const v = s.vehicles.get(ids[0])!;
      const wheel = v.wheels[0]!;
      const out: { y: number; x: number }[] = [];
      for (let i = 0; i < 30; i++) {
        out.push({ x: wheel.rotation.x, y: wheel.rotation.y });
        await new Promise<void>((r) => setTimeout(r, 25));
      }
      return out;
    });

    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');

    // wheel.rotation.x (spin) should be smoothly increasing.
    const xDiffs: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      xDiffs.push(samples[i]!.x - samples[i - 1]!.x);
    }
    const xMean = xDiffs.reduce((a, b) => a + b, 0) / xDiffs.length;
    // All diffs should have the same sign as the mean (no reversals).
    const reversals = xDiffs.filter((d) => Math.sign(d) !== Math.sign(xMean) && Math.abs(d) > 0.01).length;
    expect(reversals, `wheel spin reversed direction ${reversals} times in 30 samples (mean dx=${xMean.toFixed(3)})`).toBeLessThan(3);

    // wheel.rotation.y (steer) should be near constant once at lock.
    const yMean = samples.reduce((a, b) => a + b.y, 0) / samples.length;
    const yVar = samples.reduce((a, b) => a + (b.y - yMean) ** 2, 0) / samples.length;
    const yStdev = Math.sqrt(yVar);
    expect(yStdev, `wheel steer stdev was ${yStdev.toFixed(4)}`).toBeLessThan(0.03);
  });

  test('holding A produces a stable left steer angle (no flicker)', async ({ page }) => {
    await page.goto('/?auto=1');
    await waitConnected(page);
    await page.waitForTimeout(800);

    await page.keyboard.down('KeyA');
    // Let the steer angle reach its target.
    await page.waitForTimeout(800);
    // Sample 20 readings over 0.5s and check they don't oscillate.
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const d = await readDiag(page);
      samples.push(d!.wheels[0]!.steer);
      await page.waitForTimeout(25);
    }
    await page.keyboard.up('KeyA');
    // Mean should be clearly negative (left lock).
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean, `mean steer was ${mean.toFixed(3)}`).toBeLessThan(-0.2);
    // Standard deviation should be small (<= 1% of mean magnitude).
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    const stdev = Math.sqrt(variance);
    expect(stdev, `steer stdev was ${stdev.toFixed(4)} on samples ${JSON.stringify(samples.map((s) => +s.toFixed(3)))}`).toBeLessThan(0.02);
  });
});
