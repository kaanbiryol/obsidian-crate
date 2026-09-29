import { defineConfig } from '@playwright/test';

// Static tools and --list can load this config without starting a server.
// The launcher supplies an isolated run before executing browser tests.
const run: { id: string; port: number } = JSON.parse(process.env.CRATE_VISUAL_TEST_RUN ?? 'null')
  ?? { id: 'unstarted', port: 4173 };
const baseURL = `http://127.0.0.1:${run.port}`;

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '*.spec.ts',
  snapshotPathTemplate: '{testDir}/baselines/{arg}{ext}',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  outputDir: `test-results/visual-${run.id}`,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `playwright-report/visual-${run.id}` }]],
  use: { baseURL, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/visual-preview.mjs', url: baseURL, reuseExistingServer: false, timeout: 120_000 },
});
