import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const output = resolve('.generated/editor-contract/current');
export default defineConfig({
  testDir: '.', testMatch: 'editor.spec.ts', fullyParallel: true, workers: process.env.CI ? 4 : undefined, retries: 0,
  outputDir: resolve(output, 'artifacts'),
  reporter: [['list'], ['json', { outputFile: resolve(output, 'results.json') }]],
  use: { baseURL: 'http://127.0.0.1:8791', viewport: { width: 390, height: 844 }, hasTouch: true,
    locale: 'en-US', timezoneId: 'UTC', trace: process.env.CI ? 'retain-on-failure' : 'off' },
  projects: ['chromium', 'webkit'].flatMap(browserName => ['pwa', 'plugin'].map(host => ({
    name: `${browserName}-${host}`, use: { browserName: browserName as 'chromium' | 'webkit' }, metadata: { host },
  }))),
  webServer: { command: 'node node_modules/vite/bin/vite.js --config tests/editor-contract/vite.config.mts', cwd: process.cwd(),
    url: 'http://127.0.0.1:8791', reuseExistingServer: false },
});
