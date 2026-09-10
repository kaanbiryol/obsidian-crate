import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewEnrollmentToken } from './pwa-preview-fixtures.mjs';

const assets = await buildPwaPreviewAssets({ assetVersion: 'startup-empty-regression' });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
 for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
   for (const tab of ['today', 'inbox', 'upcoming', 'browse']) {
   const page = await browser.newPage({ serviceWorkers: 'block' });
   await page.goto(`${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&tab=${tab}`);
   await expect(page.locator('.pwa-reminders-view')).toBeVisible();
   await expect(page.locator('.reminders-empty-state')).toHaveCount(0);
   // Keep a valid but stale empty snapshot while the live list still has content.
   await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
     const request = indexedDB.open('crate-reminders', 2);
     request.onerror = () => reject(request.error);
     request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      const read = store.get('Reminders');
      read.onsuccess = () => store.put({ ...read.result, reminders: [], projects: [] });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
     };
    });
   });
   let release;
   const blocked = new Promise(resolve => { release = resolve; });
   await page.route('**/reminders/list?*', async route => {
    await blocked;
    await route.continue();
   });
   await page.addInitScript(() => {
    window.startupEmptyMessages = [];
    new MutationObserver(() => {
     for (const title of document.querySelectorAll('.reminders-empty-state-title')) {
      if (title.textContent !== 'Loading reminders…') window.startupEmptyMessages.push(title.textContent);
     }
    }).observe(document, { childList: true, subtree: true, characterData: true });
   });
   await page.reload();
   try {
    await expect(page.locator('.pwa-reminders-view')).toBeVisible();
    await expect(page.locator('.reminders-empty-state-title')).toHaveText('Loading reminders…');
    expect(await page.evaluate(() => window.startupEmptyMessages)).toEqual([]);
   } finally { release(); }
   await expect(page.locator('.reminders-empty-state')).toHaveCount(0);
   expect(await page.evaluate(() => window.startupEmptyMessages)).toEqual([]);
   await page.unroute('**/reminders/list?*');
   await page.route('**/reminders/list?*', route => route.fulfill({
    json: { reminders: [], projects: [], issues: [] },
   }));
   await page.reload();
   const emptyTitles = { today: 'Nothing due today', inbox: 'Your inbox is empty', upcoming: 'No upcoming reminders', browse: 'No projects yet' };
   await expect(page.locator('.reminders-empty-state-title')).toHaveText(emptyTitles[tab]);
   await page.close();
   console.log(`${engine.name()}: ${tab} waits for refresh before claiming a cached list is empty`);
   }
  } finally { await browser.close(); }
 }
} finally { await new Promise(resolve => server.close(resolve)); }
