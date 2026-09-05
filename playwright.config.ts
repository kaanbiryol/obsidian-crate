import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '*.spec.ts',
  snapshotPathTemplate: '{testDir}/baselines/{arg}{ext}',
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:8790', locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: { command: 'npm run preview:ui', url: 'http://127.0.0.1:8790', reuseExistingServer: !process.env.CI },
});
