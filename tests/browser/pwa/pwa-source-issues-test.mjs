import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from '../../../scripts/pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from '../../../scripts/pwa-preview-server.mjs';

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
  const request = indexedDB.open('crate-reminders', 1);
  request.onupgradeneeded = () => request.transaction.abort();
  request.onerror = () => resolve(null);
  request.onsuccess = () => {
    const database = request.result;
    const tx = database.transaction(['snapshots', 'notes'], 'readonly');
    const read = tx.objectStore('snapshots').get('Reminders');
    const notes = tx.objectStore('notes').getAll(IDBKeyRange.bound(['Reminders'], ['Reminders', []]));
    // Reminders live in per-note records next to the folder's metadata.
    tx.oncomplete = () => { database.close(); resolve(read.result && { ...read.result, reminders: notes.result.flatMap(note => note.reminders ?? []) }); };
    tx.onerror = () => { database.close(); resolve(null); };
  };
}));

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
    await expect(page.locator('.pwa-tab-panel:not([data-leaving])').getByRole('heading', { name: 'No results from available files', exact: true })).toBeVisible();
    for (const tab of ['inbox', 'today', 'projects']) {
      await page.locator(`[data-action="switch-tab"][data-tab="${tab}"]`).click();
      await expect(page.locator('.pwa-tab-panel:not([data-leaving])').getByRole('heading', { name: 'No results from available files', exact: true })).toBeVisible();
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
    await expect(page.locator('.pwa-tab-panel:not([data-leaving])').getByRole('heading', { name: 'No results from available files', exact: true })).toBeVisible();
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
      console.log(`${browserType.name()}: partial source warnings persist offline, healthy rows stay editable, repair clears warnings`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
