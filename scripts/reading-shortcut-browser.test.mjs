import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`iPhone shortcut setup in ${name}`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-shortcut-browser-')); let runtime, server, browser, origin;
  const errors = []; let creates = 0, unavailable = false;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    runtime = await openLocalRuntime({ dataDir: join(dir, 'data') });
    const vault = await issueLocalDevice(runtime.db, 'Shortcut browser test');
    server = createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, async (req, res) => {
      try {
        if (req.url === '/reading/shortcut-pairing') { creates++; if (unavailable) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Not found"}'); return; } }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end('Test server failed'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `https://localhost:${server.address().port}`;
    const api = async (path, body, token = vault.token) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
    const enrollment = await api('/reading/access', { kind: 'reading' });
    const setup = new URL(enrollment.url); setup.searchParams.set('setup', 'shortcut');
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(setup.href);
    const dialog = page.getByRole('dialog', { name: 'Set up iPhone shortcut' });
    await expect(dialog).toBeVisible();
    const download = dialog.getByRole('link', { name: 'Download Save to Crate' });
    await expect(download).toHaveAttribute('href', 'https://crate.kaanbiryol.com/shortcuts/v1/Save%20to%20Crate%20(iOS%2027).shortcut');
    await expect(download).toHaveAttribute('rel', 'noopener noreferrer');
    await context.setOffline(true);
    await expect(dialog.getByRole('button', { name: 'Create pairing code', exact: true })).toBeDisabled();
    await expect(dialog.getByText('Connect to the internet to pair your shortcut.')).toBeVisible();
    await context.setOffline(false);
    await dialog.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    const input = dialog.getByLabel('Pairing code', { exact: true });
    await expect(input).toHaveValue(/\/reading\/shortcut-exchange#[a-f0-9]{64}$/).catch(async error => { console.error('Pairing UI error:', await dialog.getByRole('alert').allTextContents()); console.error('Fields:', await dialog.locator('textarea').count()); throw error; });
    assert.equal(creates, 1);
    const code = await input.inputValue(); assert.ok(!code.includes('Bearer'));
    // Clipboard denial leaves a selectable fallback; no second credential is minted.
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
    await dialog.getByRole('button', { name: 'Copy pairing code' }).click();
    await expect(dialog.getByRole('alert')).toContainText('copy it manually'); assert.equal(creates, 1);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedPairing = value; } } }));
    await dialog.getByRole('button', { name: 'Copy pairing code' }).click();
    assert.equal(await page.evaluate(() => window.copiedPairing), code);
    await expect(dialog.getByText('Copied. Open the shortcut', { exact: false })).toBeVisible();
    const connected = await api('/reading/shortcut-exchange', { token: new URL(code).hash.slice(1) }, '');
    const captureToken = connected.authorization.slice('Bearer '.length);
    const saved = await api('/reading/prepare', { url: 'https://example.invalid/paired-phone' }, captureToken);
    assert.ok(saved.launchUrl.includes('/notifications/save-reading#'));
    await mkdir('test-results/reading', { recursive: true });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      // Wait for the theme transition and verify readable secondary actions.
      await expect.poll(() => download.evaluate(el => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
        ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[0];
      })).toBeGreaterThan(colorScheme === 'dark' ? 150 : 0);
      await page.screenshot({ path: `test-results/reading/${name}-shortcut-${colorScheme}.png`, fullPage: true });
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await dialog.getByRole('heading', { name: 'Try it', exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('heading', { name: 'Try it', exact: true })).toBeVisible();
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    const closeBox = await dialog.getByRole('button', { name: 'Close set up iphone shortcut' }).boundingBox();
    assert.ok(closeBox && closeBox.y >= 0 && closeBox.y + closeBox.height <= 568, 'The close control must stay visible while scrolling');
    await page.screenshot({ path: `test-results/reading/${name}-shortcut-small.png`, fullPage: true });
    await page.clock.setFixedTime(new Date(Date.now() + 11 * 60_000));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(dialog.getByText('This pairing code expired.', { exact: false })).toBeVisible();
    await expect(input).toHaveCount(0);
    await page.clock.setFixedTime(new Date());
    await dialog.getByRole('button', { name: 'Back to settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Reading settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Set up iPhone shortcut', exact: true }).click();
    await expect(input).toHaveCount(0);
    unavailable = true;
    await dialog.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Update your Crate server');
    unavailable = false;
    await dialog.getByRole('button', { name: 'Create pairing code', exact: true }).click();
    await expect(input).toHaveValue(/shortcut-exchange#/);
    await page.evaluate(() => { localStorage.removeItem('crate-reading-session-v1'); window.dispatchEvent(new Event('storage')); });
    await expect(page.getByRole('heading', { name: 'Your reading, everywhere' })).toBeVisible();
    await expect(input).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await runtime?.close(); await rm(dir, { recursive: true, force: true }); }
});
