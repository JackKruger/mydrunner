// Multiplayer smoke: two independent owners exchange state through the relay,
// render one another, and create/remove matching local collision proxies.

import { test, expect, type Page } from '@playwright/test';

interface ClientState {
  vehicles: number;
  proxies: number;
  activeProxies: number;
}

async function readClientState(page: Page): Promise<ClientState> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __scene?: { vehicles?: Map<string, unknown> };
      __localSimulation?: { remoteProxyCount?: number; activeRemoteProxyCount?: number };
    };
    return {
      vehicles: w.__scene?.vehicles?.size ?? -1,
      proxies: w.__localSimulation?.remoteProxyCount ?? -1,
      activeProxies: w.__localSimulation?.activeRemoteProxyCount ?? -1,
    };
  });
}

test('two clients relay state and maintain collision proxies', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await Promise.all([
    a.goto('/?auto=1&name=alice'),
    b.goto('/?auto=1&name=bob&car=hilux'),
  ]);

  await expect(a.locator('#hud')).toContainText('connected', { timeout: 10_000 });
  await expect(b.locator('#hud')).toContainText('connected', { timeout: 10_000 });

  const twoOwners = { vehicles: 2, proxies: 1, activeProxies: 1 };
  await expect.poll(() => readClientState(a), { timeout: 15_000 }).toEqual(twoOwners);
  await expect.poll(() => readClientState(b), { timeout: 15_000 }).toEqual(twoOwners);

  await ctxB.close();
  await expect.poll(() => readClientState(a), { timeout: 15_000 }).toEqual({
    vehicles: 1,
    proxies: 0,
    activeProxies: 0,
  });

  await ctxA.close();
});
