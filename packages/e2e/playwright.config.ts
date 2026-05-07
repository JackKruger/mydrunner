import { defineConfig, devices } from '@playwright/test';

// Some sandboxed environments cannot download Playwright browsers but already
// have them cached in /opt/pw-browsers. Honor it if present.
import { existsSync } from 'node:fs';
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

// Boots both server and client. The webServer entries are siblings - playwright
// waits for both URLs before running tests.
export default defineConfig({
  testDir: './tests',
  // Each test gets a fresh browser context, so the Rapier WASM is
  // recompiled from scratch in every test (~60s on slow CI runners).
  // 120s gives enough headroom for WASM + test logic on a slow runner.
  timeout: 120_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    // Allow page.goto to wait up to 90s for the load event (which
    // includes WASM compilation in the browser).
    navigationTimeout: 90_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @mydrunner/server run start',
      url: 'http://127.0.0.1:2567/health',
      reuseExistingServer: true,
      timeout: 30_000,
      // Forward server stdout/stderr to the test runner so latency
      // traces ([mydrunner-server] [trace] ...) appear in test output.
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @mydrunner/client run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
