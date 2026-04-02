import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5001',
    headless: true,
  },
  webServer: {
    command:
      'sh -c "if [ -x ./venv/bin/python ]; then exec ./venv/bin/python -m tests.e2e.run_seeded_app; else exec python3 -m tests.e2e.run_seeded_app; fi"',
    url: 'http://127.0.0.1:5001',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
