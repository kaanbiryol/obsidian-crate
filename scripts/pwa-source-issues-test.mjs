import { chromium, webkit, expect } from '@playwright/test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

// Real built PWA and native IndexedDB, with controlled list/network responses.
// Worker runtime tests separately exercise actual oversized and duplicate sources.
const assets = await buildPwaPreviewAssets({ assetVersion: 'source-issues-regression' });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const issues = [
  { path: 'Reminders/Large.md', reason: 'Split this note into files of 1 MiB or smaller to use its reminders in the web app. The vault file remains synced.' },
  { path: 'Reminders/Original.md', reason: 'Duplicate reminder ID. Repair the reminder metadata in Obsidian.' },
  { path: 'Reminders/Copy.md', reason: 'Duplicate reminder ID. Repair the reminder metadata in Obsidian.' },
];
const notice = page => page.getByRole('region', { name: 'Incomplete reminder list', exact: true });
const cachedSnapshot = page => page.evaluate(() => new Promise(resolve => {
  const request = indexedDB.open('crate-reminders', 2);
  request.onupgradeneeded = () => request.transaction.abort();
  request.onerror = () => resolve(null);
  request.onsuccess = () => {
    const database = request.result;
    const tx = database.transaction('snapshots', 'readonly');
    const read = tx.objectStore('snapshots').get('Reminders');
    tx.oncomplete = () => { database.close(); resolve(read.result); };
    tx.onerror = () => { database.close(); resolve(null); };
  };
}));

async function verifyLegacyCache(browser) {
  const legacyEtag = '"legacy-cache-with-unknown-completeness"';
  const requests = [];
  // Use real HTTP 304 responses, which WebKit cannot synthesize through route.fulfill.
  const legacyServer = http.createServer((request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === '/legacy-cache-seed') { response.end('<!doctype html><title>Seed legacy cache</title>'); return; }
    if (url.pathname === '/reminders/list') {
      requests.push(request.headers['if-none-match']);
      if (request.headers['if-none-match'] === legacyEtag) { response.writeHead(304, { ETag: legacyEtag }); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ reminders: [], projects: [], issues }));
      return;
    }
    const upstream = http.request(url, { method: request.method, headers: { ...request.headers, host: new URL(origin).host } }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  await new Promise(resolve => legacyServer.listen(0, '127.0.0.1', resolve));
  const legacyOrigin = `http://127.0.0.1:${legacyServer.address().port}`;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    expect((await fetch(`${legacyOrigin}/reminders/list?folderPath=Reminders`, { headers: { 'If-None-Match': legacyEtag } })).status).toBe(304);
    requests.length = 0;
    const page = await context.newPage();
    await page.goto(`${legacyOrigin}/legacy-cache-seed`);
    const operationId = '11111111-1111-4111-8111-111111111111';
    const oldHash = createHash('sha256').update('earlier-browser-session').digest('hex');
    const pendingKey = `crate-reminder-outbox:v1:${oldHash}:Reminders:${operationId}`;
    const draftKey = 'crate-reminder-draft:Reminders:new';
    const preserved = await page.evaluate(async ({ legacyEtag, pendingKey, draftKey, operationId }) => {
      const pending = JSON.stringify({ version: 1, createdAt: 1, change: { operationId, recordId: operationId, kind: 'save',
        path: '/reminders/create', method: 'POST', status: 'uncertain', attempts: 1, retryAt: 0,
        body: JSON.stringify({ operationId, id: operationId, folderPath: 'Reminders', content: 'Keep this unsent creation', project: 'Inbox' }) } });
      const draft = JSON.stringify({ mode: 'create', operationId: '22222222-2222-4222-8222-222222222222', draft: { content: 'Keep this unsent editor text', description: '', project: 'Inbox', defaultProject: 'Inbox', priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } });
      localStorage.setItem(pendingKey, pending);
      sessionStorage.setItem(draftKey, draft);
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('crate-reminders', 2);
        request.onupgradeneeded = () => { request.result.createObjectStore('snapshots', { keyPath: 'folderPath' }); request.result.createObjectStore('freshness', { keyPath: 'folderPath' }); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const tx = database.transaction(['snapshots', 'freshness'], 'readwrite');
          tx.objectStore('snapshots').put({ folderPath: 'Reminders', reminders: [], projects: [], savedAt: Date.now(), etag: legacyEtag });
          tx.objectStore('freshness').put({ folderPath: 'Reminders', savedAt: Date.now() + 60_000, etag: legacyEtag });
          tx.oncomplete = () => { database.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      });
      return { pending, draft };
    }, { legacyEtag, pendingKey, draftKey, operationId });
    await page.goto(`${legacyOrigin}/notifications?folder=Reminders&tab=inbox`);
    await notice(page).waitFor();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(etag => etag === undefined)).toBe(true);
    await expect.poll(async () => (await cachedSnapshot(page))?.issues).toEqual(issues);
    expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBe(preserved.pending);
    expect(await page.evaluate(key => sessionStorage.getItem(key), draftKey)).toBe(preserved.draft);
    await page.locator('[data-action="open-create-modal"]').click();
    await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveText('Keep this unsent editor text');
  } finally {
    await context.close();
    await new Promise(resolve => legacyServer.close(resolve));
  }
}

async function verify(browser) {
  await fetch(`${origin}/preview/reset`, { method: 'POST' });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let mode = 'mixed';
  await page.route('**/reminders/list?*', async route => {
    if (mode === 'offline') return route.fulfill({ status: 503, body: 'Injected offline API' });
    const response = await route.fetch();
    const body = await response.json();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      reminders: mode === 'mixed' ? body.reminders.filter(reminder => reminder.id === 'preview-inbox-1') : [],
      projects: mode === 'mixed' ? ['Inbox'] : [],
      issues: mode === 'repaired' ? [] : issues,
    }) });
  });
  try {
    await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await notice(page).waitFor();
    await expect(notice(page).getByRole('status')).toContainText('3 source files could not be loaded');
    const details = notice(page).getByText('Review affected files (3)', { exact: true });
    await details.focus();
    await page.keyboard.press('Enter');
    for (const issue of issues) {
      await expect(notice(page).getByText(issue.path, { exact: true })).toBeVisible();
      await expect(notice(page).getByText(issue.reason, { exact: true }).first()).toBeVisible();
    }
    await expect(notice(page).getByRole('button', { name: 'Open Obsidian', exact: true })).toBeVisible();
    // Partial source failures do not disable healthy reminder edits.
    await page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true }).click();
    await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Healthy reminder remains editable');
    await page.locator('[data-action="save-reminder"]').click();
    await page.getByRole('group', { name: 'Healthy reminder remains editable. Press Enter to edit reminder.', exact: true }).waitFor();
    await expect.poll(async () => (await cachedSnapshot(page))?.issues).toEqual(issues);
    await expect.poll(async () => (await cachedSnapshot(page))?.reminders[0]?.content).toBe('Healthy reminder remains editable');
    await expect(notice(page)).toBeVisible();
    mode = 'empty';
    await notice(page).getByRole('button', { name: 'Refresh reminders', exact: true }).click();
    await expect(page.getByText('No results from available files', { exact: true })).toBeVisible();
    for (const tab of ['inbox', 'today', 'upcoming', 'projects']) {
      await page.locator(`[data-action="switch-tab"][data-tab="${tab}"]`).click();
      await expect(page.getByText('No results from available files', { exact: true })).toBeVisible();
      await expect(page.getByText(/Your inbox is empty|Nothing due today|Enjoy your free time!/)).toHaveCount(0);
    }
    await expect.poll(async () => (await cachedSnapshot(page))?.reminders.length).toBe(0);
    mode = 'offline';
    await page.reload();
    await notice(page).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(notice(page).getByRole('button', { name: 'Refresh reminders', exact: true })).toBeDisabled();
    await notice(page).getByText('Review affected files (3)', { exact: true }).click();
    for (const issue of issues) await expect(notice(page).getByText(issue.path, { exact: true })).toBeVisible();
    await expect(page.getByText('No results from available files', { exact: true })).toBeVisible();
    mode = 'repaired';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(notice(page)).toHaveCount(0);
    await expect(page.getByText('Your inbox is empty', { exact: true })).toBeVisible();
    await expect.poll(async () => (await cachedSnapshot(page))?.issues).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); }
}

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      await verify(browser);
      await verifyLegacyCache(browser);
      console.log(`${browserType.name()}: partial source warnings persist offline, healthy rows stay editable, repair clears warnings, and legacy cache/ETags force a full response without erasing pending intent`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
