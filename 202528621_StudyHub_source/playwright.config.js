import { defineConfig } from '@playwright/test';

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  workers: isCI ? 1 : undefined,
  retries: isCI ? 1 : 0,
  timeout: 30_000,
  expect: {
    timeout: isCI ? 15_000 : 10_000,
  },
  reporter: isCI
    ? [
        ['line'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
      ]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5001',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
  },
  webServer: {
    command:
      'sh -c "if [ -x ./venv/bin/python ]; then exec ./venv/bin/python -m tests.e2e.run_seeded_app; else exec python3 -m tests.e2e.run_seeded_app; fi"',
    url: 'http://127.0.0.1:5001',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
