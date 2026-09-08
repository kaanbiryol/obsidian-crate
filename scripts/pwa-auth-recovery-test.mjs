import { readFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';

const assets = await buildPwaPreviewAssets({ assetVersion: 'auth-recovery-regression' });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const authKey = 'crate-reminders-auth-token';
const cardName = 'Check this article. Press Enter to edit reminder.';
const outboxEntries = page => page.evaluate(() => Object.keys(localStorage)
  .filter(key => key.startsWith('crate-reminder-outbox:')).map(key => ({ key, ...JSON.parse(localStorage.getItem(key)) })));

async function harness(browser) {
  await fetch(`${origin}/preview/reset`, { method: 'POST' });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const sessions = new Map([[previewAuthToken, 'Reminders']]);
  const grants = new Map();
  const attempts = [];
  let failure = 'before';
  let beforeExchangeResponse = async () => {};
  await context.addInitScript(({ authKey, token }) => {
    if (localStorage.getItem('recovery-test-initialized')) return;
    localStorage.setItem('recovery-test-initialized', 'yes');
    localStorage.setItem(authKey, token);
  }, { authKey, token: previewAuthToken });
  await context.route('**/notifications/preview-session.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await context.route('**/notifications/reminders-exchange', async route => {
    const { token: grant, previousAuthToken } = route.request().postDataJSON();
    const folder = grants.get(grant);
    if (!folder) return route.fulfill({ status: 401, body: 'Invalid grant' });
    grants.delete(grant);
    const token = `renewed-${grant}`;
    sessions.set(token, folder);
    sessions.delete(previousAuthToken);
    await beforeExchangeResponse();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authToken: token }) });
  });
  await context.route('**/reminders/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === 'GET' ? null : request.postDataJSON();
    const folder = body?.folderPath ?? url.searchParams.get('folderPath');
    const token = request.headers().authorization?.slice('Bearer '.length);
    if (!sessions.has(token)) return route.fulfill({ status: 401, body: 'Session expired' });
    if (sessions.get(token) !== folder) return route.fulfill({ status: 403, body: 'Wrong reminders folder' });
    if (request.method() === 'GET' && folder !== 'Reminders') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ reminders: [], projects: [] }) });
    }
    const headers = { ...request.headers(), authorization: `Bearer ${previewAuthToken}` };
    if (request.method() !== 'GET') {
      attempts.push({ path: url.pathname, body: request.postData() });
      if (failure === 'before') return route.fulfill({ status: 503, body: 'Injected failure before commit' });
      if (failure === 'after') {
        const committed = await route.fetch({ headers });
        expect(committed.ok()).toBe(true);
        return route.fulfill({ status: 503, body: 'Injected response loss after commit' });
      }
    }
    return route.continue({ headers });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
  await page.getByRole('group', { name: cardName, exact: true }).waitFor();
  const renew = async folder => {
    const grant = `grant-${grants.size}-${sessions.size}-${Date.now()}`;
    grants.set(grant, folder);
    await page.goto(`${origin}/notifications?browserToken=${grant}&folder=${encodeURIComponent(folder)}&tab=inbox`);
    await page.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
    return `renewed-${grant}`;
  };
  const save = async (kind, title) => {
    if (kind === 'create') await page.locator('[data-action="open-create-modal"]').click();
    else await page.getByRole('group', { name: cardName, exact: true }).click();
    await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill(title);
    await page.locator('[data-action="save-reminder"]').click();
    await page.getByRole('region', { name: `Couldn’t sync: ${title}`, exact: true }).waitFor();
    expect(await outboxEntries(page)).toHaveLength(1);
  };
  return { context, page, sessions, attempts, renew, save, setFailure: value => { failure = value; }, beforeExchangeResponse: callback => { beforeExchangeResponse = callback; } };
}

async function verifyRecovery(browser, kind, failure) {
  const state = await harness(browser);
  const { context, page, sessions, attempts, renew, save, setFailure } = state;
  try {
    setFailure(failure);
    const title = `Retain ${kind} through ${failure}`;
    await save(kind, title);
    const [original] = await outboxEntries(page);
    if (failure === 'before') {
      sessions.delete(previewAuthToken);
      await page.reload();
      await page.getByRole('button', { name: 'Open Obsidian', exact: true }).waitFor();
      expect(await page.evaluate(key => localStorage.getItem(key), authKey)).toBe(null);
      expect((await outboxEntries(page))[0].change.body).toBe(original.change.body);
      expect(await page.getByText(title, { exact: true }).count()).toBe(0);
    }
    setFailure('none');
    const renewedToken = await renew('Reminders');
    const recovery = page.getByRole('region', { name: 'Saved changes from an earlier session', exact: true });
    await recovery.waitFor();
    const attemptsBeforeReview = attempts.length;
    await page.waitForTimeout(150);
    expect(attempts).toHaveLength(attemptsBeforeReview);
    expect(await page.evaluate(key => localStorage.getItem(key), authKey)).toBe(renewedToken);
    const [download] = await Promise.all([page.waitForEvent('download'), recovery.getByRole('button', { name: 'Export saved changes' }).click()]);
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    expect(exported.folderPath).toBe('Reminders');
    expect(exported.changes[0].body).toBe(original.change.body);
    expect(JSON.stringify(exported)).not.toContain(renewedToken);
    await recovery.getByRole('button', { name: 'Resume saved changes' }).click();
    await expect.poll(async () => (await outboxEntries(page)).length).toBe(0);
    await expect(page.getByRole('group', { name: `${title}. Press Enter to edit reminder.`, exact: true })).toBeVisible();
    expect(new Set(attempts.map(attempt => attempt.body)).size).toBe(1);
    const remote = await (await page.request.get(`${origin}/reminders/list?folderPath=Reminders`, { headers: { Authorization: `Bearer ${previewAuthToken}` } })).json();
    expect(remote.reminders.filter(reminder => reminder.id === original.change.recordId)).toHaveLength(1);
  } finally { await context.close(); }
}

async function verifyScopeAndLogout(browser, delayPeerEvents = false) {
  const { context, page, renew, save, setFailure } = await harness(browser);
  try {
    const title = 'Recover only in my original folder';
    await save('create', title);
    await renew('Private');
    expect(await page.getByRole('region', { name: 'Saved changes from an earlier session', exact: true }).count()).toBe(0);
    expect(await page.getByText(title, { exact: true }).count()).toBe(0);
    expect(await outboxEntries(page)).toHaveLength(1);
    await renew('Reminders');
    await page.getByRole('region', { name: 'Saved changes from an earlier session', exact: true }).waitFor();
    // Leave retained changes unresumed. Explicit logout must erase these too.
    const other = await context.newPage();
    if (delayPeerEvents) await other.addInitScript(() => {
      window.deferredStorageEvents = [];
      window.deferStorageEvents = false;
      window.addEventListener('storage', event => {
        if (!window.deferStorageEvents) return;
        event.stopImmediatePropagation();
        window.deferredStorageEvents.push({ key: event.key, oldValue: event.oldValue, newValue: event.newValue });
      }, { capture: true });
    });
    await other.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await other.getByRole('group', { name: cardName, exact: true }).click();
    await other.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Unsaved draft in another tab');
    expect(await other.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('crate-reminder-draft:')))).toBe(true);
    if (delayPeerEvents) await other.evaluate(() => { window.deferStorageEvents = true; });
    setFailure('none');
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect.poll(() => other.evaluate(key => localStorage.getItem(key), authKey)).toBe(null);
    if (delayPeerEvents) {
      await renew('Private');
      await other.evaluate(() => {
        window.deferStorageEvents = false;
        for (const event of window.deferredStorageEvents) window.dispatchEvent(new StorageEvent('storage', { ...event, storageArea: localStorage }));
      });
    }
    await expect.poll(() => other.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('crate-reminder-draft:')).length)).toBe(0);
    expect(await outboxEntries(other)).toEqual([]);
    await expect(other.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveCount(0);
  } finally { await context.close(); }
}

async function verifyRenewalWithExpiringPeer(browser) {
  const state = await harness(browser);
  const { context, page, renew, save } = state;
  try {
    await save('create', 'Keep intent during peer expiry');
    const peer = await context.newPage();
    await peer.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
    await peer.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
    state.beforeExchangeResponse(async () => {
      await peer.clock.setFixedTime(new Date(Date.now() + 60_000));
      await peer.evaluate(() => window.dispatchEvent(new Event('pageshow')));
      await peer.getByRole('button', { name: 'Open Obsidian', exact: true }).waitFor();
      expect(await peer.evaluate(key => localStorage.getItem(key), authKey)).toBe(null);
    });
    const token = await renew('Reminders');
    await page.getByRole('region', { name: 'Saved changes from an earlier session', exact: true }).waitFor();
    expect(await page.evaluate(key => localStorage.getItem(key), authKey)).toBe(token);
    expect(await outboxEntries(page)).toHaveLength(1);
  } finally { await context.close(); }
}

async function verifyUnsavedDraft(browser) {
  const { context, page, sessions, renew } = await harness(browser);
  try {
    await page.getByRole('group', { name: cardName, exact: true }).click();
    await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Keep text that has not been submitted');
    // Simulate a draft written by the previous PWA format before upgrading.
    await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(key => key.startsWith('crate-reminder-draft:'));
      const raw = sessionStorage.getItem(key);
      const modal = JSON.parse(raw);
      sessionStorage.setItem(`crate-reminder-draft:${modal.reminderId ?? 'new'}`, raw);
      sessionStorage.removeItem(key);
    });
    sessions.delete(previewAuthToken);
    await page.reload();
    await page.getByRole('button', { name: 'Open Obsidian', exact: true }).waitFor();
    await renew('Reminders');
    await page.getByRole('group', { name: cardName, exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveText('Keep text that has not been submitted');
  } finally { await context.close(); }
}

try {
  for (const browserType of [chromium, webkit]) {
    const browser = await browserType.launch();
    try {
      for (const kind of ['create', 'update']) {
        for (const failure of ['before', 'after']) await verifyRecovery(browser, kind, failure);
      }
      await verifyScopeAndLogout(browser);
      await verifyScopeAndLogout(browser, true);
      await verifyUnsavedDraft(browser);
      await verifyRenewalWithExpiringPeer(browser);
      console.log(`${browserType.name()}: expired auth and same-folder renewal retain creates, updates and drafts; explicit review retries identical commands, lost responses deduplicate, other folders stay isolated, and logout clears every tab`);
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
