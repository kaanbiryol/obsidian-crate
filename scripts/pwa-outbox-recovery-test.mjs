import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';

const assets = await buildPwaPreviewAssets({ assetVersion: 'outbox-recovery-regression' });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const key = (token, id, folder = 'Reminders') => `crate-reminder-outbox:v1:${createHash('sha256').update(token).digest('hex')}:${encodeURIComponent(folder)}:${id}`;
const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const badKey = key(previewAuthToken, id('1'));
const oldBadKey = key('expired-session', id('2'));
const privateKey = key('private-session', id('3'), 'Private');
const healthyId = id('4'); const oldHealthyId = id('5');
const lateKey = key(previewAuthToken, id('6'));
const badRaw = '{"title":"Keep exact bytes 🗒️\n<script>window.injected=true</script>"' + 'long-fragment'.repeat(100);
const oldBadRaw = JSON.stringify({ version: 2, text: 'Keep unsupported-version content' });
const notice = page => page.getByRole('region', { name: 'Damaged pending changes', exact: true });

async function verify(browser) {
	await fetch(`${origin}/preview/reset`, { method: 'POST' });
	const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 390, height: 844 } });
	const page = await context.newPage();
	const other = await context.newPage();
	const errors = [];
	for (const tab of [page, other]) tab.on('pageerror', error => errors.push(error.message));
	let fail = true;
	const attempts = []; const committed = [];
	await context.route('**/outbox-seed', route => route.fulfill({ body: '<!doctype html><title>Seed</title>', contentType: 'text/html' }));
	await context.route('**/reminders/create', async route => {
		const body = route.request().postDataJSON(); attempts.push(body);
		if (fail) return route.fulfill({ status: 503, body: 'Injected network failure' });
		const result = await route.fetch();
		expect(result.ok()).toBe(true); committed.push(body);
		return route.fulfill({ response: result });
	});
	try {
		await page.goto(`${origin}/outbox-seed`);
		const healthyKey = key(previewAuthToken, healthyId); const oldHealthyKey = key('expired-session', oldHealthyId);
		const draft = await page.evaluate(({ badKey, oldBadKey, privateKey, badRaw, oldBadRaw, healthyKey, oldHealthyKey, healthyId, oldHealthyId }) => {
			const queued = (operationId, content) => JSON.stringify({ version: 1, createdAt: 1, change: {
				operationId, recordId: operationId, kind: 'save', path: '/reminders/create', method: 'POST', status: 'uncertain', attempts: 1, retryAt: 0,
				body: JSON.stringify({ operationId, id: operationId, folderPath: 'Reminders', content, project: 'Inbox', priority: 4 }),
			} });
			localStorage.setItem(badKey, badRaw); localStorage.setItem(oldBadKey, oldBadRaw); localStorage.setItem(privateKey, 'Never export another folder');
			localStorage.setItem(healthyKey, queued(healthyId, 'Healthy pending creation'));
			localStorage.setItem(oldHealthyKey, queued(oldHealthyId, 'Healthy recovered creation'));
			const draft = JSON.stringify({ mode: 'create', draft: { content: 'Keep independent draft', description: 'Full details', project: 'Inbox', defaultProject: 'Inbox',
				priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } });
			sessionStorage.setItem('crate-reminder-draft:Reminders:new', draft); return draft;
		}, { badKey, oldBadKey, privateKey, badRaw, oldBadRaw, healthyKey, oldHealthyKey, healthyId, oldHealthyId });
		await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		await expect(notice(page)).toContainText('2 saved changes need recovery');
		await page.getByRole('region', { name: 'Couldn’t sync: Reminder', exact: true }).waitFor();
		await other.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		await expect(notice(other)).toContainText('2 saved changes need recovery');
		fail = false;
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		const card = (tab, content) => tab.getByRole('group', { name: `${content}. Press Enter to edit reminder.`, exact: true });
		for (const tab of [page, other]) await card(tab, 'Healthy pending creation').waitFor();
		await page.getByRole('button', { name: 'Resume saved changes', exact: true }).click();
		for (const tab of [page, other]) await card(tab, 'Healthy recovered creation').waitFor();
		expect(committed.map(body => body.operationId).sort()).toEqual([healthyId, oldHealthyId].sort());
		expect(attempts.every(body => [healthyId, oldHealthyId].includes(body.operationId))).toBe(true);
		expect(await page.evaluate(key => localStorage.getItem(key), healthyKey)).toBeNull();
		expect(await page.evaluate(key => localStorage.getItem(key), oldHealthyKey)).toBeNull();
		await notice(page).getByText('Review damaged entries', { exact: true }).focus();
		await page.keyboard.press('Enter');
		await expect(notice(page).locator('pre').first()).toHaveText(badRaw);
		expect(await notice(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		expect(await page.evaluate(() => window.injected)).toBeUndefined();
		const downloadEntries = async () => {
			const waiting = page.waitForEvent('download');
			await notice(page).getByRole('button', { name: 'Export damaged entries', exact: true }).click();
			const downloaded = await waiting;
			expect(downloaded.suggestedFilename()).toBe('crate-damaged-changes.json');
			return JSON.parse(await readFile(await downloaded.path(), 'utf8'));
		};
		const exported = await downloadEntries();
		expect(exported).toEqual({ format: 'crate-damaged-reminder-changes-v1', origin, folderPath: 'Reminders',
			entries: [{ key: badKey, raw: badRaw }, { key: oldBadKey, raw: oldBadRaw }] });
		const remove = () => notice(page).getByRole('button', { name: 'Remove exported copies from device', exact: true });
		await expect(remove()).toBeDisabled();
		await other.evaluate(({ badKey, lateKey }) => {
			localStorage.setItem(badKey, 'Changed after the export'); localStorage.setItem(lateKey, 'New entry after export');
		}, { badKey, lateKey });
		await expect(notice(page)).toContainText('3 saved changes need recovery');
		await notice(page).getByRole('checkbox', { name: 'I saved and reviewed the export', exact: true }).check();
		await remove().click();
		await expect(notice(page)).toContainText('2 saved changes need recovery');
		expect(await page.evaluate(key => localStorage.getItem(key), badKey)).toBe('Changed after the export');
		expect(await page.evaluate(key => localStorage.getItem(key), lateKey)).toBe('New entry after export');
		expect(await page.evaluate(key => localStorage.getItem(key), oldBadKey)).toBeNull();
		const nextExport = await downloadEntries();
		expect(nextExport.entries).toEqual(expect.arrayContaining([{ key: badKey, raw: 'Changed after the export' }, { key: lateKey, raw: 'New entry after export' }]));
		await expect(remove()).toBeDisabled();
		await notice(page).getByRole('checkbox').check(); await remove().click();
		for (const tab of [page, other]) await expect(notice(tab)).toHaveCount(0);
		expect(await page.evaluate(key => localStorage.getItem(key), privateKey)).toBe('Never export another folder');
		expect(await page.evaluate(() => sessionStorage.getItem('crate-reminder-draft:Reminders:new'))).toBe(draft);
		await page.locator('[data-action="open-create-modal"]').click();
		await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveText('Keep independent draft');
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try { await verify(browser); console.log(`${browserType.name()}: damaged entries remain exportable, healthy current/recovered commands sync across tabs, and removal preserves changed or unexported bytes and other folders`); }
		finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
