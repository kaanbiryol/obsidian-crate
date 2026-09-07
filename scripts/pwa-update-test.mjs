import http from 'node:http';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { createPwaPreviewServer } from './pwa-preview-server.mjs';
import { readJson, sendJson, sendText } from './pwa-preview-http.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';

const beforeVersion = 'install-before-update';
const afterVersion = 'install-after-update';
const [before, after] = await Promise.all([
  buildPwaPreviewAssets({ assetVersion: beforeVersion }),
  buildPwaPreviewAssets({ assetVersion: afterVersion }),
]);
const cardName = 'Check this article. Press Enter to edit reminder.';
const authKey = 'crate-reminders-auth-token';

async function testUpdate(browser, launchMode) {
  let assets = before;
  const exchanges = [];
  const installToken = `install-update-${launchMode}`;
  const browserToken = `browser-update-${launchMode}`;
  const availableTokens = new Set([installToken, browserToken]);
  const handlers = new Map([before, after].map(version => [version, createPwaPreviewServer({ assets: version, origin: 'http://127.0.0.1' })]));
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/notifications/preview-session.js') {
      // No fixture authentication, including in pages cached by the real SW.
      sendText(res, 200, '', 'application/javascript');
    } else if (path === '/notifications/reminders-exchange' && req.method === 'POST') {
      const body = await readJson(req);
      exchanges.push(body);
      if (!availableTokens.delete(body.token)) sendJson(res, 401, { error: 'Invalid or expired enrollment token' });
      else sendJson(res, 200, { authToken: previewAuthToken });
    } else {
      handlers.get(assets).emit('request', req, res);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const safari = await browser.newContext();
  let installed;
  try {
    const page = await safari.newPage();
    await page.goto(`${origin}/notifications?token=${installToken}&browserToken=${browserToken}&folder=Tasks&tab=inbox`);
    await page.getByRole('group', { name: cardName, exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    expect(exchanges.map(exchange => exchange.token)).toEqual([browserToken]);
    const browserAuth = await page.evaluate(key => localStorage.getItem(key), authKey);

    // This is an actual deployment and Update-button activation, not reload()
    // with service workers blocked. The new worker precaches generic HTML.
    assets = after;
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    const update = page.getByRole('button', { name: 'Update to the latest version', exact: true });
    await update.waitFor();
    await Promise.all([
      page.waitForEvent('load'),
      update.click(),
    ]);
    await page.getByRole('group', { name: cardName, exact: true }).waitFor();
    await expect(update).toHaveCount(0);
    const controllerVersion = await page.evaluate(() => new URL(navigator.serviceWorker.controller.scriptURL).searchParams.get('v'));
    expect(controllerVersion).toBe(afterVersion);
    expect(await page.locator('script[type="module"]').getAttribute('src')).toContain(afterVersion);
    expect(await page.evaluate(key => localStorage.getItem(key), authKey)).toBe(browserAuth);
    expect(exchanges.map(exchange => exchange.token)).toEqual([browserToken]);

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifest = await (await page.request.get(new URL(manifestHref, origin).href)).json();
    const startUrl = new URL(manifest.start_url, origin);
    expect(startUrl.searchParams.get('token')).toBe(installToken);
    expect(new URL(page.url()).searchParams.get('token')).toBe(installToken);
    expect(new URL(page.url()).searchParams.has('browserToken')).toBe(false);

    // Install AFTER updating, with isolated app storage and only the state
    // that the selected installation path transfers from Safari.
    installed = await browser.newContext();
    await installed.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
    if (launchMode === 'cookie') await installed.addCookies(await safari.cookies());
    const home = await installed.newPage();
    const launchUrl = launchMode === 'cookie' ? `${origin}/notifications` : startUrl.href;
    await home.goto(launchUrl);
    await home.getByRole('group', { name: cardName, exact: true }).waitFor();
    expect(exchanges.map(exchange => exchange.token)).toEqual([browserToken, installToken]);
    expect(exchanges[1].previousAuthToken).toBeUndefined();
    expect(await home.evaluate(key => localStorage.getItem(key), authKey)).toBeTruthy();
    expect(await home.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-config')).folderPath)).toBe('Tasks');
    expect(new URL(home.url()).searchParams.has('token')).toBe(false);
    expect(await installed.cookies()).toEqual([]);
    await home.close();
    const reopened = await installed.newPage();
    await reopened.goto(launchUrl);
    await reopened.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
    expect(exchanges).toHaveLength(2);
  } finally {
    await installed?.close();
    await safari.close();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const browserType of [chromium, webkit]) {
  const browser = await browserType.launch();
  try {
    for (const mode of ['manifest', 'cookie']) {
      await testUpdate(browser, mode);
      console.log(`${browserType.name()}: Safari update → ${mode} installation → repeated Home Screen launch passed`);
    }
  } finally { await browser.close(); }
}
