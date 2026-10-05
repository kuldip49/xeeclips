import { defineConfig } from '@playwright/test';

// Browser E2E against the running local stack (docker compose): frontend :3000,
// backend :4000. Uses the installed Google Chrome, so no browser download is needed.
export default defineConfig({
  testDir: './e2e',
  timeout: 45 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_FRONTEND_URL ?? 'http://localhost:3000',
    channel: 'chrome',
    headless: process.env.E2E_HEADED !== '1',
    viewport: { width: 1440, height: 900 },
    // Opt in with E2E_TRACE=1: on Windows the trace artifacts were once removed mid-run and
    // Playwright then reported the ENOENT instead of the test's own result.
    trace: process.env.E2E_TRACE === '1' ? 'retain-on-failure' : 'off',
    // A missing/hidden control must fail fast, not hang until the 45-minute test timeout.
    actionTimeout: 60_000
  }
});
