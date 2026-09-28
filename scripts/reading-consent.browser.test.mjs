import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`Reading ${name}: full article saves without a separate fetching switch`, { timeout: 60000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crate-consent-'));
    let runtime, server, browser;
    try {
      runtime = await openLocalRuntime({ dataDir: dir });
      const vault = await issueLocalDevice(runtime.db, 'Consent test');
      server = createServer(async (req, res) => {
        try {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, {
            method: req.method, headers: req.headers,
            ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(chunks) }),
          });
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch { res.writeHead(500); res.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://localhost:${server.address().port}`;
      const api = async (path, body) => {
        const response = await runtime.mf.dispatchFetch(`${origin}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '1', 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      await api('/reading/policy', { enabled: false, folderPath: 'Reading', revision: null });
      const enrollment = await api('/reading/access', { kind: 'reading' });
      browser = await engine.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await page.goto(enrollment.url);
      await expect(page.getByRole('button', { name: 'Save a link', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Save a link', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Save a link', exact: true });
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
      await expect(dialog.getByText('Your server downloads article text from links you save.')).toBeVisible();
      await mkdir('test-results/reading-consent', { recursive: true });
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        await page.screenshot({ path: `test-results/reading-consent/${name}-${theme}.png` });
      }
      await dialog.getByLabel('Link', { exact: true }).fill('https://example.invalid/bookmark');
      await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await api('/reading/list')).items.length).toBe(1);
      assert.equal((await api('/reading/list')).items[0].capture_method, 'url');
      assert.equal((await api('/reading/fetching')).enabled, true);
      await page.getByRole('button', { name: 'Save a link', exact: true }).click();
      await dialog.getByLabel('Link', { exact: true }).fill('https://example.invalid/article');
      await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await api('/reading/list')).items.length).toBe(2);
      assert.equal((await api('/reading/fetching')).enabled, true);
      const permission = await api('/reading/fetching');
      await api('/reading/fetching', { enabled: false, revision: permission.revision });
      await page.reload();
      await expect(page.getByRole('button', { name: 'Save a link', exact: true })).toBeVisible();
      assert.equal((await api('/reading/list')).items.length, 2);
      const features = await api('/features');
      await api('/features', { feature: 'reading', enabled: false, revision: features.revision });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('heading', { name: 'Reading paused', exact: true })).toBeVisible();
      await page.screenshot({ path: `test-results/reading-consent/${name}-shared-paused.png` });
      await expect(page.getByRole('button', { name: 'Save a link', exact: true })).toHaveCount(0);
      const paused = await api('/features');
      await api('/features', { feature: 'reading', enabled: true, revision: paused.revision });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('button', { name: 'Save a link', exact: true })).toBeVisible();
      assert.equal((await api('/reading/list')).items.length, 2);

    } finally {
      await browser?.close();
      if (server) await new Promise(resolve => server.close(resolve));
      await runtime?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
