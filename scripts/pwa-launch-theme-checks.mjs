import assert from 'node:assert/strict';
import http from 'node:http';
import { expect } from '@playwright/test';
import { previewEnrollmentToken } from './pwa-preview-fixtures.mjs';

export async function dockAppearance(page) {
 return page.locator('.pwa-dock').evaluate(dock => {
  const rect = element => {
   const box = element.getBoundingClientRect();
   return [box.x, box.y, box.width, box.height].map(value => Math.round(value * 100) / 100);
  };
  const shapes = svg => Array.from(svg.children).map(node => [node.tagName, Array.from(node.attributes).map(attr => [attr.name, attr.value]).sort()]);
  return Array.from(dock.querySelectorAll('.pwa-dock__bar, .pwa-dock__indicator, .pwa-dock__add, svg')).map(element => ({
   rect: rect(element), color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity,
   ...(element.tagName.toLowerCase() === 'svg' ? { shapes: shapes(element) } : {}),
  }));
 });
}

/** Inspect every web-painted launch frame while JavaScript and data arrive separately. */
export async function checkLaunchThemes(browser, origin) {
 for (const system of ['light', 'dark']) for (const saved of ['system', system === 'light' ? 'dark' : 'light']) {
  const scheme = saved === 'system' ? system : saved;
  const expected = scheme === 'light' ? 'rgb(247, 247, 248)' : 'rgb(13, 13, 15)';
  const page = await browser.newPage({ viewport: { width: 393, height: 852 }, colorScheme: system, serviceWorkers: 'block' });
  const app = Promise.withResolvers(), list = Promise.withResolvers();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ saved }) => {
   localStorage.setItem('crate-reminders-theme', saved);
   window.launchFrames = [];
   window.dockFrames = [];
   window.headerFrames = [];
   const sample = () => {
    if (document.querySelector('#app')) {
     const title = document.querySelector('.view-header-title');
     if (title) {
      window.firstHeaderTitle ??= title;
      const chain = [];
      for (let node = title; node; node = node.parentElement) chain.push(getComputedStyle(node));
      window.headerFrames.push({ sameNode: title === window.firstHeaderTitle,
       visible: chain.every(style => style.opacity === '1' && style.visibility === 'visible'),
       settings: Boolean(document.querySelector('.pwa-header-settings-button svg')),
      });
     }
     const dock = document.querySelector('.pwa-dock');
     window.dockFrames.push({
      visible: Boolean(dock && dock.getBoundingClientRect().height > 0),
      icons: dock?.querySelectorAll('svg').length ?? 0,
      placeholders: dock?.querySelectorAll('.pwa-mode-opening__shape').length ?? 0,
      faded: dock ? Array.from(dock.querySelectorAll('svg')).some(icon => getComputedStyle(icon).opacity !== '1') : false,
     });
     const selectors = ['html', 'body', '#app', '.pwa-launch-splash', '.crate-feature-shell', '.reminders-shadow-root'];
     window.launchFrames.push(selectors.flatMap(selector => {
      const element = document.querySelector(selector);
      return element ? [{ selector, background: getComputedStyle(element).backgroundColor, image: getComputedStyle(element).backgroundImage }] : [];
     }));
    }
    requestAnimationFrame(sample);
   };
   requestAnimationFrame(sample);
  }, { saved });
  // Use the same nonce restriction as the Worker; other inline scripts stay blocked.
  await page.route('**/notifications?*', async route => {
   const response = await route.fetch(), body = await response.text();
   const nonce = /<script nonce="([^"]+)"/.exec(body)?.[1];
   assert.ok(nonce);
   await route.fulfill({ response, body, headers: { ...response.headers(), 'Content-Security-Policy': `script-src 'self' 'nonce-${nonce}'` } });
  });
  await page.route('**/notifications/theme-bootstrap.js*', route => route.abort());
  await page.route('**/notifications/app.js*', async route => { await app.promise; await route.continue(); });
  await page.route('**/reminders/list?*', async route => { await list.promise; await route.continue(); });
  try {
   await page.goto(`${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&tab=inbox`, { waitUntil: 'commit' });
   await expect(page.locator('.pwa-launch-splash')).toBeVisible();
   await expect(page.locator('html')).toHaveAttribute('data-pwa-color-scheme', scheme);
   await expect(page.locator('.pwa-launch-splash')).toHaveCSS('background-color', expected);
   await expect(page.locator('.pwa-dock svg')).toHaveCount(6);
   const launchDock = await dockAppearance(page);
   app.resolve();
   await expect(page.locator('.pwa-reminders-view[data-pwa-opening]')).toBeVisible();
   await expect(page.locator('.reminders-shadow-root')).toHaveCSS('background-color', expected);
   expect(await dockAppearance(page)).toEqual(launchDock);
   const title = await page.locator('.view-header-title').elementHandle();
   const settings = await page.locator('.pwa-header-settings-button').elementHandle();
   await expect(page.locator('.pwa-header-settings-button [data-icon="settings"]')).toBeVisible();
   list.resolve();
   await expect(page.locator('.pwa-reminders-view:not([data-pwa-opening])')).toBeVisible();
   expect(await title.evaluate(node => node.isConnected)).toBe(true);
   expect(await settings.evaluate(node => node.isConnected)).toBe(true);
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   expect(await dockAppearance(page)).toEqual(launchDock);
   expect(await page.evaluate(() => window.headerFrames.filter(frame => !frame.sameNode || !frame.visible || !frame.settings))).toEqual([]);
   const dockFrames = await page.evaluate(() => window.dockFrames);
   expect(dockFrames.filter(frame => !frame.visible || frame.icons !== 6 || frame.placeholders || frame.faded)).toEqual([]);
   const frames = await page.evaluate(() => window.launchFrames);
   assert.ok(frames.length > 0);
   assert.deepEqual(frames.flat().filter(surface => surface.background !== expected || surface.image !== 'none'), [], `${system} system / ${saved} preference: launch surface changed`);
   assert.deepEqual(errors, []);
  } finally { app.resolve(); list.resolve(); await page.close(); }
 }
}

/** A slow document can paint native chrome before the body or app exists. */
export async function checkEarlyLaunchTheme(browser, assets) {
 for (const system of ['light', 'dark']) for (const saved of ['system', system === 'light' ? 'dark' : 'light']) {
  const scheme = saved === 'system' ? system : saved;
  const expected = scheme === 'light' ? 'rgb(247, 247, 248)' : 'rgb(13, 13, 15)';
  const tail = Promise.withResolvers();
  const html = assets.createPwaHtml('http://localhost/notifications', 'launch-test');
  const boundary = '<meta name="application-name" content="Crate">';
  const split = html.indexOf(boundary) + boundary.length;
  assert.ok(split >= boundary.length);
  const server = http.createServer(async (_req, response) => {
   response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self' 'nonce-launch-test'" });
   response.write(html.slice(0, split));
   await tail.promise;
   response.end(html.slice(split));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage({ colorScheme: system, viewport: { width: 393, height: 852 } });
  try {
   await page.addInitScript(saved => localStorage.setItem('crate-reminders-theme', saved), saved);
   await page.goto(`http://127.0.0.1:${server.address().port}/notifications`, { waitUntil: 'commit' });
   await page.waitForFunction(() => document.querySelector('meta[name="application-name"]'));
   await expect(page.locator('#app')).toHaveCount(0);
   await expect(page.locator('html')).toHaveCSS('background-color', expected);
   await expect(page.locator('html')).toHaveCSS('color-scheme', scheme);
   await expect(page.locator('#pwa-theme-color')).toHaveAttribute('content', scheme === 'light' ? '#f7f7f8' : '#0d0d0f');
  } finally {
   await page.close();
   tail.resolve();
   await new Promise(resolve => server.close(resolve));
  }
 }
}
