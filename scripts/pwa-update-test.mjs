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
const transitionKey = 'crate-pwa-update-transition';
// Exercise delayed module startup even when app.js is served from the real SW.
const delayedAfter = {
  ...after,
  PWA_APP_JS: `await globalThis.__crateUpdateAppGate;\n${after.PWA_APP_JS}`,
};

async function testUpdate(browser, launchMode) {
  let assets = before;
  let failNextVersionCheck = false;
  const exchanges = [];
  const installToken = `install-update-${launchMode}`;
  const browserToken = `browser-update-${launchMode}`;
  const availableTokens = new Set([installToken, browserToken]);
  const handlers = new Map([before, delayedAfter].map(version => [version, createPwaPreviewServer({ assets: version, origin: 'http://127.0.0.1' })]));
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/notifications/preview-session.js') {
      // No fixture authentication, including in pages cached by the real SW.
      sendText(res, 200, '', 'application/javascript');
    } else if (path === '/notifications/version.json' && failNextVersionCheck) {
      failNextVersionCheck = false;
      sendJson(res, 503, { error: 'Temporarily unavailable' });
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
  const savedTheme = launchMode === 'manifest' ? 'dark' : 'light';
  const safari = await browser.newContext({ colorScheme: savedTheme === 'dark' ? 'light' : 'dark' });
  await safari.addInitScript(({ savedTheme, transitionKey, previewAuthToken }) => {
    if (!localStorage.getItem('crate-reminders-theme')) localStorage.setItem('crate-reminders-theme', savedTheme);
    if (!sessionStorage.getItem(transitionKey)) return;
    // Model iOS settling its safe-area inset after the hydrated shell mounts.
    const layoutObserver = new MutationObserver(() => {
      if (!document.querySelector('.pwa-reminders-view')) return;
      layoutObserver.disconnect();
      window.__updateLayoutPhases = [];
      for (const [delay, inset] of [[80, 30], [160, 59]]) {
        setTimeout(() => {
          window.__updateLayoutPhases.push(document.documentElement.dataset.pwaUpdating);
          document.documentElement.style.setProperty('--pwa-safe-area-top', `${inset}px`);
        }, delay);
      }
    });
    layoutObserver.observe(document, { childList: true, subtree: true });
    window.__crateUpdateAppGate = new Promise(resolve => { window.__releaseUpdateApp = resolve; });
    const bootstrapGate = new Promise(resolve => { window.__releaseUpdateBootstrap = resolve; });
    const outboxGate = new Promise(resolve => { window.__releaseUpdateOutbox = resolve; });
    const requestLock = navigator.locks.request.bind(navigator.locks);
    navigator.locks.request = (name, callback) => requestLock(name, async lock => {
      if (name === 'crate-reminders-enrollment') {
        window.__updateBootstrapStarted = true;
        await bootstrapGate;
      }
      return callback(lock);
    });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (algorithm, data) => {
      if (new TextDecoder().decode(data) === previewAuthToken) {
        window.__updateOutboxStarted = true;
        await outboxGate;
      }
      return digest(algorithm, data);
    };
  }, { savedTheme, transitionKey, previewAuthToken });
  let installed;
  try {
    const page = await safari.newPage();
    await page.goto(`${origin}/notifications?token=${installToken}&browserToken=${browserToken}&folder=Tasks&tab=inbox`);
    await page.getByRole('group', { name: cardName, exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    expect(exchanges.map(exchange => exchange.token)).toEqual([browserToken]);
    const browserAuth = await page.evaluate(key => localStorage.getItem(key), authKey);
    const themeBackground = await page.locator('html').evaluate(root => getComputedStyle(root).backgroundColor);
    await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', savedTheme);
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations += 1; });

    // This is an actual deployment and Update-button activation, not reload()
    // with service workers blocked. The new worker precaches generic HTML.
    assets = delayedAfter;
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    const update = page.getByRole('button', { name: 'Update to the latest version', exact: true });
    await update.waitFor();
    failNextVersionCheck = true;
    await update.click();
    await expect(page.getByRole('alert')).toContainText('Could not check for updates');
    await expect(update).toBeEnabled();
    expect(navigations).toBe(0);
    expect(await page.evaluate(key => sessionStorage.getItem(key), transitionKey)).toBeNull();
    await expect(page.locator('html')).not.toHaveAttribute('data-pwa-updating');

    await page.evaluate(transitionKey => {
      window.addEventListener('beforeunload', () => {
        const overlay = document.getElementById('pwa-update-transition');
        sessionStorage.setItem('test-update-beforeunload', JSON.stringify({
          phase: document.documentElement.dataset.pwaUpdating,
          opacity: getComputedStyle(overlay).opacity,
          background: getComputedStyle(document.documentElement).backgroundColor,
          button: document.querySelector('.pwa-update-button__label[aria-hidden="false"]').textContent,
          marker: sessionStorage.getItem(transitionKey),
        }));
      });
    }, transitionKey);
    await update.click();
    await page.waitForFunction(() => typeof window.__releaseUpdateApp === 'function'
      && document.documentElement.dataset.pwaUpdating === 'restore');
    const beforeReload = await page.evaluate(() => JSON.parse(sessionStorage.getItem('test-update-beforeunload')));
    expect(beforeReload).toMatchObject({ phase: 'prepare', opacity: '1', background: themeBackground, button: 'Updating…' });
    expect(Number(beforeReload.marker)).toBeGreaterThan(0);
    expect(navigations).toBe(1);

    const transition = page.locator('#pwa-update-transition');
    await expect(transition).toHaveText('Updating Crate…');
    await expect(transition).toHaveCSS('opacity', '1');
    await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', savedTheme);
    await expect(page.locator('html')).toHaveCSS('background-color', themeBackground);
    expect(await page.locator('script[src*="theme-bootstrap.js"]').evaluate(script => script.defer)).toBe(false);
    expect(await page.evaluate(key => sessionStorage.getItem(key), transitionKey)).toBeNull();
    await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toHaveCount(0);

    await page.evaluate(() => window.__releaseUpdateApp());
    await page.waitForFunction(() => window.__updateBootstrapStarted);
    await expect(transition).toHaveCSS('opacity', '1');
    await expect(page.locator('html')).toHaveAttribute('data-pwa-updating', 'restore');
    await page.evaluate(() => window.__releaseUpdateBootstrap());
    await page.waitForFunction(() => window.__updateOutboxStarted);
    await expect(transition).toHaveCSS('opacity', '1');
    await expect(page.locator('html')).toHaveAttribute('data-pwa-updating', 'restore');
    await page.evaluate(() => window.__releaseUpdateOutbox());
    await page.getByRole('group', { name: cardName, exact: true }).waitFor();
    await expect(page.locator('html')).not.toHaveAttribute('data-pwa-updating');
    await expect(transition).toHaveCSS('opacity', '0');
    expect(await page.evaluate(() => window.__updateLayoutPhases)).toEqual(['restore', 'restore']);
    await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
    expect(navigations).toBe(1);
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
