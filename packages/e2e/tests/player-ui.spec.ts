import { test, expect, type Locator, type Page } from '@playwright/test';

async function waitConnected(page: Page): Promise<void> {
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 20_000 });
  await expect(page.locator('#hud-tick')).toContainText(/tick=[1-9]\d*/);
}

async function boxesOverlap(a: Locator, b: Locator): Promise<boolean> {
  const [ra, rb] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (!ra || !rb) return false;
  return ra.x < rb.x + rb.width
    && ra.x + ra.width > rb.x
    && ra.y < rb.y + rb.height
    && ra.y + ra.height > rb.y;
}

test('join briefing, connected instruments, and radio retain their behavior', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');

  const dialog = page.getByRole('dialog', { name: 'mydrunner' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const patrol = page.getByRole('radio', { name: /Patrol GQ/ });
  const hilux = page.getByRole('radio', { name: /^Hilux/ });
  await expect(patrol).toHaveAttribute('aria-checked', 'true');

  await page.getByLabel('Driver call sign').fill('Rally Ada');
  await patrol.focus();
  await page.keyboard.press('ArrowRight');
  await expect(hilux).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Drive' }).click();

  await waitConnected(page);
  await expect(page.locator('#hud-speed-value')).toHaveText(/\d+/);
  await expect(page.locator('.hud-speed-unit')).toHaveText('km/h');
  await expect(page.locator('#hud-gear-value')).toHaveText(/[NR1-9]/);
  await expect(page.locator('#hud-surface')).not.toHaveText('—');
  await expect(page.locator('#minimap')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    name: localStorage.getItem('mydrunner.name'),
    car: localStorage.getItem('mydrunner.carKind'),
  }))).toEqual({ name: 'Rally Ada', car: 'hilux' });

  await page.keyboard.press('KeyT');
  const radioInput = page.getByLabel('Team radio // transmit');
  await expect(radioInput).toBeFocused();
  await radioInput.fill('Trail is clear');
  await page.keyboard.press('Enter');
  await expect(page.locator('#chat-input-wrap')).not.toHaveClass(/open/);
  await expect(page.locator('#chat-log')).toContainText('Trail is clear');

  await page.keyboard.press('KeyT');
  await expect(radioInput).toBeFocused();
  await radioInput.fill('cancel me');
  await page.keyboard.press('Escape');
  await expect(page.locator('#chat-input-wrap')).not.toHaveClass(/open/);
  await expect(page.locator('#chat-log')).not.toContainText('cancel me');

  // The development hook exercises the same presenter called by the real
  // socket callbacks, while leaving the authoritative net client untouched.
  await page.evaluate(() => {
    const w = window as unknown as {
      __playerUI: { setConnectionState(state: { mode: string; message: string }): void };
    };
    w.__playerUI.setConnectionState({
      mode: 'reconnecting',
      message: 'disconnected: test link — reconnecting in 1s',
    });
  });
  await expect(page.locator('#hud-alert')).toContainText('reconnecting in 1s');
  await expect(page.locator('.hud-cluster')).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as {
      __playerUI: { setConnectionState(state: { mode: string; message: string }): void };
    };
    w.__playerUI.setConnectionState({ mode: 'fatal', message: 'protocol mismatch: update client' });
  });
  await expect(page.locator('#hud-alert')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#hud-alert')).toContainText('protocol mismatch');
  await expect(page.locator('.hud-cluster')).toBeVisible();
});

test('desktop and touch layouts keep instruments and controls separated', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?auto=1&name=layout-check');
  await waitConnected(page);

  const session = page.locator('.hud-session');
  const minimap = page.locator('#minimap-wrap');
  const cluster = page.locator('.hud-cluster');
  const help = page.locator('#help');
  expect(await boxesOverlap(session, minimap)).toBe(false);
  expect(await boxesOverlap(cluster, help)).toBe(false);

  await page.keyboard.press('KeyT');
  expect(await boxesOverlap(page.locator('#chat-input-wrap'), cluster)).toBe(false);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.body.classList.add('touch'));
  expect(await boxesOverlap(session, minimap)).toBe(false);
  expect(await boxesOverlap(cluster, minimap)).toBe(false);
  expect(await boxesOverlap(cluster, page.locator('#steer-pad'))).toBe(false);
  expect(await boxesOverlap(cluster, page.locator('#pedal-stack'))).toBe(false);

  for (const id of ['#cam-btn', '#reset-btn', '#mute-btn', '#chat-btn']) {
    const box = await page.locator(id).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  const handbrake = page.locator('#handbrake-btn');
  await handbrake.dispatchEvent('pointerdown', { pointerId: 1 });
  await expect(handbrake).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#hud-handbrake')).toHaveText('HANDBRAKE');
  await handbrake.dispatchEvent('pointerdown', { pointerId: 1 });
  await expect(handbrake).toHaveAttribute('aria-pressed', 'false');

  await page.setViewportSize({ width: 844, height: 390 });
  expect(await boxesOverlap(session, minimap)).toBe(false);
  expect(await boxesOverlap(cluster, page.locator('#steer-pad'))).toBe(false);
  expect(await boxesOverlap(cluster, page.locator('#pedal-stack'))).toBe(false);
  expect(await boxesOverlap(page.locator('#aux-row'), minimap)).toBe(false);

  const transitionMs = await page.locator('#steer-knob').evaluate((el) => {
    const duration = getComputedStyle(el).transitionDuration.split(',')[0]!.trim();
    const value = Number.parseFloat(duration);
    return duration.endsWith('ms') ? value : value * 1000;
  });
  expect(transitionMs).toBeLessThanOrEqual(0.01);
});
