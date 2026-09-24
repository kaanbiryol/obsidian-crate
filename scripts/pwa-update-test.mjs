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
  let releaseVersionCheck;
  const versionCheckGate = new Promise(resolve => { releaseVersionCheck = resolve; });
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
      await versionCheckGate;
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
  const reducedMotion = launchMode === 'cookie' ? 'reduce' : 'no-preference';
  const safari = await browser.newContext({ colorScheme: savedTheme === 'dark' ? 'light' : 'dark', reducedMotion });
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
    // The request is still blocked: a tap must cover the app immediately,
    // without waiting for the version check, download or activation.
    await expect(page.locator('html')).toHaveAttribute('data-pwa-updating', 'prepare');
    await expect(page.locator('#pwa-update-transition')).toHaveCSS('opacity', '1');
    await expect(page.locator('#app')).toHaveAttribute('inert', '');
    expect(await page.evaluate(key => sessionStorage.getItem(key), transitionKey)).toBeNull();
    releaseVersionCheck();
    await expect(page.getByRole('alert')).toContainText('Could not check for updates');
    await expect(update).toBeEnabled();
    await expect(page.locator('#app')).not.toHaveAttribute('inert');
    expect(navigations).toBe(0);
    expect(await page.evaluate(key => sessionStorage.getItem(key), transitionKey)).toBeNull();
    await expect(page.locator('html')).not.toHaveAttribute('data-pwa-updating');

    await page.evaluate(transitionKey => {
      window.addEventListener('beforeunload', () => {
        const overlay = document.getElementById('pwa-update-transition');
        const activity = overlay.querySelector('.pwa-update-screen__activity span');
        sessionStorage.setItem('test-update-beforeunload', JSON.stringify({
          phase: document.documentElement.dataset.pwaUpdating,
          opacity: getComputedStyle(overlay).opacity,
          background: getComputedStyle(document.documentElement).backgroundColor,
          button: document.querySelector('.pwa-update-button__label[aria-hidden="false"]').textContent,
          marker: sessionStorage.getItem(transitionKey),
          progress: new DOMMatrix(getComputedStyle(activity).transform).a,
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
    await expect(transition.locator('.pwa-update-screen__title')).toHaveText('Updating Crate');
    await expect(transition.locator('.pwa-update-screen__detail')).toHaveText('Getting the latest version ready.');
    const activity = transition.locator('.pwa-update-screen__activity span');
    const restoredProgress = await activity.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
    expect(restoredProgress).toBeGreaterThanOrEqual(beforeReload.progress - .001);
    expect(restoredProgress).toBeCloseTo(.9);
    await expect(activity).toHaveCSS('animation-name', 'none');
    await expect(transition).toHaveCSS('opacity', '1');
    await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', savedTheme);
    await expect(page.locator('html')).toHaveCSS('background-color', themeBackground);
    await expect(page.locator('script[nonce]')).toHaveCount(2);
    await expect(page.locator('script[src*="theme-bootstrap.js"]')).toHaveCount(0);
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
    await page.evaluate(() => {
      window.__updateRevealSamples = [];
      const sample = () => {
        const phase = document.documentElement.dataset.pwaUpdating;
        window.__updateRevealSamples.push({
          phase,
          opacity: Number(getComputedStyle(document.getElementById('pwa-update-transition')).opacity),
          inert: document.getElementById('app').hasAttribute('inert'),
          home: Boolean(document.querySelector('.pwa-reminders-view')),
        });
        if (phase) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      window.__releaseUpdateOutbox();
    });
    await page.getByRole('group', { name: cardName, exact: true }).waitFor();
    await expect(page.locator('html')).not.toHaveAttribute('data-pwa-updating');
    await expect(transition).toHaveCSS('opacity', '0');
    await expect(page.locator('#app')).not.toHaveAttribute('inert');
    const revealSamples = await page.evaluate(() => window.__updateRevealSamples);
    const intermediate = revealSamples.filter(sample => sample.opacity > 0 && sample.opacity < 1);
    if (reducedMotion === 'reduce') expect(intermediate).toHaveLength(0);
    else {
      expect(intermediate.length).toBeGreaterThanOrEqual(3);
      expect(intermediate.every(sample => sample.phase === 'revealing' && sample.inert && sample.home)).toBe(true);
      for (let index = 1; index < intermediate.length; index++) expect(intermediate[index].opacity).toBeLessThanOrEqual(intermediate[index - 1].opacity);
    }
    expect(await activity.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a)).toBe(1);
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
    releaseVersionCheck();
    await installed?.close();
    await safari.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testDeferredUpdate(browser) {
  let assets = before;
  let releaseWrite;
  let writeStarted = false;
  const writeGate = new Promise(resolve => { releaseWrite = resolve; });
  const handlers = new Map([before, after].map(version => [version, createPwaPreviewServer({ assets: version, origin: 'http://127.0.0.1' })]));
  const server = http.createServer(async (req, res) => {
    if (req.url === '/reminders/update' && req.method === 'POST') {
      writeStarted = true;
      await writeGate;
    }
    handlers.get(assets).emit('request', req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    // Model Home Screen suspension/resume; physical iOS still needs device QA.
    window.testVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.testVisibility });
  });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await page.getByRole('group', { name: cardName, exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const other = await context.newPage();
    await other.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await other.getByRole('group', { name: cardName, exact: true }).click();
    const otherTitle = other.getByRole('textbox', { name: 'Reminder title', exact: true });
    await otherTitle.fill('Keep this other tab draft');

    await page.getByRole('group', { name: cardName, exact: true }).click();
    const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
    await title.fill('Saved before automatic update');
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    assets = after;
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
    await page.waitForTimeout(2_500);
    expect(navigations).toBe(0);
    await expect(title).toHaveText('Saved before automatic update');

    await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
    await expect(title).toHaveCount(0);
    await expect.poll(() => writeStarted).toBe(true);
    await page.waitForTimeout(2_500);
    expect(navigations).toBe(0); // The editor closed, but its write is still pending.

    await page.evaluate(() => {
      window.testVisibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    releaseWrite();
    await page.waitForTimeout(2_500);
    expect(navigations).toBe(0);
    await page.evaluate(() => {
      window.testVisibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow')); // iOS can deliver both.
    });
    await page.waitForTimeout(2_500);
    expect(navigations).toBe(0); // Reading and resuming never trigger a reload.
    await page.getByRole('button', { name: 'Update to the latest version', exact: true }).click();
    await expect.poll(() => navigations, { timeout: 15_000 }).toBe(1);
    await expect(page.locator('html')).not.toHaveAttribute('data-pwa-updating');
    await expect(page.getByRole('group', { name: 'Saved before automatic update. Press Enter to edit reminder.', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Update to the latest version', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => new URL(navigator.serviceWorker.controller.scriptURL).searchParams.get('v'))).toBe(afterVersion);
    await expect(otherTitle).toHaveText('Keep this other tab draft');
    expect(await other.locator('script[type="module"]').getAttribute('src')).toContain(beforeVersion);
    await page.waitForTimeout(2_500);
    expect(navigations).toBe(1);
  } finally {
    releaseWrite();
    await context.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function testLaunchUpdate(browser, mode) {
  let assets = before;
  const handlers = new Map([before, after].map(version => [version, createPwaPreviewServer({ assets: version, origin: 'http://127.0.0.1' })]));
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (assets === after && path === '/notifications/version.json') {
      if (mode === 'failed-check' || mode === 'offline-signal') return sendJson(res, 503, { error: 'Unavailable' });
      if (mode === 'slow-check') await new Promise(resolve => setTimeout(resolve, 3_500));
    }
    if (assets === after && mode === 'slow-install' && path === '/notifications/sw.js' && req.url.includes(afterVersion)) {
      await new Promise(resolve => setTimeout(resolve, 3_500));
    }
    handlers.get(assets).emit('request', req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await context.addInitScript(beforeVersion => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    let exposedOldContent = false;
    new MutationObserver(() => {
      if (document.querySelector(`script[type="module"][src*="${beforeVersion}"]`)
        && document.querySelector('.pwa-reminders-view, .pwa-update-banner')) exposedOldContent = true;
      if (document.documentElement.dataset.pwaUpdating === 'prepare') {
        const launch = document.querySelector('.pwa-launch-splash .pwa-update-screen__activity span');
        const curtain = document.querySelector('#pwa-update-transition .pwa-update-screen__activity span');
        if (launch && curtain) window.__updateProgressDifference = Math.abs(launch.getBoundingClientRect().width - curtain.getBoundingClientRect().width);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pwa-updating'] });
    window.addEventListener('beforeunload', () => {
      sessionStorage.setItem('test-launch-exposed-content', String(exposedOldContent));
      if (typeof window.__updateProgressDifference === 'number') {
        sessionStorage.setItem('test-launch-progress-difference', String(window.__updateProgressDifference));
      }
    });
  }, beforeVersion);
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await page.getByRole('group', { name: cardName, exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    // Keep an old client alive so a waiting worker needs explicit activation.
    const other = await context.newPage();
    await other.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await other.getByRole('group', { name: cardName, exact: true }).waitFor();
    assets = after;
    if (mode === 'offline') await context.setOffline(true);
    // Playwright WebKit aborts native offline navigation before the SW can serve
    // its shell. Exercise the offline launch policy here; Chromium covers the
    // real offline navigation. Installed iPhone offline behavior needs device QA.
    if (mode === 'offline-signal') await context.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { value: false });
    });
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    const started = Date.now();
    await page.reload({ waitUntil: 'commit' });
    if (mode === 'fast') {
      await expect.poll(() => navigations).toBe(2);
      await expect(page.locator('html')).not.toHaveAttribute('data-pwa-updating');
      await expect(page.getByRole('group', { name: cardName, exact: true })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem('test-launch-exposed-content'))).toBe('false');
      const difference = await page.evaluate(() => sessionStorage.getItem('test-launch-progress-difference'));
      expect(difference).not.toBeNull();
      expect(Number(difference)).toBeLessThan(1);
      expect(await page.locator('script[type="module"]').getAttribute('src')).toContain(afterVersion);
      await expect(page.locator('.pwa-update-banner')).toHaveCount(0);
    } else {
      await page.getByRole('group', { name: cardName, exact: true }).waitFor();
      expect(Date.now() - started).toBeLessThan(3_500);
      await expect(page.locator('html')).not.toHaveAttribute('data-pwa-updating');
      if (mode.startsWith('slow')) {
        await page.getByRole('button', { name: 'Update to the latest version', exact: true }).waitFor();
        await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
      }
      await page.waitForTimeout(2_500);
      expect(navigations).toBe(1);
      expect(await page.locator('script[type="module"]').getAttribute('src')).toContain(beforeVersion);
    }
  } finally {
    await context.close();
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
    for (const mode of ['fast', 'slow-check', 'slow-install', 'failed-check', browserType === chromium ? 'offline' : 'offline-signal']) {
      await testLaunchUpdate(browser, mode);
      console.log(`${browserType.name()}: ${mode} launch update passed`);
    }
    await testDeferredUpdate(browser);
    console.log(`${browserType.name()}: deferred update preserves editors, pending writes, reading and resume, and keeps other tabs intact`);
  } finally { await browser.close(); }
}
