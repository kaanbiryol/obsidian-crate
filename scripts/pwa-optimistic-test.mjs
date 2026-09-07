import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;

try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			await scenario(browser, verifyImmediateUpdates);
			await scenario(browser, verifyRejectedSaveRecovery);
			await scenario(browser, verifyRejectedDeleteRecovery);
			await scenario(browser, verifyLostAcknowledgement);
			console.log(`${browserType.name()}: optimistic mutations, retained drafts, rollback, reload recovery and idempotent retry passed`);
		} finally {
			await browser.close();
		}
	}
} finally {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function scenario(browser, verify) {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block',
	});
	const externalRequests = [];
	const pageErrors = [];
	try {
		await context.route('**/*', route => {
			if (new URL(route.request().url()).origin === origin) return route.continue();
			externalRequests.push(route.request().url());
			return route.abort('blockedbyclient');
		});
		const page = await context.newPage();
		page.setDefaultTimeout(15_000);
		page.on('pageerror', error => pageErrors.push(error.message));
		await page.request.post(`${origin}/preview/reset`);
		await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		await expect(card(page, 'Check this article')).toBeVisible();
		await expect(page.locator('[data-action="open-create-modal"]')).toBeVisible();
		await verify(page);
		expect(externalRequests).toEqual([]);
		expect(pageErrors).toEqual([]);
	} finally {
		await context.close();
	}
}

function card(page, content) {
	return page.getByRole('group', { name: `${content}. Press Enter to edit reminder.`, exact: true });
}

function title(page) {
	return page.getByRole('textbox', { name: 'Reminder title', exact: true });
}

function save(page) {
	return page.locator('[data-action="save-reminder"]');
}

async function expectEditorClosed(page) {
	await expect(page.locator('.pwa-modal-sheet__container--reminder')).toHaveCount(0);
}

async function expectSynced(page) {
	await expect(page.locator('.pwa-reminder-sync-notices')).toHaveCount(0);
}

async function openReminder(page, content) {
	await card(page, content).click();
	await expect(title(page)).toHaveText(content);
	await expect(save(page)).toBeEnabled();
}

async function confirmDelete(page) {
	await page.getByRole('button', { name: 'Delete reminder', exact: true }).click();
	const confirmation = page.getByRole('alertdialog', { name: 'Delete reminder?', exact: true });
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
}

async function holdNextMutation(page, path) {
	let captured;
	let release;
	let released = false;
	const outcome = new Promise(resolve => { release = resolve; });
	await page.route(`${origin}${path}`, async route => {
		captured = route.request().postData();
		const response = await outcome;
		if (response) await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify({ error: response.error }) });
		else await route.continue();
	}, { times: 1 });
	return {
		wait: () => expect.poll(() => captured !== undefined).toBe(true),
		assertHeld: () => expect(released).toBe(false),
		finish: response => { released = true; release(response); },
	};
}

async function verifyImmediateUpdates(page) {
	const create = await holdNextMutation(page, '/reminders/create');
	try {
		await page.locator('[data-action="open-create-modal"]').click();
		await expect(title(page)).toBeEditable();
		await title(page).fill('Optimistic creation');
		await save(page).click();
		await create.wait();
		await expectEditorClosed(page);
		await expect(card(page, 'Optimistic creation')).toBeVisible();
		create.assertHeld();
		// A completed background request must not close an editor opened later.
		await openReminder(page, 'Check this article');
		create.finish();
		await expectSynced(page);
		await expect(title(page)).toHaveText('Check this article');
		await expect(save(page)).toBeEnabled();
	} finally { create.finish(); }

	const edit = await holdNextMutation(page, '/reminders/update');
	try {
		await title(page).fill('Optimistic edit');
		await save(page).click();
		await edit.wait();
		await expectEditorClosed(page);
		await expect(card(page, 'Optimistic edit')).toBeVisible();
		await expect(card(page, 'Check this article')).toHaveCount(0);
		edit.assertHeld();
	} finally { edit.finish(); }
	await expectSynced(page);

	const complete = await holdNextMutation(page, '/reminders/set-completed');
	try {
		await card(page, 'Optimistic edit').getByRole('checkbox').click();
		await complete.wait();
		await expect(card(page, 'Optimistic edit')).toHaveCount(0);
		complete.assertHeld();
	} finally { complete.finish(); }
	await expectSynced(page);

	const remove = await holdNextMutation(page, '/reminders/delete');
	try {
		await openReminder(page, 'Optimistic creation');
		await confirmDelete(page);
		await remove.wait();
		await expectEditorClosed(page);
		await expect(card(page, 'Optimistic creation')).toHaveCount(0);
		remove.assertHeld();
	} finally { remove.finish(); }
	await expectSynced(page);
}

async function verifyRejectedSaveRecovery(page) {
	const rejected = await holdNextMutation(page, '/reminders/update');
	try {
		await openReminder(page, 'Check this article');
		await title(page).fill('Rejected draft title');
		await page.getByRole('textbox', { name: 'Reminder description', exact: true }).fill('Keep these details after a failed save and reload.');
		await save(page).click();
		await rejected.wait();
		await expectEditorClosed(page);
		await expect(card(page, 'Rejected draft title')).toBeVisible();
		rejected.assertHeld();
	} finally { rejected.finish({ status: 400, error: 'This draft needs a correction' }); }
	const notice = page.getByRole('region', { name: 'Not saved: Rejected draft title', exact: true });
	await expect(notice).toBeVisible();
	await expect(notice.getByRole('button', { name: 'Retry: Rejected draft title', exact: true })).toBeEnabled();
	await expect(notice.getByRole('button', { name: 'Edit: Rejected draft title', exact: true })).toBeEnabled();
	await page.reload();
	await expect(notice).toBeVisible();
	await expect(card(page, 'Rejected draft title')).toBeVisible();
	await notice.getByRole('button', { name: 'Edit: Rejected draft title', exact: true }).click();
	await expect(title(page)).toHaveText('Rejected draft title');
	await expect(page.getByRole('textbox', { name: 'Reminder description', exact: true })).toHaveValue('Keep these details after a failed save and reload.');
	await title(page).fill('Corrected draft title');
	await save(page).click();
	await expectEditorClosed(page);
	await expect(card(page, 'Corrected draft title')).toBeVisible();
	await expectSynced(page);
}

async function verifyRejectedDeleteRecovery(page) {
	const rejected = await holdNextMutation(page, '/reminders/delete');
	try {
		await openReminder(page, 'Check this article');
		await confirmDelete(page);
		await rejected.wait();
		await expectEditorClosed(page);
		await expect(card(page, 'Check this article')).toHaveCount(0);
		rejected.assertHeld();
	} finally { rejected.finish({ status: 409, error: 'Delete could not be applied' }); }
	await expect(card(page, 'Check this article')).toBeVisible();
	const notice = page.getByRole('region', { name: 'Couldn’t delete reminder: Check this article', exact: true });
	await expect(notice).toBeVisible();
	await expectEditorClosed(page);
	await notice.getByRole('button', { name: 'Retry: Check this article', exact: true }).click();
	await expect(card(page, 'Check this article')).toHaveCount(0);
	await expectSynced(page);
}

async function verifyLostAcknowledgement(page) {
	const bodies = [];
	let releaseRetry;
	const retryGate = new Promise(resolve => { releaseRetry = resolve; });
	await page.route(`${origin}/reminders/create`, async route => {
		bodies.push(route.request().postData());
		if (bodies.length === 1) {
			const committed = await route.fetch();
			expect(committed.ok()).toBe(true);
			await route.abort('failed');
			return;
		}
		await retryGate;
		await route.continue();
	});
	try {
		await page.locator('[data-action="open-create-modal"]').click();
		await title(page).fill('Saved despite lost acknowledgement');
		await save(page).click();
		await expectEditorClosed(page);
		const notice = page.getByRole('region', { name: 'Couldn’t sync: Saved despite lost acknowledgement', exact: true });
		await expect(notice).toBeVisible();
		await expect(card(page, 'Saved despite lost acknowledgement')).toHaveCount(1);
		await notice.getByRole('button', { name: 'Retry: Saved despite lost acknowledgement', exact: true }).click();
		await expect.poll(() => bodies.length).toBe(2);
		expect(bodies[1]).toBe(bodies[0]);
		expect(await serverRecordCount(page, 'Saved despite lost acknowledgement')).toBe(1);
	} finally { releaseRetry(); }
	await expectSynced(page);
	expect(await serverRecordCount(page, 'Saved despite lost acknowledgement')).toBe(1);
	await page.reload();
	await expect(card(page, 'Saved despite lost acknowledgement')).toHaveCount(1);
	await expectSynced(page);
}

async function serverRecordCount(page, content) {
	const response = await page.request.get(`${origin}/reminders/list?folderPath=Reminders`, {
		headers: { Authorization: `Bearer ${previewAuthToken}` },
	});
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.reminders.filter(reminder => reminder.content === content).length;
}
