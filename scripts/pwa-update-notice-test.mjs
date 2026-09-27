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
        const floating = page.locator('.pwa-update-floating .pwa-update-notice');
        await expect(floating).toHaveCount(0);
        expect(await page.locator('[data-crate-section="reminders"] .pwa-reminders-view').count()).toBe(0);
        available = 'notice-after';
        const beforeCheck = checks;
        await page.clock.fastForward(5 * 60_000);
        await expect(floating).toBeVisible();
        expect(checks).toBeGreaterThan(beforeCheck);
        // Detection is global even when Reminders has never mounted.
        await page.getByRole('button', { name: 'Save a link', exact: true }).click();
        const capture = page.getByRole('dialog', { name: 'Save a link' });
        await expect(capture).toBeVisible();
        await expect(floating).not.toBeVisible();
        await page.getByRole('button', { name: 'Close save a link' }).click();
        await expect(capture).toHaveCount(0);
        await expect(floating).toBeVisible();
        await switchFeature(page, 'Reminders');
        await expect(page.locator('.pwa-reminders-view')).toBeVisible();
        await page.locator('[data-crate-section="reminders"] .pwa-dock [data-tab="inbox"]').click();
        await expect(floating).toBeVisible();
        const box = await floating.boundingBox();
        expect(box.height).toBeLessThanOrEqual(56);
        const dock = await page.locator('[data-crate-section="reminders"] .pwa-dock').boundingBox();
        expect(box.y + box.height).toBeLessThanOrEqual(dock.y);
        await expect(page.locator('[data-leaving="true"]')).toHaveCount(0);
        await page.screenshot({ path: `test-results/update-notice/${engine.name()}-${colorScheme}.png` });
        await page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true }).click();
        await expect(floating).not.toBeVisible();
        await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
        await expect(floating).toBeVisible();
        await page.getByRole('button', { name: 'Open settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await expect(settings.locator('.pwa-update-notice')).toBeVisible();
        await expect(floating).not.toBeVisible();
        await settings.getByRole('button', { name: 'Dismiss update notice' }).click();
        await expect(settings.locator('.pwa-update-notice')).toHaveCount(0);
        await settings.getByRole('button', { name: 'About', exact: true }).click();
        await expect(settings.getByRole('button', { name: 'Update available', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Close settings', exact: true }).click();
        await switchFeature(page, 'Reading');
        await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
        await expect(floating).toHaveCount(0);
        available = 'notice-next';
        await page.clock.fastForward(5 * 60_000);
        await expect(floating).toBeVisible();
        await page.setViewportSize({ width: 320, height: 568 });
        const narrow = await floating.boundingBox();
        expect(narrow.x).toBeGreaterThanOrEqual(0);
        expect(narrow.x + narrow.width).toBeLessThanOrEqual(320);
        expect(await floating.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.setViewportSize({ width: 1100, height: 800 });
        const desktop = await floating.boundingBox();
        expect(desktop.width).toBeLessThanOrEqual(400);
        await page.screenshot({ path: `test-results/update-notice/${engine.name()}-${colorScheme}-desktop.png` });
        expect(errors).toEqual([]);
        await context.close();
        console.log(`${engine.name()} ${colorScheme}: global detection, polling, sheets, dismissal, Settings and compact layout passed`);
      }
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
