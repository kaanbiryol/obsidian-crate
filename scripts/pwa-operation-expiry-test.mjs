import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';

const assets = await buildPwaPreviewAssets({ assetVersion: 'operation-expiry-regression' });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const expiredId = 'e1_00000001_11111111-1111-4111-8111-111111111111';
const key = `crate-reminder-outbox:v1:${createHash('sha256').update(previewAuthToken).digest('hex')}:Reminders:${expiredId}`;
const notice = page => page.getByRole('region', { name: 'Change needs review: Reminder', exact: true });

async function verify(browser) {
	await fetch(`${origin}/preview/reset`, { method: 'POST' });
	const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
	const page = await context.newPage(); const other = await context.newPage();
	const errors = []; const attempted = []; const deliveries = [];
	const requestDetails = new Map();
	context.on('request', request => {
		if (!request.url().endsWith('/reminders/create')) return;
		const body = request.postDataJSON();
		const detail = { tab: request.frame().page() === page ? 'main' : 'other',
			operationId: body.operationId, recordId: body.id,
			bodyHash: createHash('sha256').update(request.postData() ?? '').digest('hex') };
		requestDetails.set(request, detail); deliveries.push(detail);
	});
	context.on('response', response => { const detail = requestDetails.get(response.request()); if (detail) detail.status = response.status(); });
	context.on('requestfailed', request => { const detail = requestDetails.get(request); if (detail) detail.failure = request.failure()?.errorText; });
	for (const tab of [page, other]) tab.on('pageerror', error => errors.push(error.message));
	const storageTrace = [];
	if (process.env.CRATE_EXPIRY_TRACE === '1') {
		await context.exposeBinding('traceOutbox', ({ page: tab }, event) => storageTrace.push({ tab: tab === page ? 'main' : 'other', ...event }));
		await context.addInitScript(() => {
			const details = (key, raw) => {
				if (!key?.startsWith('crate-reminder-outbox:')) return null;
				const change = raw ? JSON.parse(raw).change : null;
				return { operationId: key.slice(key.lastIndexOf(':') + 1), status: change?.status, attempts: change?.attempts, error: change?.error };
			};
			for (const method of ['setItem', 'removeItem']) {
				const original = Storage.prototype[method];
				Storage.prototype[method] = function (key, value) {
					const result = original.apply(this, arguments);
					const detail = details(key, value);
					if (detail) void window.traceOutbox({ event: method, ...detail });
					return result;
				};
			}
			window.addEventListener('storage', event => {
				const detail = details(event.key, event.newValue);
				if (detail) void window.traceOutbox({ event: 'received-storage', ...detail });
			});
		});
	}
	await page.clock.install({ time: new Date('2099-01-01T12:00:00Z') });
	await context.route('**/expiry-seed', route => route.fulfill({ body: '<!doctype html><title>Seed</title>', contentType: 'text/html' }));
	await context.route('**/reminders/create', async route => {
		const body = route.request().postDataJSON(); attempted.push(body);
		if (body.operationId === expiredId) return route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ code: 'operation_expired', error: 'Export and compare your current reminders before restoring missing work.' }) });
		return route.continue();
	});
	try {
		await page.goto(`${origin}/expiry-seed`);
		const body = await page.evaluate(({ key, expiredId }) => {
			const body = JSON.stringify({ operationId: expiredId, id: expiredId, folderPath: 'Reminders', content: 'Preserve expired text 🗒️', description: '<script>window.injected=true</script>', project: 'Inbox', priority: 4 }, null, 2);
			localStorage.setItem(key, JSON.stringify({ version: 1, createdAt: 1, change: {
				operationId: expiredId, recordId: expiredId, kind: 'save', path: '/reminders/create', method: 'POST', body,
				status: 'uncertain', attempts: 1, retryAt: 0, ambiguous: true,
			} }));
			return body;
		}, { key, expiredId });
		await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		await expect(notice(page)).toBeVisible();
		await expect(notice(page).getByRole('button', { name: /^Retry|^Edit|^Discard/ })).toHaveCount(0);
		await other.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		await expect(notice(other)).toBeVisible();
		await page.reload(); await expect(notice(page)).toBeVisible();
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		expect(attempted.filter(change => change.operationId === expiredId)).toHaveLength(1);
		const download = async () => {
			const waiting = page.waitForEvent('download');
			await notice(page).getByRole('button', { name: 'Export expired change', exact: true }).click();
			const downloaded = await waiting;
			expect(downloaded.suggestedFilename()).toBe('crate-expired-change.json');
			return JSON.parse(await readFile(await downloaded.path(), 'utf8'));
		};
		const exported = await download();
		expect(exported).toMatchObject({ format: 'crate-expired-reminder-change-v1', origin, change: { body, operationId: expiredId, ambiguous: true, reviewRequired: true } });
		const remove = () => notice(page).getByRole('button', { name: 'Remove exported change from device', exact: true });
		await expect(remove()).toBeDisabled();
		await notice(page).getByRole('checkbox').check();
		await other.evaluate(key => { const entry = JSON.parse(localStorage.getItem(key)); entry.change.error = 'Changed in another tab after export'; localStorage.setItem(key, JSON.stringify(entry)); }, key);
		await expect(notice(page)).toContainText('Changed in another tab after export');
		await expect(remove()).toBeDisabled();
		await download(); await expect(remove()).toBeDisabled();
		await notice(page).getByRole('checkbox').check(); await remove().click();
		for (const tab of [page, other]) await expect(notice(tab)).toHaveCount(0);
		expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
		// A new save uses the actual server day despite the device clock in 2099.
		await page.locator('[data-action="open-create-modal"]').click();
		await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('New work after review');
		await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
		await page.getByRole('group', { name: 'New work after review. Press Enter to edit reminder.', exact: true }).waitFor();
		// Delivery is at least once across tabs/crashes. Check one immutable
		// logical operation and one stored effect, not an exactly-once network count.
		await expect.poll(() => attempted.length).toBeGreaterThanOrEqual(2);
		const saved = attempted[1];
		expect(saved.id).toBe(saved.operationId);
		expect(saved.operationId).toMatch(new RegExp(`^e1_${String(Math.floor(Date.now() / 86_400_000)).padStart(8, '0')}_`));
		const savedKey = key.slice(0, -expiredId.length) + saved.operationId;
		for (const tab of [page, other]) {
			await expect.poll(() => tab.evaluate(key => localStorage.getItem(key), savedKey)).toBeNull();
			await expect(tab.getByRole('group', { name: 'New work after review. Press Enter to edit reminder.', exact: true })).toHaveCount(1);
		}
		expect(attempted.filter(change => change.operationId === expiredId)).toHaveLength(1);
		for (const body of attempted.slice(1)) expect(body).toEqual(saved);
		await page.evaluate(() => navigator.locks.request('crate-reminder-outbox', () => {}));
		await expect.poll(() => deliveries.filter(item => item.operationId !== expiredId).every(item => item.status === 200)).toBe(true);
		const newDeliveries = deliveries.filter(item => item.operationId !== expiredId);
		expect(newDeliveries.length).toBeLessThanOrEqual(2);
		expect(new Set(newDeliveries.map(item => item.bodyHash)).size).toBe(1);
		expect(newDeliveries.every(item => item.status === 200 && !item.failure)).toBe(true);
		const response = await fetch(`${origin}/reminders/list?folderPath=Reminders`, {
			headers: { Authorization: `Bearer ${previewAuthToken}` },
		});
		expect(response.ok).toBe(true);
		const { reminders } = await response.json();
		expect(reminders.filter(item => item.id === saved.id || item.content === saved.content)).toHaveLength(1);
		if (newDeliveries.length > 1) console.log('Idempotent cross-tab replay:', JSON.stringify({ deliveries, storageTrace }));
		expect(await page.evaluate(() => window.injected)).toBeUndefined();
		expect(errors).toEqual([]);
	} catch (error) {
		console.error('Expiry delivery trace:', JSON.stringify(deliveries));
		console.error('Expiry storage trace:', JSON.stringify(storageTrace));
		throw error;
	} finally { await context.close(); }
}
try {
	for (const browserType of [chromium, webkit].filter(type => !process.env.CRATE_EXPIRY_BROWSER || type.name() === process.env.CRATE_EXPIRY_BROWSER)) {
		const browser = await browserType.launch();
		try { for (let iteration = 0; iteration < Number(process.env.CRATE_EXPIRY_REPEATS ?? 1); iteration++) await verify(browser); console.log(`${browserType.name()}: expired changes stop across reload/tabs, export exact requests, require reviewed removal, and new commands use the server clock`); }
		finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
