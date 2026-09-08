import { createHash } from 'node:crypto';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';

const assets = await buildPwaPreviewAssets({ assetVersion: 'cache-recovery-regression' });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const cacheNotice = page => page.getByRole('region', { name: 'Offline copy unavailable', exact: true });
const operationId = '11111111-1111-4111-8111-111111111111';
const pendingKey = `crate-reminder-outbox:v1:${createHash('sha256').update('old-session').digest('hex')}:Reminders:${operationId}`;
const sessionScope = createHash('sha256').update(previewAuthToken).digest('hex');

async function verify(browser) {
	const context = await browser.newContext({ serviceWorkers: 'block' });
	const page = await context.newPage();
	const oldTab = await context.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	let available = true;
	const reads = [];
	await context.route('**/cache-seed', route => route.fulfill({ body: '<!doctype html><title>Seed</title>', contentType: 'text/html' }));
	await page.route('**/reminders/list?*', route => {
		reads.push(route.request().headers()['if-none-match']);
		return available ? route.continue() : route.fulfill({ status: 503, body: 'Injected disconnected server' });
	});
	try {
		await oldTab.goto(`${origin}/cache-seed`);
		await oldTab.evaluate(() => new Promise((resolve, reject) => {
			const request = indexedDB.open('crate-reminders', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: 'folderPath' });
			request.onsuccess = () => {
				// Retain a real old connection that ignores versionchange.
				window.oldCache = request.result; resolve();
			};
			request.onerror = () => reject(request.error);
		}));
		await page.goto(`${origin}/cache-seed`);
		const saved = await page.evaluate(({ pendingKey, operationId }) => {
			const pending = JSON.stringify({ version: 1, createdAt: 1, change: { operationId, recordId: operationId,
				kind: 'save', path: '/reminders/create', method: 'POST', status: 'uncertain', attempts: 1, retryAt: 0,
				body: JSON.stringify({ operationId, id: operationId, folderPath: 'Reminders', content: 'Preserved pending creation', project: 'Inbox' }) } });
			const draft = JSON.stringify({ mode: 'create', draft: { content: 'Preserved draft', description: '', project: 'Inbox', defaultProject: 'Inbox',
				priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } });
			localStorage.setItem(pendingKey, pending); sessionStorage.setItem('crate-reminder-draft:Reminders:new', draft);
			return { pending, draft };
		}, { pendingKey, operationId });
		await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		await page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true }).waitFor();
		await expect(cacheNotice(page)).toContainText('Close other Crate tabs');
		// Let every queued open reach its bounded fallback while the legacy
		// connection remains held; releasing it must not finish abandoned work.
		await page.waitForTimeout(3_250);
		await oldTab.evaluate(() => window.oldCache.close());
		const rebuild = cacheNotice(page).getByRole('button', { name: 'Rebuild offline copy', exact: true });
		await rebuild.focus(); await page.keyboard.press('Enter');
		await expect(cacheNotice(page)).toHaveCount(0);
		const rawCache = () => page.evaluate(() => new Promise((resolve, reject) => {
			const request = indexedDB.open('crate-reminders', 2);
			request.onsuccess = () => {
				const db = request.result; const tx = db.transaction('snapshots', 'readonly');
				const read = tx.objectStore('snapshots').get('Reminders');
				tx.oncomplete = () => { db.close(); resolve(read.result); };
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		}));
		await expect.poll(async () => (await rawCache())?.sessionScope).toBe(sessionScope);
		available = false;
		await page.evaluate(sessionScope => new Promise((resolve, reject) => {
			const request = indexedDB.open('crate-reminders', 2);
			request.onsuccess = () => {
				const db = request.result; const tx = db.transaction('snapshots', 'readwrite');
				tx.objectStore('snapshots').put({ folderPath: 'Reminders', reminders: [null], projects: ['Inbox'], savedAt: Date.now(),
					etag: 'damaged-etag', issues: [], sessionScope });
				tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		}), sessionScope);
		reads.length = 0;
		await page.reload();
		await expect(cacheNotice(page)).toContainText('saved copy is damaged');
		await page.evaluate(() => window.dispatchEvent(new Event('offline')));
		await expect(cacheNotice(page).getByRole('button')).toBeDisabled();
		expect((await rawCache()).reminders).toEqual([null]);
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every(etag => etag === undefined)).toBe(true);
		available = true;
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect(cacheNotice(page)).toHaveCount(0);
		await expect.poll(async () => (await rawCache())?.reminders[0]?.id).toBeTruthy();
		expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBe(saved.pending);
		expect(await page.evaluate(() => sessionStorage.getItem('crate-reminder-draft:Reminders:new'))).toBe(saved.draft);
		await page.locator('[data-action="open-create-modal"]').click();
		await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveText('Preserved draft');
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			await verify(browser);
			console.log(`${browserType.name()}: built PWA survives blocked startup and damaged offline data; keyboard rebuild and reconnect preserve pending commands and drafts`);
		} finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
