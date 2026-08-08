import { expect, test, type Page } from '@playwright/test';

async function waitForVehicle(page: Page): Promise<void> {
  await expect(page.locator('#hud')).toContainText('connected', { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as {
      __scene?: { localId?: string | null; vehicles?: Map<string, unknown> };
      __localSimulation?: unknown;
    };
    return Boolean(w.__localSimulation && w.__scene?.localId && w.__scene.vehicles?.has(w.__scene.localId));
  }), { timeout: 15_000 }).toBe(true);
}

async function parkInWorkshop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __localSimulation: { resetTo(pose: { position: { x: number; y: number; z: number }; yaw: number }): void };
    };
    w.__localSimulation.resetTo({
      position: { x: -58, y: 2.2, z: -28.5 },
      yaw: Math.PI,
    });
  });
  await expect(page.locator('#workshop-prompt')).toBeVisible({ timeout: 10_000 });
}

test('repairs, switches and fits a vehicle while another client observes the atomic result', async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext();
  const observerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const observer = await observerContext.newPage();
  await Promise.all([
    owner.goto('/?auto=1&name=workshop-owner'),
    observer.goto('/?auto=1&name=workshop-observer'),
  ]);
  await Promise.all([waitForVehicle(owner), waitForVehicle(observer)]);
  const ownerId = await owner.evaluate(() => (window as unknown as { __scene: { localId: string } }).__scene.localId);

  // Damage is owner-authoritative. Entering a valid bay repairs it before
  // the customisation clone opens.
  await owner.evaluate(() => {
    const sim = (window as unknown as { __localSimulation: any }).__localSimulation;
    sim.vehicle.damage.body = 0.35;
    sim.vehicle.damage.engine = 0.42;
    sim.vehicle.damage.steering = 0.58;
  });
  await parkInWorkshop(owner);
  await owner.keyboard.press('KeyF');
  await expect(owner.locator('#workshop-overlay')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => owner.evaluate(() => {
    const sim = (window as unknown as { __localSimulation: any }).__localSimulation;
    return sim.vehicle.damage;
  })).toMatchObject({ body: 1, engine: 1, steering: 1 });
  await expect.poll(() => observer.evaluate(() => {
    const sim = (window as unknown as { __localSimulation: { activeRemoteProxyCount: number } }).__localSimulation;
    return sim.activeRemoteProxyCount;
  })).toBe(0);

  // Software WebGL can render at only a few frames per second in CI.
  // Dispatch through the DOM so Playwright does not wait several frames
  // for actionability after every synchronous preview rebuild.
  await owner.evaluate(() => {
    const click = (selector: string): void => {
      const target = document.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`missing workshop control: ${selector}`);
      target.click();
    };
    const category = (name: string): void => click(`[data-category="${name}"]`);
    click('[data-id="overlander"]');
    category('Suspension');
    click('[data-id="overlander.suspension.flex-100"]');
    category('Tyres');
    click('[data-id="overlander.tire.mt-35"]');
    category('Front bar');
    click('[data-id="overlander.frontBar.steel-winch"]');
    category('Winch');
    click('[data-id="overlander.winch.fitted"]');
    category('Lockers');
    document.querySelectorAll<HTMLInputElement>('.workshop-toggle input')[0]!.click();
    // The first change synchronously rerenders the category, so reacquire
    // the front checkbox instead of clicking a now-detached node.
    document.querySelectorAll<HTMLInputElement>('.workshop-toggle input')[1]!.click();
  });
  await expect(owner.locator('.workshop-main')).toContainText('ALL PARTS FREE');
  await owner.locator('[data-action="apply"]').evaluate((button: HTMLButtonElement) => button.click());
  await expect(owner.locator('#workshop-overlay')).toBeHidden({ timeout: 15_000 });

  await expect.poll(() => observer.evaluate((id) => {
    const scene = (window as unknown as { __scene: any }).__scene;
    return scene.vehicles.get(id)?.group.userData.vehicleBuild?.baseId ?? null;
  }, ownerId), { timeout: 15_000 }).toBe('overlander');
  await expect.poll(() => observer.evaluate(() => {
    const sim = (window as unknown as { __localSimulation: { activeRemoteProxyCount: number } }).__localSimulation;
    return sim.activeRemoteProxyCount;
  })).toBe(1);

  // The fitted drivetrain controls become functional again after exit.
  await owner.keyboard.down('KeyV');
  await expect(owner.locator('#hud-drivetrain')).toContainText('LOW RANGE', { timeout: 10_000 });
  await owner.keyboard.up('KeyV');
  await owner.keyboard.down('KeyZ');
  await expect(owner.locator('#hud-drivetrain')).toContainText('R LOCK', { timeout: 10_000 });
  await owner.keyboard.up('KeyZ');
  await owner.keyboard.down('KeyX');
  await expect(owner.locator('#hud-drivetrain')).toContainText('F LOCK', { timeout: 10_000 });
  await owner.keyboard.up('KeyX');

  await ownerContext.close();
  await observerContext.close();
});
