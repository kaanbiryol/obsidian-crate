import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { openWorkerBrowserFixture } from '../support/worker-browser-fixture.mjs';

// Built PWA against the real local Worker, with native IndexedDB, Web Locks and
// operation receipts. Two tabs share one durable Reading queue. The first sender
// loses a committed reply while the other tab waits for the drain lock, then sends
// the rest of the queue; the lost capture retries with its exact bytes.
const DRAIN_LOCK = 'crate-reading-drain-v1';
const urls = ['https://first.example.invalid/one', 'https://second.example.invalid/two', 'https://third.example.invalid/three'];
// Tab that queues each capture while offline.
const queuedBy = [0, 1, 0];
const syncIndicator = page => page.locator('.pwa-reading-root .pwa-tab-panel:not([data-leaving]) .pwa-sync-indicator');
const libraryIds = page => page.locator('.pwa-reading-root .pwa-tab-panel:not([data-leaving]) .crate-reading__open[data-reading-id]')
	.evaluateAll(nodes => nodes.map(node => node.dataset.readingId).sort());
const requestBody = dispatch => JSON.parse(dispatch.body);

for (const browserType of [chromium, webkit]) {
	const fixture = await openWorkerBrowserFixture({ deviceName: 'Reading multi-tab test' });
	const browser = await browserType.launch();
	try {
		await verifySharedQueue(browser, fixture);
		console.log(`${browserType.name()}: two Reading tabs drained one queue, committed each operation once and converged`);
	} finally {
		await browser.close();
		await fixture.close();
	}
}

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

async function ready(page) {
	await expect(page.getByRole('searchbox', { name: 'Search reading' })).toBeVisible();
	await expect(syncIndicator(page)).toHaveAttribute('data-sync-state', 'synced');
}

async function saveOffline(page, url) {
	await page.getByRole('button', { name: 'Save a link', exact: true }).click();
	await page.getByLabel('Link', { exact: true }).fill(url);
	await page.getByRole('button', { name: 'Save link', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.locator('.toast')).toHaveText('Link saved on this device');
}

async function verifySharedQueue(browser, { api, origin, runtime }) {
	await api('/reading/policy', { enabled: true, folderPath: 'Reading', revision: null });
	const enrollment = await api('/reading/access', { kind: 'reading' });
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
	const errors = [];
	const held = Promise.withResolvers(), release = Promise.withResolvers();
	try {
		const pages = [await context.newPage(), await context.newPage()];
		const dispatches = [];
		await context.route('**/reading/capture', async route => {
			const request = route.request();
			const dispatch = { page: pages.indexOf(request.frame().page()), body: request.postData() };
			dispatches.push(dispatch);
			if (dispatch === dispatches[0]) { held.resolve(); await release.promise; }
			const response = await route.fetch();
			dispatch.status = response.status();
			dispatch.response = await response.json();
			// The server commits the first capture, but its sender never sees the reply.
			if (dispatch === dispatches[0]) return route.fulfill({ status: 503, json: { error: 'Save acknowledgement interrupted' } });
			return route.fulfill({ response });
		});
		for (const page of pages) {
			page.setDefaultTimeout(15_000);
			page.on('pageerror', error => errors.push(error.message));
		}
		await pages[0].goto(enrollment.url);
		await ready(pages[0]);
		await pages[1].goto(`${origin}/notifications?section=reading`);
		await ready(pages[1]);

		await context.setOffline(true);
		for (const [index, url] of urls.entries()) await saveOffline(pages[queuedBy[index]], url);
		const queued = await pending(pages[1]);
		assert.deepEqual(queued.map(op => op.intent.url), urls, 'Both tabs append to one durable queue');
		assert.ok(queued.every(op => op.body === undefined), 'Offline captures have no dispatch bytes yet');

		await context.setOffline(false);
		await Promise.all(pages.map(page => page.evaluate(() => window.dispatchEvent(new Event('online')))));
		await held.promise;
		// One tab sends while the other waits on the same drain lock.
		await expect.poll(() => pages[0].evaluate(async name => {
			const { held, pending } = await navigator.locks.query();
			return { held: held.filter(lock => lock.name === name).length, waiting: pending.some(lock => lock.name === name) };
		}, DRAIN_LOCK)).toEqual({ held: 1, waiting: true });
		release.resolve();

		// The automatic retry resends the lost capture after its saved deadline.
		await expect.poll(async () => (await pending(pages[0])).length, { timeout: 20_000 }).toBe(0);
		for (const page of pages) await expect(syncIndicator(page)).toHaveAttribute('data-sync-state', 'synced');

		const [lost] = dispatches;
		assert.equal(requestBody(lost).url, urls[0]);
		assert.equal(dispatches.length, 4, 'Only the lost capture is sent twice');
		const operationIds = [...new Set(dispatches.map(dispatch => requestBody(dispatch).operationId))];
		assert.equal(operationIds.length, urls.length, 'Each queued capture keeps one operation ID across tabs');
		const retried = dispatches.filter(dispatch => dispatch.body === lost.body);
		assert.equal(retried.length, 2, 'The retry reuses the exact request bytes');
		assert.deepEqual(retried[1].response, lost.response, 'The retry replays the committed receipt');
		assert.ok(dispatches.every(dispatch => dispatch.status === 200));
		// The waiting tab drained the remainder, including a capture queued by its peer.
		const other = 1 - lost.page;
		assert.deepEqual(dispatches.slice(1, 3).map(dispatch => [dispatch.page, requestBody(dispatch).url]), [[other, urls[1]], [other, urls[2]]]);
		assert.ok(dispatches.some((dispatch, index) => index < 3 && dispatch.page !== queuedBy[urls.indexOf(requestBody(dispatch).url)]));

		const { results } = await runtime.db.prepare('SELECT operation_id FROM reading_operations').all();
		assert.deepEqual(results.map(row => row.operation_id).sort(), [...operationIds].sort(), 'Each operation ID has exactly one committed receipt');
		const { items } = await api('/reading/list');
		assert.deepEqual(items.map(item => item.source_url).sort(), [...urls].sort());
		const serverIds = items.map(item => item.crate_reading_id).sort();
		for (const page of pages) await expect.poll(() => libraryIds(page)).toEqual(serverIds);
		assert.deepEqual(errors, []);
	} finally {
		release.resolve();
		await context.unrouteAll({ behavior: 'ignoreErrors' });
		await context.close();
	}
}
