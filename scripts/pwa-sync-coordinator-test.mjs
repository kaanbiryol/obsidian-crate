import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { previewAuthToken } from './pwa-preview-fixtures.mjs';
import { switchFeature } from './pwa-feature-navigation.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
const session = { id: 'reminders:coordinator:g1', token: previewAuthToken, generation: 'g1', folderPath: 'Reading', source: 'reminders', expiresAt: Date.now() + 86400000 };

async function setup(browser, { reading = true, reminders = true, pendingReading = false, pendingReminder = false } = {}) {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
	const page = await context.newPage();
	const errors = []; page.on('pageerror', error => errors.push(error.message));
	const features = { reading, reminders };
	await page.route('**/features', route => route.fulfill({ json: features }));
	await page.route('**/reading/session', route => route.fulfill({ json: { ...session, id: 'coordinator', day: Math.floor(Date.now() / 86400000) } }));
	await page.route('**/reading/list*', route => route.fulfill({ json: { items: [], issues: [], cursor: null } }));
	await page.goto(origin + '/health');
	await page.evaluate(async ({ session, features, pendingReading, pendingReminder }) => {
		localStorage.setItem('crate-reminders-auth-token', session.token);
		localStorage.setItem('crate-reading-session-v1', JSON.stringify(session));
		localStorage.setItem('crate-shared-features', JSON.stringify(features));
		const db = await new Promise((resolve, reject) => {
			const request = indexedDB.open('crate-reading-v1', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('values');
			request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
		});
		const tx = db.transaction('values', 'readwrite');
		tx.objectStore('values').put(pendingReading ? [{ id: 'queued-reading', sessionId: session.id, action: 'capture', intent: { url: 'https://example.com/retained' } }] : [], `pending:${session.id}`);
		await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
		if (pendingReminder) {
			const response = await fetch('/reminders/list?folderPath=Reminders', { headers: { Authorization: `Bearer ${session.token}` } });
			const previous = (await response.json()).reminders[0];
			const operationId = `e1_${String(Math.floor(Date.now() / 86400000)).padStart(8, '0')}_${crypto.randomUUID()}`;
			const change = { operationId, recordId: previous.id, kind: 'complete', previous, optimistic: { ...previous, completed: !previous.completed },
				path: '/reminders/set-completed', method: 'POST', status: 'pending', attempts: 0, retryAt: 0,
				body: JSON.stringify({ folderPath: 'Reminders', id: previous.id, operationId, filePath: previous.filePath, expectedRevision: previous.revision, completed: !previous.completed }) };
			const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.token))), n => n.toString(16).padStart(2, '0')).join('');
			localStorage.setItem(`crate-reminder-outbox:v1:${hash}:Reminders:${operationId}`, JSON.stringify({ version: 1, createdAt: Date.now(), change }));
		}
	}, { session, features, pendingReading, pendingReminder });
	return { page, context, features, errors };
}
const pendingReading = page => page.evaluate(async () => {
	const db = await new Promise(resolve => { const r = indexedDB.open('crate-reading-v1', 1); r.onsuccess = () => resolve(r.result); });
	const id = JSON.parse(localStorage.getItem('crate-reading-session-v1')).id;
	const result = await new Promise(resolve => { const r = db.transaction('values').objectStore('values').get(`pending:${id}`); r.onsuccess = () => resolve(r.result); }); db.close(); return result;
});
const reminderCount = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('crate-reminder-outbox:')).length);
const indicator = page => page.locator('.crate-feature-panel[data-active="true"] .pwa-sync-indicator');
async function expectStatusToast(page, state, label) {
	const before = page.url();
	await indicator(page).getByRole('button').tap();
	const toast = page.locator('.toast.has-sync-indicator');
	await expect(toast).toBeVisible();
	await expect(toast).toHaveText(label);
	await expect(toast).toHaveAttribute('role', state === 'error' ? 'alert' : 'status');
	await expect(toast.locator('.crate-sync-indicator')).toHaveAttribute('data-sync-state', state);
	await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
	expect(page.url()).toBe(before);
}


try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch();
		try {
			{
				const { page, context, errors } = await setup(browser);
				await page.goto(origin + '/notifications?tab=inbox');
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'synced');
				let release; const waiting = new Promise(resolve => { release = resolve; });
				// Warm startup has a saved Reading list, but connection verification
				// precedes its refresh flag. Keep the whole interval yellow.
				await page.route('**/reading/session', async route => {
					await waiting;
					await route.fulfill({ json: { ...session, id: 'coordinator', day: Math.floor(Date.now() / 86400000) } });
				});
				await context.addInitScript(() => {
					window.startupSyncStates = [];
					new MutationObserver(() => {
						const state = document.querySelector('.pwa-sync-indicator')?.getAttribute('data-sync-state');
						if (state && window.startupSyncStates.at(-1) !== state) window.startupSyncStates.push(state);
					}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-sync-state'] });
				});
				await page.reload();
				await expect(indicator(page)).toBeVisible();
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'syncing');
				release();
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'synced');
				expect(await page.evaluate(() => window.startupSyncStates)).toEqual(['syncing', 'synced']);
				expect(errors).toEqual([]); await context.close();
			}
			{
				const { page, context, errors } = await setup(browser, { pendingReading: true });
				let release; const waiting = new Promise(resolve => { release = resolve; }); let captures = 0;
				await page.route('**/reading/capture', async route => { captures++; await waiting; await route.fulfill({ json: {} }); });
				await page.goto(origin + '/notifications?tab=inbox');
				await expect.poll(() => captures).toBe(1);
				await expect(page.locator('.crate-reading-web')).toHaveCount(0);
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'syncing');
				await expectStatusToast(page, 'syncing', 'Syncing 1 change');
				await expect(page.locator('.crate-reading-web')).toHaveCount(0);
				release(); await expect.poll(async () => (await pendingReading(page)).length).toBe(0);
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'synced');
				await expectStatusToast(page, 'synced', 'All changes synced');
				await switchFeature(page, 'Reading');
				await expect(indicator(page)).toHaveAttribute('title', 'All changes synced');
				await expectStatusToast(page, 'synced', 'All changes synced');
				await context.setOffline(true);
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'offline');
				await expectStatusToast(page, 'offline', 'Offline: showing saved data');
				expect(errors).toEqual([]); await context.close();
			}
			{
				const { page, context, errors } = await setup(browser, { pendingReminder: true });
				await page.route('**/reading/list*', route => route.fulfill({ status: 503, json: { error: 'Reading temporarily unavailable' } }));
				await page.goto(origin + '/notifications?section=reading');
				await expect.poll(() => reminderCount(page)).toBe(0);
				await expect(page.locator('.pwa-reminders-view')).toHaveCount(0);
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'error');
				await expectStatusToast(page, 'error', await indicator(page).getAttribute('title'));
				await switchFeature(page, 'Reminders');
				await expect(indicator(page)).toHaveAttribute('title', /Reading:/);
				expect(errors).toEqual([]); await context.close();
			}
			for (const paused of ['reading', 'reminders']) {
				const { page, context, features, errors } = await setup(browser, { [paused]: false, pendingReading: paused === 'reading', pendingReminder: paused === 'reminders' });
				let captures = 0;
				await page.route('**/reading/capture', route => { captures++; return route.fulfill({ json: {} }); });
				await page.goto(origin + (paused === 'reading' ? '/notifications?tab=inbox' : '/notifications?section=reading'));
				await expect(indicator(page)).toHaveAttribute('title', /Paused: 1 change saved on this device/);
				await page.getByRole('button', { name: 'Open settings', exact: true }).click();
				const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
				await expect(settings.getByRole('button', { name: 'Refresh all', exact: true })).toBeEnabled();
				await expect(settings.getByRole('button', { name: 'Log out', exact: true })).toBeEnabled();
				await settings.getByRole('button', { name: 'Refresh all', exact: true }).click();
				if (paused === 'reading') { expect(captures).toBe(0); expect(await pendingReading(page)).toHaveLength(1); }
				else expect(await reminderCount(page)).toBe(1);
				await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
				await page.reload(); await expect(indicator(page)).toHaveAttribute('title', /Paused:/);
				features[paused] = true;
				await page.evaluate(() => window.dispatchEvent(new Event('focus')));
				if (paused === 'reading') await expect.poll(async () => (await pendingReading(page)).length).toBe(0);
				else await expect.poll(() => reminderCount(page)).toBe(0);
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'synced');
				expect(errors).toEqual([]); await context.close();
			}
			{
				const { page, context } = await setup(browser, { pendingReading: true });
				const chunk = Object.entries(assets.PWA_CLIENT_ASSETS).find(([, source]) => source.includes('app-shell pwa-reminders-view'))?.[0];
				expect(chunk).toBeTruthy();
				await page.route(`**/notifications/assets/${chunk}*`, route => route.abort());
				await page.route('**/reading/capture', route => route.fulfill({ json: {} }));
				await page.goto(origin + '/notifications?tab=inbox');
				await expect(page.getByRole('heading', { name: 'Reminders is unavailable' })).toBeVisible();
				await expect.poll(async () => (await pendingReading(page)).length).toBe(0);
				await page.getByRole('button', { name: 'Open settings', exact: true }).click();
				await expect(page.getByRole('button', { name: 'Refresh all', exact: true })).toBeEnabled();
				await page.getByRole('button', { name: 'Close settings', exact: true }).click();
				await page.getByRole('button', { name: 'Switch to Reading', exact: true }).click();
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'synced');
				await context.close();
			}
			{
				const { page, context, errors } = await setup(browser);
				let release; const cleanup = new Promise(resolve => { release = resolve; });
				await page.route('**/auth/session', async route => { await cleanup; await route.fulfill({ status: 503, json: { error: 'Unavailable' } }); });
				await page.goto(origin + '/notifications?section=reading');
				await expect(indicator(page)).toHaveAttribute('data-sync-state', 'synced');
				await page.getByRole('button', { name: 'Open settings', exact: true }).click();
				await page.getByRole('button', { name: 'Log out', exact: true }).click();
				await page.getByRole('button', { name: 'Log out and clear device data', exact: true }).click();
				await expect(page.getByRole('heading', { name: 'Connect to Crate' })).toBeVisible();
				await expect(page.locator('.pwa-reminders-view')).toHaveCount(0);
				release();
				await expect(page.locator('.toast')).toContainText('Remote session cleanup could not finish');
				expect(errors).toEqual([]); await context.close();
			}
			console.log(`${engine.name()}: cross-feature delivery, shared status, failure isolation, paused queues, resume, missing screen chunks and logout feedback passed`);
		} finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
