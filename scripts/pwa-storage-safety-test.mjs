import { chromium, webkit, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
 for (const type of [chromium, webkit]) {
  const browser = await type.launch();
  try {
   for (const failure of ['token', 'drafts', 'outbox', 'cache']) {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    const cards = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
    await cards.waitFor();
    await page.route('**/auth/session', route => route.fulfill({ status: 503, body: 'Offline revocation' }));
    await page.evaluate(failure => {
     localStorage.setItem('crate-reminder-outbox:logout-test', 'private pending data');
     sessionStorage.setItem('crate-reminder-draft:logout-test', 'private draft');
     const remove = Storage.prototype.removeItem;
     Storage.prototype.removeItem = function(key) {
      if ((failure === 'token' && key === 'crate-reminders-auth-token')
       || (failure === 'drafts' && this === sessionStorage)
       || (failure === 'outbox' && key.startsWith('crate-reminder-outbox:'))) throw new DOMException('Storage denied', 'SecurityError');
      return remove.call(this, key);
     };
     if (failure === 'cache') indexedDB.deleteDatabase = () => { throw new DOMException('Storage denied', 'SecurityError'); };
    }, failure);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(cards).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open Obsidian', exact: true })).toBeVisible();
    await expect(page.getByText('Logged out locally. Remote cleanup could not finish.', { exact: false }).first()).toBeVisible();
    expect(errors).toEqual([]);
    if (failure === 'token') expect(await page.evaluate(() => localStorage.getItem('crate-reminders-auth-token'))).toBeTruthy();
    await page.close();
   }
   for (const granted of [true, false, null]) {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.addInitScript(granted => {
     let persistent = false;
     Object.defineProperty(navigator, 'storage', { configurable: true, value: granted === null ? undefined : {
      persisted: async () => persistent, persist: async () => { persistent = granted; return granted; },
     } });
    }, granted);
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    if (granted === null) await expect(page.getByText('Storage protection is unavailable', { exact: false })).toBeVisible();
    else {
     await page.getByRole('button', { name: 'Protect offline data', exact: true }).click();
     await expect(page.getByText(granted ? 'Persistent storage granted.' : 'Best effort storage.', { exact: false })).toBeVisible();
    }
    await page.close();
   }
   const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
   await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
   await expect(page.locator('[data-action="open-create-modal"]')).toBeVisible();
   expect(await page.locator('meta[name="viewport"]').getAttribute('content')).not.toMatch(/maximum-scale|user-scalable\s*=\s*(no|0)/);
   expect(await page.evaluate(() => [document.documentElement, document.body].every(el => getComputedStyle(el).touchAction === 'auto'))).toBe(true);
   expect(await page.evaluate(() => ['gesturestart', 'gesturechange', 'gestureend'].every(type => {
    const event = new Event(type, { cancelable: true, bubbles: true }); document.dispatchEvent(event); return !event.defaultPrevented;
   }))).toBe(true);
   await page.route('**/reminders/create', route => route.abort('connectionfailed'));
   await page.locator('[data-action="open-create-modal"]').click();
   await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Private offline export');
   await page.locator('[data-action="save-reminder"]').click();
   const downloadPromise = page.waitForEvent('download');
   await page.getByRole('button', { name: 'Export pending changes', exact: true }).click();
   const download = await downloadPromise;
   const raw = await readFile(await download.path(), 'utf8');
   const exported = JSON.parse(raw);
   expect(exported.format).toBe('crate-pending-reminder-changes-v1');
   expect(raw).toContain('Private offline export');
   expect(exported.changes).toHaveLength(1);
   expect(raw).not.toContain(await page.evaluate(() => localStorage.getItem('crate-reminders-auth-token')));
   expect(await page.getByRole('button', { name: 'Export pending changes', exact: true }).count()).toBe(1);
   // Simulate content enlargement without disabling the viewport's real zoom.
   for (const zoom of [2, 4]) {
    await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
    await expect(page.getByRole('button', { name: 'Export pending changes', exact: true })).toBeVisible();
   }
   await page.close();
   console.log(`${type.name()}: failed-storage logout, persistence decisions, pending export and zoom permissions passed`);
  } finally { await browser.close(); }
 }
} finally { await new Promise(resolve => server.close(resolve)); }
