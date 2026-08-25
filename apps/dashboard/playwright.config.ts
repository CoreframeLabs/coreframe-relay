import { PlaywrightTestConfig, devices } from '@playwright/test';

const config: PlaywrightTestConfig = {
  workers: 1,
  globalSetup: require.resolve('./tests/e2e/support/globalSetup.ts'),
  // Timeout per test
  timeout: 100 * 1000,
  // Assertion timeout
  expect: {
    timeout: 10 * 1000,
  },
  projects: [
    {
      name: 'setup',
      testMatch: 'support/*.setup.ts',
      teardown: 'cleanup db',
    },
    {
      name: 'cleanup db',
      testMatch: 'support/*.teardown.ts',
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    /**
     * Consumer-journey E2E — a browser-level walk through signup → login → route
     * creation → test webhook → delivery log → DLQ → sign-out, using the real UI a
     * cold visitor sees (no API-shortcut setup). Deliberately NOT wired to the
     * `setup`/`cleanup db` project pair above: that pair signs up one fixed
     * jackson@example.com user and its teardown runs unscoped
     * `prisma.user.deleteMany()` / `team.deleteMany()` — a blanket wipe of every
     * Team/User row in the local DB, appropriate for the SSO/settings suites' one
     * static fixture user but wrong for a suite that creates unique, timestamped
     * throwaway data on every run and cleans up ONLY what it created (see
     * `consumer-journey/support/cleanup.ts`). Run in isolation with:
     *   npx playwright test --project=consumer-journey
     */
    {
      name: 'consumer-journey',
      testDir: './tests/e2e/consumer-journey',
      testMatch: '**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
      retries: 0,
    },
  ],
  reporter: 'html',
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:4002',
    reuseExistingServer: !process.env.CI,
  },
  retries: 1,
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    baseURL: 'http://localhost:4002',
    trace: 'retain-on-first-failure',
  },
  testDir: './tests/e2e',
};

export default config;
