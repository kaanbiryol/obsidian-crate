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
	const errors = []; const attempted = [];
	for (const tab of [page, other]) tab.on('pageerror', error => errors.push(error.message));
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
		await expect.poll(() => attempted.length).toBe(2);
		const saved = attempted[1];
		expect(saved.id).toBe(saved.operationId);
		expect(saved.operationId).toMatch(new RegExp(`^e1_${String(Math.floor(Date.now() / 86_400_000)).padStart(8, '0')}_`));
		expect(await page.evaluate(() => window.injected)).toBeUndefined();
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}
try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try { await verify(browser); console.log(`${browserType.name()}: expired changes stop across reload/tabs, export exact requests, require reviewed removal, and new commands use the server clock`); }
		finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
