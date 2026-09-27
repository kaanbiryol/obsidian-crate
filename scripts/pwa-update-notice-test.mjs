import { chromium, webkit, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { switchFeature } from './pwa-feature-navigation.mjs';

const version = 'notice-before';
const assets = await buildPwaPreviewAssets({ assetVersion: version });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir('test-results/update-notice', { recursive: true });
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const colorScheme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme, serviceWorkers: 'block', reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let available = version;
        let checks = 0;
        await page.route('**/notifications/version.json*', route => { checks++; return route.fulfill({ json: { assetVersion: available } }); });
        await page.route('**/reading/session', route => route.fulfill({ json: { id: 'update-notice', folderPath: 'Reading', generation: 'notice-generation', expiresAt: Date.now() + 86400000 } }));
        await page.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
        await page.clock.install();
        await page.goto(origin + '/notifications?section=reading');
        await expect(page.locator('.crate-reading__mobile-nav')).toBeVisible();
        const pill = page.getByRole('button', { name: 'Update available', exact: true });
        await expect(pill).toHaveCount(0);
        available = 'notice-after';
        const beforeCheck = checks;
        await page.clock.fastForward(5 * 60_000);
        await expect(pill).toBeVisible();
        expect(checks).toBeGreaterThan(beforeCheck);
        await expect(page.locator('.pwa-update-floating')).toHaveCount(0);
        await context.setOffline(true);
        await expect(pill).toBeDisabled();
        await expect(pill).toHaveAttribute('title', 'Connect to the internet to update.');
        await context.setOffline(false);
        await expect(pill).toBeEnabled();
        await switchFeature(page, 'Reminders');
        await expect(page.locator('.pwa-reminders-view')).toBeVisible();
        await page.locator('[data-crate-section="reminders"] .pwa-dock [data-tab="inbox"]').click();
        await expect(pill).toBeVisible();
        await page.screenshot({ path: `test-results/update-notice/${engine.name()}-${colorScheme}.png` });
        await page.getByRole('button', { name: 'Open settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await expect(settings.locator('.pwa-update-notice')).toBeVisible();
        await expect(settings.getByRole('button', { name: 'Update to the latest version' })).toHaveCount(1);
        await expect(settings.getByRole('button', { name: 'Update app', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Close settings', exact: true }).click();
        await switchFeature(page, 'Reading');
        await page.reload();
        await expect(page.locator('.crate-reading__mobile-nav')).toBeVisible();
        await page.clock.fastForward(5 * 60_000);
        await expect(pill).toBeVisible();
        available = 'notice-next';
        await page.clock.fastForward(5 * 60_000);
        await expect(pill).toBeVisible();
        await page.setViewportSize({ width: 320, height: 568 });
        const narrow = await pill.boundingBox();
        expect(narrow.x).toBeGreaterThanOrEqual(0);
        expect(narrow.x + narrow.width).toBeLessThanOrEqual(320);
        const sync = await page.locator('[data-crate-section="reading"] .pwa-sync-indicator').boundingBox();
        expect(narrow.x + narrow.width).toBeLessThanOrEqual(sync.x);
        await page.screenshot({ path: `test-results/update-notice/${engine.name()}-${colorScheme}-narrow.png` });
        await page.setViewportSize({ width: 1100, height: 800 });
        await expect(pill).toBeVisible();
        await page.screenshot({ path: `test-results/update-notice/${engine.name()}-${colorScheme}-desktop.png` });
        // Fail the direct update check so this preview can verify feedback without reloading.
        await page.route('**/notifications/version.json*', async route => {
          await new Promise(resolve => setTimeout(resolve, 300));
          await route.fulfill({ status: 503, body: 'Unavailable' });
        });
        await pill.click();
        await expect(page.getByRole('dialog', { name: 'Update Crate', exact: true })).toHaveCount(0);
        await expect(pill).toBeDisabled();
        await expect(page.getByRole('alert')).toContainText('Could not check for updates');
        await expect(pill).toBeEnabled();
        expect(errors).toEqual([]);
        await context.close();
        console.log(`${engine.name()} ${colorScheme}: global detection, polling, direct updates, offline blocking, Settings and compact layout passed`);
      }
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
