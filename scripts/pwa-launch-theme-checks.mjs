import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { previewEnrollmentToken } from './pwa-preview-fixtures.mjs';

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
   const sample = () => {
    if (document.querySelector('#app')) {
     const selectors = ['html', 'body', '#app', '.pwa-launch-splash', '.crate-feature-shell', '.pwa-reminders-opening', '.reminders-shadow-root'];
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
   app.resolve();
   await expect(page.locator('.pwa-reminders-opening')).toBeVisible();
   await expect(page.locator('.pwa-reminders-opening')).toHaveCSS('background-color', expected);
   list.resolve();
   await expect(page.locator('.pwa-reminders-view')).toBeVisible();
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   const frames = await page.evaluate(() => window.launchFrames);
   assert.ok(frames.length > 0);
   assert.deepEqual(frames.flat().filter(surface => surface.background !== expected || surface.image !== 'none'), [], `${system} system / ${saved} preference: launch surface changed`);
   assert.deepEqual(errors, []);
  } finally { app.resolve(); list.resolve(); await page.close(); }
 }
}
