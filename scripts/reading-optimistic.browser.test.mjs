import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { openLocalRuntime, issueLocalDevice } from './local-server-runtime.mjs';

const operationId = () => `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${randomUUID()}`;
async function pending(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('crate-reading-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = reject;
    });
    const id = JSON.parse(localStorage.getItem('crate-reading-session-v1')).id;
    return new Promise(resolve => {
      const request = db.transaction('values').objectStore('values').get(`pending:${id}`);
      request.onsuccess = () => { db.close(); resolve(request.result ?? []); };
    });
  });
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) test(`Reading optimistic actions ${name}`, { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crate-reading-optimistic-'));
  let runtime, server, browser, held, loseCaptureReply = false;
  const releases = [], requests = [];
  const hold = path => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    held = { path, started: started.resolve, release: release.promise };
    releases.push(release.resolve);
    return { started: started.promise, release: release.resolve };
  };
  try {
    runtime = await openLocalRuntime({ dataDir: dir });
    const vault = await issueLocalDevice(runtime.db, 'Optimistic Reading test');
    server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        if (req.method === 'POST' && ['/reading/update', '/reading/capture'].includes(req.url)) requests.push({ path: req.url, body: body.toString() });
        if (held?.path === req.url) { const gate = held; held = null; gate.started(); await gate.release; }
        const response = await runtime.mf.dispatchFetch(`${origin}${req.url}`, { method: req.method, headers: req.headers,
          ...(['GET', 'HEAD'].includes(req.method) ? {} : { body }) });
        if (req.url === '/reading/capture' && loseCaptureReply) {
          loseCaptureReply = false;
          res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Save acknowledgement interrupted' })); return;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://localhost:${server.address().port}`;
    const api = async (path, body) => {
      const response = await runtime.mf.dispatchFetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200, await response.clone().text()); return response.json();
    };
    await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
    const saved = await api('/reading/capture', { url: 'https://example.invalid/article', title: 'Optimistic article', operationId: operationId() });
    const path = `Reading/${saved.id}.md`;
    const download = await runtime.mf.dispatchFetch(`${origin}/sync/download?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${vault.token}` } });
    const source = await download.text();
    const content = source.slice(0, source.indexOf('\n---\n') + 5).replace(/extraction_status: .*/, 'extraction_status: "ready"') + 'A useful ==article excerpt==.\n\nAnother paragraph to read.';
    const uploaded = await runtime.mf.dispatchFetch(`${origin}/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: {
      Authorization: `Bearer ${vault.token}`, 'X-Crate-Protocol': '11', 'Content-Type': 'text/markdown',
      'X-File-Hash': createHash('sha256').update(content).digest('hex'), 'X-File-Size': String(Buffer.byteLength(content)),
      'X-Crate-Expected-Hash': download.headers.get('X-File-Hash'), 'X-Crate-Upload-Operation': operationId(),
    }, body: content });
    assert.equal(uploaded.status, 200, await uploaded.text());
    const enrollment = await api('/reading/access', { kind: 'reading' });
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(enrollment.url);
    const sync = page.locator('.pwa-reading-root .pwa-tab-panel:not([data-leaving]) .pwa-sync-indicator');
    const toast = page.locator('.pwa-reading-root .toast');
    await expect(sync).toHaveAttribute('data-sync-state', 'synced');
    const saveLink = async (url, title, offline = false) => {
      await page.getByRole('button', { name: 'Save a link', exact: true }).click();
      await page.getByLabel('Link', { exact: true }).fill(url);
      await page.getByLabel('Title (optional)').fill(title);
      await page.getByRole('button', { name: 'Save link', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(toast).toHaveText(offline ? 'Link saved on this device' : 'Link saved');
      await expect(toast).toHaveAttribute('role', 'status');
    };
    const back = async () => {
      await page.getByRole('button', { name: 'Back to reading', exact: true }).click();
      await expect(page.locator('.crate-reading__reader-pane article')).toHaveCount(0);
    };
    const setTags = async (tags, offline = false) => {
      await page.getByRole('button', { name: 'Edit article tags' }).click();
      const dialog = page.getByRole('dialog', { name: 'Article tags' });
      await dialog.getByRole('textbox').fill(tags);
      await dialog.getByRole('button', { name: 'Save tags' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(toast).toHaveText(offline ? 'Tags saved on this device' : 'Tags saved');
    };

    // A failed local write keeps the form and draft, and must never report success.
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.__restoreReadingPut = () => { IDBObjectStore.prototype.put = put; };
      IDBObjectStore.prototype.put = function(value, key) {
        if (typeof key === 'string' && key.startsWith('pending:')) throw new DOMException('Storage full', 'QuotaExceededError');
        return put.call(this, value, key);
      };
    });
    await page.getByRole('button', { name: 'Save a link', exact: true }).click();
    await page.getByLabel('Link', { exact: true }).fill('ftp://example.invalid/invalid');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('HTTP or HTTPS');
    await expect(toast).toHaveCount(0);
    await page.getByLabel('Link', { exact: true }).fill('https://example.invalid/unsaved');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    await expect(toast).toHaveText('Storage full');
    await expect(toast).toHaveAttribute('role', 'alert');
    await expect(page.getByLabel('Link', { exact: true })).toHaveValue('https://example.invalid/unsaved');
    assert.equal((await pending(page)).length, 0);
    await page.evaluate(() => window.__restoreReadingPut());
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Creation is visible and can be opened before the server even receives it.
    const capture = hold('/reading/capture');
    await saveLink('https://example.invalid/queued', 'Queued link');
    await capture.started;
    const row = page.getByRole('button', { name: 'example.invalid Queued link', exact: true });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('heading', { name: 'Queued link', exact: true })).toBeVisible();
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
    capture.release();
    await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
    assert.notEqual(new URL(page.url()).searchParams.get('item'), (await pending(page))[0]?.id);
    await back();
    await expect(row).toHaveCount(1);
    await expect(sync).toHaveAttribute('data-sync-state', 'synced');

    await expect(toast).toHaveCount(0);
    const opening = hold(`/reading/item?id=${saved.id}`);
    await page.getByRole('button', { name: 'example.invalid Optimistic article', exact: true }).click();
    await opening.started;
    await page.getByRole('button', { name: 'Highlights (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await page.getByLabel('Your note').fill('Keep this draft until the article opens');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Open the article before saving highlights.');
    await expect(page.getByLabel('Your note')).toHaveValue('Keep this draft until the article opens');
    await expect(toast).toHaveCount(0);
    assert.equal((await pending(page)).length, 0);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    opening.release();
    await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
    await expect(toast).toHaveCount(0);
    // One delayed request must not block further edits to any article field.
    const update = hold('/reading/update');
    await page.getByRole('button', { name: 'Favorite article', exact: true }).click();
    await update.started;
    await expect(toast).toHaveCount(0); // The star itself confirms the toggle.
    const firstBody = (await pending(page))[0].body;
    await expect(page.locator('.crate-reading__reader-pane').getByRole('button', { name: 'Remove favorite', exact: true })).toBeEnabled();
    await setTags('essays');
    await expect(page.locator('.crate-reading-reader__tags')).toHaveText('#essays');
    await page.locator('.crate-reading__reader-pane').getByRole('button', { name: 'Remove favorite', exact: true }).click();
    await page.getByRole('button', { name: 'Archive article', exact: true }).click();
    await page.getByRole('button', { name: 'Move to inbox', exact: true }).click();
    await page.getByRole('button', { name: 'Highlights (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await page.getByLabel('Your note').fill('First note');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(toast).toHaveText('Note saved');
    await page.getByRole('button', { name: 'Highlights (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Edit note', exact: true }).click();
    await page.getByLabel('Your note').fill('Latest note');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Highlights (1)', exact: true }).click();
    await expect(page.locator('.crate-reading-highlights__note')).toHaveText('Latest note');
    await page.getByRole('button', { name: 'Close highlights', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(toast).toHaveText('Note saved');
    const work = await pending(page);
    assert.equal(work.length, 2); assert.equal(work[0].body, firstBody); assert.equal(work[1].body, undefined);
    update.release();
    await expect.poll(async () => (await pending(page)).length).toBe(0);
    const confirmed = (await api('/reading/list')).items.find(item => item.crate_reading_id === saved.id);
    assert.equal(confirmed.favorite, false); assert.equal(confirmed.reading_status, 'inbox');
    assert.deepEqual(confirmed.tags, ['essays']); assert.equal(confirmed.highlights[0].note, 'Latest note');

    // Offline edits and captures survive hydration and settle after reconnecting.
    await context.setOffline(true);
    await setTags('offline', true);
    await page.getByRole('button', { name: 'Favorite article', exact: true }).click();
    await back();
    await saveLink('https://example.invalid/offline', 'Offline link', true);
    await expect(page.getByRole('button', { name: 'example.invalid Offline link', exact: true })).toBeVisible();
    await expect(sync).toHaveAttribute('data-sync-state', 'offline');
    if (name === 'chromium') {
      await page.reload();
      await expect(page.getByRole('button', { name: 'example.invalid Offline link', exact: true })).toBeVisible();
      await expect(page.locator('.crate-reading__library').getByRole('button', { name: 'Remove favorite', exact: true })).toBeEnabled();
    }
    await context.setOffline(false);
    await expect(sync).toHaveAttribute('data-sync-state', 'synced');
    await expect.poll(async () => (await pending(page)).length).toBe(0);
    await expect(page.getByRole('button', { name: 'example.invalid Offline link', exact: true })).toHaveCount(1);

    // Automatic recovery of a lost response should not flash an error toast.
    loseCaptureReply = true;
    await saveLink('https://example.invalid/lost-toast-reply', 'Retried quietly');
    await expect.poll(async () => (await pending(page)).some(op => op.error)).toBe(true);
    await expect(page.locator('.pwa-reading-root .toast.is-error')).toHaveCount(0);
    await expect(sync).toHaveAttribute('data-sync-state', 'synced', { timeout: 10000 });
    await expect(page.locator('.pwa-reading-root .toast.is-error')).toHaveCount(0);

    // A real compare-and-swap conflict rolls back optimistic dependents, retaining their bytes.
    await page.getByRole('button', { name: 'example.invalid Optimistic article', exact: true }).click();
    await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
    const conflict = hold('/reading/update');
    await setTags('local'); await conflict.started;
    await page.locator('.crate-reading__reader-pane').getByRole('button', { name: 'Remove favorite', exact: true }).click();
    await api('/reading/update', { id: saved.id, changes: { tags: ['remote'] }, before: { tags: ['offline'] }, operationId: operationId() });
    const beforeConflict = requests.length;
    conflict.release();
    await expect(sync).toHaveAttribute('data-sync-state', 'error');
    await expect(toast).toHaveText('Reading changes need attention. Review them in settings.');
    await expect(toast).toHaveAttribute('role', 'alert');
    await expect(page.locator('.crate-reading-reader__tags')).toHaveText('#remote');
    await expect(page.locator('.crate-reading__reader-pane').getByRole('button', { name: 'Remove favorite', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const rejected = await pending(page);
    assert.equal(rejected.length, 2); assert.ok(rejected.every(op => op.review));
    assert.equal(requests.length, beforeConflict, 'Dependent updates must not be sent after a rejected predecessor');
    assert.deepEqual(errors, []);
  } catch (error) {
    await mkdir('test-results/reading', { recursive: true });
    for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
      console.log(await page.locator('body').innerText().catch(() => ''));
      console.log('Pending Reading changes:', await pending(page).catch(() => []));
      await page.screenshot({ path: `test-results/reading/${name}-optimistic-failure.png` }).catch(() => {});
    }
    throw error;
  } finally {
    releases.forEach(release => release());
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
    await runtime?.close(); await rm(dir, { recursive: true, force: true });
  }
});
