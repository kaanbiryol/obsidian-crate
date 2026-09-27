import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

for (const engine of [chromium, webkit]) test(`iOS 27 headers in ${engine.name()}`, { timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-ios27-'));
  let runtime, browser, server;
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'iOS 27 header test');
    server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end('Test server failed'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: 'POST', headers: {
        Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'application/json',
      }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
    const enrollment = await api('/notifications/reminders-enrollment-token', { folderPath: 'Reminders' });
    browser = await engine.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    await page.goto(`${origin}/notifications?token=${enrollment.token}`);
    await expect(page.locator('html')).toHaveAttribute('data-pwa-ios27-standalone', 'true');
    await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'default');
    const panel = page.locator('.crate-feature-panel[data-active="true"]');
    const dock = panel.locator('.pwa-dock');
    await dock.getByRole('button', { name: 'Reading List', exact: true }).tap();
    await expect(panel).toHaveAttribute('data-crate-section', 'reading');
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        const header = panel.locator('.crate-reading__header');
        await expect(header).toHaveCSS('position', 'sticky');
        await expect(header).toHaveCSS('background-color', colorScheme === 'light' ? 'rgb(247, 247, 248)' : 'rgb(13, 13, 15)');
        await dock.locator('[data-dock-group]').focus(); await page.keyboard.press('ArrowDown');
        const menu = page.getByRole('dialog', { name: 'Reading views', exact: true });
        await expect(menu).toBeVisible();
        await expect.poll(async () => (await menu.boundingBox()).y).toBeGreaterThanOrEqual((await header.boundingBox()).y + (await header.boundingBox()).height);
        await page.keyboard.press('Escape'); await expect(menu).not.toBeVisible();
        await page.getByRole('button', { name: 'Open settings', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Close settings', exact: true }).click();
        await expect(page.locator('body')).not.toHaveCSS('position', 'fixed');
      }
    }
    // The same gate and metadata survive a Home Screen reload.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-pwa-ios27-standalone', 'true');
    await expect(panel.locator('.view-header')).toHaveCSS('position', 'sticky');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
