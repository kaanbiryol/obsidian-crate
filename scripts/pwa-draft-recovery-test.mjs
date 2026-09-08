import { readFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets({ assetVersion: 'draft-recovery-regression' });
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const key = 'crate-reminder-draft:Reminders:new';
const bad = JSON.stringify({ mode: 'create', draft: { content: 'Unsaved title', description: { text: 'Keep exact details 🗒️ <script>window.injected=true</script>' },
	project: 'Inbox', defaultProject: 'Inbox', priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } });

async function verify(browser) {
	const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 390, height: 844 } });
	const page = await context.newPage();
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	let writes = 0;
	await context.route('**/reminders/create', route => { writes++; return route.abort(); });
	const recovery = () => page.getByRole('dialog', { name: 'Saved draft needs review', exact: true });
	const open = () => page.locator('[data-action="open-create-modal"]').click();
	const retained = () => page.evaluate(key => sessionStorage.getItem(key), key);
	try {
		await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		await page.evaluate(({ key, bad }) => {
			sessionStorage.setItem(key, bad);
			sessionStorage.setItem('crate-reminder-draft:Private:new', 'Another folder stays private');
		}, { key, bad });
		await open();
		await expect(recovery()).toBeVisible();
		await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape'); await expect(recovery()).toHaveCount(0);
		expect(await retained()).toBe(bad);
		await page.reload(); await open(); await expect(recovery()).toBeVisible();
		await recovery().getByText('Review damaged entries', { exact: true }).click();
		await expect(recovery().locator('pre')).toHaveText(bad);
		expect(await recovery().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		expect(await page.evaluate(() => window.injected)).toBeUndefined();
		const exportDraft = async () => {
			const waiting = page.waitForEvent('download');
			await recovery().getByRole('button', { name: 'Export damaged entries', exact: true }).click();
			const download = await waiting;
			expect(download.suggestedFilename()).toBe('crate-saved-draft.json');
			return JSON.parse(await readFile(await download.path(), 'utf8'));
		};
		expect(await exportDraft()).toEqual({ format: 'crate-saved-reminder-draft-v1', origin, folderPath: 'Reminders', entries: [{ key, raw: bad }] });
		const remove = () => recovery().getByRole('button', { name: 'Remove exported copies from device', exact: true });
		await expect(remove()).toBeDisabled();
		await page.evaluate(key => sessionStorage.setItem(key, '{changed after export'), key);
		await recovery().getByRole('checkbox').check(); await remove().click();
		await expect(recovery().getByRole('alert')).toContainText('changed');
		expect(await retained()).toBe('{changed after export');
		await recovery().getByRole('button', { name: 'Close', exact: true }).click();
		await expect(recovery()).toHaveCount(0); await open();
		expect((await exportDraft()).entries).toEqual([{ key, raw: '{changed after export' }]);
		await recovery().getByRole('checkbox').check();
		await page.evaluate(() => {
			window.originalDraftRemove = Storage.prototype.removeItem;
			Storage.prototype.removeItem = function () { throw new Error('Injected storage failure'); };
		});
		await remove().click(); await expect(recovery().getByRole('alert')).toBeVisible();
		expect(await retained()).toBe('{changed after export');
		await page.evaluate(() => { Storage.prototype.removeItem = window.originalDraftRemove; });
		await remove().click();
		await expect(recovery()).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toBeVisible();
		expect(await page.evaluate(() => sessionStorage.getItem('crate-reminder-draft:Private:new'))).toBe('Another folder stays private');
		expect(writes).toBe(0); expect(errors).toEqual([]);
	} finally { await context.close(); }
}

try {
	for (const type of [chromium, webkit]) {
		const browser = await type.launch();
		try { await verify(browser); console.log(`${type.name()}: draft corruption, exact export, reload/close preservation and reviewed removal passed`); }
		finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
