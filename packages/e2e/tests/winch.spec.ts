import { expect, test } from '@playwright/test';

test('renders and operates an attached recovery cable', async ({ page }) => {
  await page.goto('/?auto=1&name=winch-test');
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__localSimulation))).toBe(true);

  await page.evaluate(() => {
    const w = window as any;
    const state = w.__localSimulation.vehicleState();
    const id = w.__scene.localId;
    const anchor = { x: state.position.x + 8, y: state.position.y, z: state.position.z + 8 };
    w.__winchController.onAck({ seq: 999, ok: true, link: {
      id: `${id}:e2e`, ownerId: id,
      target: { kind: 'obstacle', obstacleId: 'e2e-anchor', anchor },
      cableLength: Math.hypot(anchor.x - state.position.x, anchor.z - state.position.z),
      motor: 0, tension: 0, status: 'attached',
    } });
  });

  await page.keyboard.down('BracketRight');
  await expect(page.locator('#hud-winch')).toContainText('WINCH IN');
  await expect.poll(() => page.evaluate(() => {
    const group = (window as any).__scene.scene.getObjectByName('winches');
    return group?.children.length ?? 0;
  })).toBeGreaterThan(1);
  await page.keyboard.up('BracketRight');
  await expect(page.locator('#hud-winch')).toContainText('WINCH HOLD');
});
