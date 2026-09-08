import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

// Built application, native localStorage/IndexedDB and Web Locks. The HTTP preview
// implements mutation receipts; delayed list responses expose stale-read races.
const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const row = (page, title) => page.getByRole('group', { name: `${title}. Press Enter to edit reminder.`, exact: true });
const ids = page => page.locator('.sidebar-reminder-card-wrapper').evaluateAll(nodes => nodes.map(node => node.closest('[data-reminder-id]')?.getAttribute('data-reminder-id')));

try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			for (const winner of [0, 1]) await verifyVisibleTabs(browser, winner);
			await verifyMissedConfirmation(browser);
			console.log(`${browserType.name()}: three visible tabs converge create, edit, completion, deletion and reorder with either sender; delayed reads and missed confirmations passed`);
		} finally { await browser.close(); }
	}
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

async function fixture(browser, verify) {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
	const errors = [];
	await context.addInitScript(() => {
		// Keep the native manager wrapper alive: WebKit may otherwise expose a
		// fresh wrapper whose request method bypasses this test's scheduling gate.
		const locks = navigator.locks;
		Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
		const request = locks.request.bind(locks);
		window.blockOutboxLocks = false;
		window.releaseOutboxLocks = [];
		locks.request = (name, ...args) => name === 'crate-reminder-outbox' && window.blockOutboxLocks
			? new Promise((resolve, reject) => window.releaseOutboxLocks.push(() => request(name, ...args).then(resolve, reject)))
			: request(name, ...args);
	});
	try {
		await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
		await context.request.post(`${origin}/preview/reset`);
		const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
		for (const page of pages) {
			page.setDefaultTimeout(15_000);
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
			await expect(row(page, 'Check this article')).toBeVisible();
			await expect(page.locator('[data-action="open-create-modal"]')).toBeVisible();
			await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held.length)).toBe(0);
		}
		await verify(pages, context);
		expect(errors).toEqual([]);
	} finally { await context.close(); }
}

async function settled(pages) {
	await expect.poll(() => pages[0].evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('crate-reminder-outbox:')).length)).toBe(0);
	for (const page of pages) await expect(page.locator('.pwa-reminder-sync-notices')).toHaveCount(0);
}

async function create(page, content) {
	await page.locator('[data-action="open-create-modal"]').click();
	await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill(content);
	await page.locator('[data-action="save-reminder"]').click();
}

async function verifyVisibleTabs(browser, winner) {
	await fixture(browser, async (pages, context) => {
		const source = pages[0];
		const sentBy = [];
		const pendingReads = [];
		let holdReads = true;
		await context.route('**/reminders/*', async route => {
			if (new URL(route.request().url()).pathname !== '/reminders/list') {
				sentBy.push(pages.indexOf(route.request().frame().page()));
				return route.continue();
			}
			const response = await route.fetch();
			if (holdReads) await new Promise(resolve => pendingReads.push(resolve));
			await route.fulfill({ response });
		});
		for (let index = 0; index < pages.length; index++) await pages[index].evaluate(block => { window.blockOutboxLocks = block; }, index !== winner);
		// These snapshots predate every mutation and are deliberately delivered last.
		for (const page of pages) await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await expect.poll(() => pendingReads.length).toBe(3);
		try {
			const first = source.locator('[data-reminder-id="preview-inbox-1"]');
			const second = source.locator('[data-reminder-id="preview-inbox-2"]');
			const from = await first.boundingBox(); const to = await second.boundingBox();
			expect(from && to).toBeTruthy();
			const x = from.x + from.width * 0.7;
			await source.mouse.move(x, from.y + from.height / 2); await source.mouse.down();
			await expect(first).toHaveClass(/is-long-press-armed/);
			await source.mouse.move(x, to.y + to.height / 2 + 5, { steps: 10 });
			await expect.poll(() => ids(source)).toEqual(['preview-inbox-2', 'preview-inbox-1']);
			await source.mouse.up();
			await expect.poll(() => sentBy.length).toBe(1);
			await settled(pages);
			for (const page of pages) await expect.poll(() => ids(page)).toEqual(['preview-inbox-2', 'preview-inbox-1']);

			await create(source, 'Shared creation'); await expect.poll(() => sentBy.length).toBe(2); await settled(pages);
			for (const page of pages) await expect(row(page, 'Shared creation')).toBeVisible();
			await row(source, 'Check this article').click();
			await source.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Shared edit');
			await source.locator('[data-action="save-reminder"]').click(); await expect.poll(() => sentBy.length).toBe(3); await settled(pages);
			for (const page of pages) { await expect(row(page, 'Shared edit')).toBeVisible(); await expect(row(page, 'Check this article')).toHaveCount(0); }
			await row(source, 'Shared edit').getByRole('checkbox').click(); await expect.poll(() => sentBy.length).toBe(4); await settled(pages);
			for (const page of pages) await expect(row(page, 'Shared edit')).toHaveCount(0);
			await row(source, 'Shared creation').click();
			await source.getByRole('button', { name: 'Delete reminder', exact: true }).click();
			await source.getByRole('alertdialog', { name: 'Delete reminder?', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
			await expect.poll(() => sentBy.length).toBe(5);
			await settled(pages);
			for (const page of pages) await expect(row(page, 'Shared creation')).toHaveCount(0);
			expect(sentBy).toEqual([winner, winner, winner, winner, winner]);
			expect(pendingReads.length).toBeGreaterThan(3);
		} finally {
			holdReads = false;
			for (const release of pendingReads.slice(3)) release();
			for (const release of pendingReads.slice(0, 3)) release();
			for (const page of pages) await page.evaluate(() => { window.blockOutboxLocks = false; window.releaseOutboxLocks.splice(0).forEach(release => release()); });
		}
		for (const page of pages) {
			await expect.poll(() => ids(page)).toEqual(['preview-inbox-2']);
			await expect(row(page, 'Shared creation')).toHaveCount(0);
		}
	});
}

async function verifyMissedConfirmation(browser) {
	await fixture(browser, async pages => {
		await pages[1].evaluate(() => {
			window.addEventListener('storage', event => {
				if (event.key?.startsWith('crate-reminder-outbox:confirmed:')) event.stopImmediatePropagation();
			}, { capture: true });
		});
		for (const page of pages.slice(1)) await page.evaluate(() => { window.blockOutboxLocks = true; });
		await create(pages[0], 'Recovered missed confirmation');
		await settled(pages);
		for (const page of pages) await expect(row(page, 'Recovered missed confirmation')).toBeVisible();
	});
}
