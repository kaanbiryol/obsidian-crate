import { checkEarlyLaunchTheme, checkLaunchThemes, checkReadingOpening } from './pwa-launch-theme-checks.mjs';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
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
  await checkEarlyLaunchTheme(browser, assets);
  await checkLaunchThemes(browser, origin);
  await checkReadingOpening(browser, origin);
  const firstLoad = await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
  let releaseFirstLoad;
  const heldFirstLoad = new Promise(resolve => { releaseFirstLoad = resolve; });
  await firstLoad.route('**/reminders/list?*', async route => { await heldFirstLoad; await route.continue(); });
  await firstLoad.goto(`${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&tab=today`);
  await firstLoad.addStyleTag({content:':root{--pwa-safe-area-top:62px;--pwa-safe-area-bottom:34px}'});
  let openingGeometry, openingTitle, openingSettings;
  try {
   await expect(firstLoad.locator('.pwa-reminders-view[data-pwa-opening]')).toBeVisible();
   await expect(firstLoad.getByRole('status',{name:'Loading reminders'})).toBeVisible();
   await expect(firstLoad.locator('.crate-content-loading')).toHaveCount(1);
   const spinner = firstLoad.locator('.crate-content-loading__spinner');
   await expect(spinner).toBeVisible();
   await expect(spinner).toHaveCSS('animation-delay', '0.25s, 0.25s');
   await firstLoad.emulateMedia({ reducedMotion: 'reduce' });
   await expect(spinner).toHaveCSS('animation-name', 'crate-loading-appear');
   await firstLoad.emulateMedia({ reducedMotion: 'no-preference' });
   openingTitle = await firstLoad.locator('h1').elementHandle();
   await expect(firstLoad.locator('.pwa-header-settings-button')).toBeVisible();
   openingSettings = await firstLoad.locator('.pwa-header-settings-button').elementHandle();
   expect(openingSettings, 'settings uses its real icon during loading').not.toBeNull();
   await expect(firstLoad.locator('.pwa-header-settings-button [data-icon="settings"]')).toBeVisible();
   openingGeometry = { title: await openingTitle.boundingBox(), header: await firstLoad.locator('.view-header').boundingBox(), settings: await openingSettings.boundingBox() };
   await mkdir('test-results/startup-loading',{recursive:true});
   await firstLoad.screenshot({path:`test-results/startup-loading/${engine.name()}-opening.png`});
   await firstLoad.emulateMedia({colorScheme:'dark'});
   await firstLoad.screenshot({path:`test-results/startup-loading/${engine.name()}-opening-dark.png`});
  } finally { releaseFirstLoad(); }
  await expect(firstLoad.locator('.pwa-reminders-view:not([data-pwa-opening])')).toBeVisible();
  expect(await openingTitle.evaluate(element => element.isConnected), 'loading must not replace the title').toBe(true);
  expect(await openingSettings.evaluate(element => element.isConnected), 'loading must not replace settings').toBe(true);
  expect(await openingSettings.boundingBox()).toEqual(openingGeometry.settings);
  const loadedTitle = await firstLoad.locator('.view-header-title').boundingBox();
  const loadedHeader = await firstLoad.locator('.view-header').boundingBox();
  expect(Math.abs(loadedTitle.y - openingGeometry.title.y)).toBeLessThan(1);
  expect(Math.abs(loadedTitle.height - openingGeometry.title.height)).toBeLessThan(1);
  expect(Math.abs(loadedHeader.height - openingGeometry.header.height)).toBeLessThan(1);
  await expect(firstLoad.locator('.pwa-navigation-viewport > .pwa-tab-transition > .pwa-tab-panel:not([data-leaving])')).toHaveCSS('opacity', '1');
  await firstLoad.screenshot({path:`test-results/startup-loading/${engine.name()}-loaded-dark.png`});
  await firstLoad.locator('.view-header-overdue').evaluateAll(badges => badges.forEach(badge => badge.remove()));
  const withoutOverdue = await firstLoad.locator('.view-header').boundingBox();
  expect(Math.abs(withoutOverdue.height - loadedHeader.height)).toBeLessThan(1);
  await firstLoad.close();
  const projectPage = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const projectList = Promise.withResolvers();
  const projectApp = Promise.withResolvers();
  await projectPage.route('**/notifications/app.js*', async route => { await projectApp.promise; await route.continue(); });
  await projectPage.route('**/reminders/list?*', async route => { await projectList.promise; await route.continue(); });
  try {
   await projectPage.goto(`${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&project=Work`, { waitUntil: 'commit' });
   const projectTitle = projectPage.locator('.project-detail-title');
   await expect(projectTitle).toHaveText('Work');
   const staticTitle = await projectTitle.boundingBox();
   projectApp.resolve();
   await expect(projectPage.locator('.pwa-reminders-view[data-pwa-opening]')).toBeVisible();
   expect(await projectTitle.boundingBox()).toEqual(staticTitle);
   await expect(projectPage.locator('.pwa-project-layer .crate-content-loading')).toHaveCount(1);
   const title = await projectTitle.elementHandle(), box = await title.boundingBox();
   projectList.resolve();
   await expect(projectPage.locator('.pwa-reminders-view:not([data-pwa-opening])')).toBeVisible();
   await expect(projectPage.locator('.crate-content-loading')).toHaveCount(0);
   expect(await title.evaluate(node => node.isConnected), 'project title stays mounted while its list loads').toBe(true);
   expect(await title.boundingBox()).toEqual(box);
  } finally { projectApp.resolve(); projectList.resolve(); await projectPage.close(); }
   for (const tab of ['today', 'inbox', 'upcoming', 'browse']) {
   const page = await browser.newPage({ serviceWorkers: 'block' });
   await page.goto(`${origin}/notifications?token=${previewEnrollmentToken}&folder=Reminders&tab=${tab}`);
   await expect(page.locator('.pwa-reminders-view:not([data-pwa-opening])')).toBeVisible();
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
   let cachedTitle, cachedSettings;
   try {
    await expect(page.locator('.pwa-reminders-view')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Loading reminders' })).toBeVisible();
    await expect(page.locator('.crate-content-loading')).toHaveCount(1);
    await expect(page.locator('.reminders-empty-state')).toHaveCount(0);
    cachedTitle = await page.locator('.view-header-title').elementHandle();
    cachedSettings = await page.locator('.pwa-header-settings-button').elementHandle();
    await expect(page.locator('.pwa-header-settings-button [data-icon="settings"]')).toBeVisible();
    if (tab === 'inbox') {
     await expect(page.locator('.view-header-meta')).toHaveClass(/is-reserved/);
     const viewport = page.viewportSize();
     await page.setViewportSize({width:390,height:844});
     await mkdir('test-results/startup-loading',{recursive:true});
     await page.screenshot({path:`test-results/startup-loading/${engine.name()}-reminders.png`});
     if (viewport) await page.setViewportSize(viewport);
    }
    expect(await page.evaluate(() => window.startupEmptyMessages)).toEqual([]);
   } finally { release(); }
   await expect(page.locator('.crate-content-loading')).toHaveCount(0);
   expect(await cachedTitle.evaluate(node => node.isConnected), `${tab} title stays mounted during cache refresh`).toBe(true);
   expect(await cachedSettings.evaluate(node => node.isConnected), `${tab} settings stays mounted during cache refresh`).toBe(true);
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
