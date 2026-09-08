/* global reminderCache -- Injected browser bundle exposes the cache API for native IndexedDB tests. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const { outputFiles } = await build({
	entryPoints: ['src/pwa/reminder-cache.ts'],
	bundle: true,
	format: 'iife',
	globalName: 'reminderCache',
	write: false,
});

for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage();
		await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Cache test</title>' }));
		await page.goto('https://pwa-cache.test');
		await page.addScriptTag({ content: outputFiles[0].text });
		const result = await page.evaluate(async () => {
			const cache = reminderCache;
			const reminder = id => ({ id, content: 'Task', priority: 4, completed: false, project: 'Inbox', filePath: 'Reminders/Inbox.md' });
			await cache.saveCachedReminderSnapshot('Reminders', [reminder('original')], ['Inbox'], 100, 'old', [{ path: 'Reminders/Large.md', reason: 'Source exceeds the reminder size limit' }]);
			const initial = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.refreshCachedReminderSnapshot('Reminders', 200, 'old');
			const refreshed = await cache.loadCachedReminderSnapshot('Reminders');
			const stored = await new Promise((resolve, reject) => {
				const request = indexedDB.open('crate-reminders', 2);
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction('snapshots', 'readonly');
					const read = tx.objectStore('snapshots').get('Reminders');
					tx.oncomplete = () => { db.close(); resolve(read.result); };
				};
			});
			await cache.saveCachedReminderSnapshot('Reminders', [reminder('new')], ['Inbox'], 300, 'new');
			await cache.refreshCachedReminderSnapshot('Reminders', 400, 'old');
			const afterStaleRefresh = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.refreshCachedReminderSnapshot('Reminders', 250, 'new');
			const afterOldTimestamp = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.clearCachedReminderSnapshots();
			const cleared = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.saveCachedReminderSnapshot('Reminders', [reminder('next')], ['Inbox'], 50, 'new');
			const afterClear = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.refreshCachedReminderSnapshot('Missing', 500, 'missing');
			const missing = await cache.loadCachedReminderSnapshot('Missing');
            await cache.clearCachedReminderSnapshots();
            await new Promise((resolve, reject) => {
                const request = indexedDB.open('crate-reminders', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('unsupported');
                request.onsuccess = () => { request.result.close(); resolve(); };
                request.onerror = () => reject(request.error);
            });
            const unsupported = await cache.loadCachedReminderSnapshot('Reminders');
            const preservedVersion = await new Promise((resolve, reject) => {
                const request = indexedDB.open('crate-reminders');
                request.onsuccess = () => { const version = request.result.version; request.result.close(); resolve(version); };
                request.onerror = () => reject(request.error);
            });
            await cache.clearCachedReminderSnapshots();
            await cache.saveCachedReminderSnapshot('Reminders', [reminder('fresh')], ['Inbox'], 600, 'fresh');
            const fresh = await cache.loadCachedReminderSnapshot('Reminders');
            return { initial, refreshed, stored, afterStaleRefresh, afterOldTimestamp, cleared, afterClear, missing, unsupported, preservedVersion, fresh };
		});
		assert.equal(result.initial.reminders[0].id, 'original');
		assert.equal(result.refreshed.savedAt, 200);
		assert.deepEqual(result.refreshed.issues, [{ path: 'Reminders/Large.md', reason: 'Source exceeds the reminder size limit' }]);
		const { sessionScope, ...storedContent } = result.stored;
		assert.match(sessionScope, /^[a-f0-9]{64}$/);
		assert.deepEqual(storedContent, result.initial, '304 must not rewrite the snapshot');
		assert.equal(result.afterStaleRefresh.savedAt, 300);
		assert.equal(result.afterStaleRefresh.reminders[0].id, 'new');
		assert.equal(result.afterOldTimestamp.savedAt, 300);
		assert.equal(result.cleared, null);
		assert.equal(result.afterClear.savedAt, 50);
		assert.equal(result.missing, null);
		assert.equal(result.unsupported, null);
		assert.equal(result.preservedVersion, 1, 'Unsupported cache must remain untouched');
		assert.equal(result.fresh.reminders[0].id, 'fresh');
		console.log(`${browserType.name()}: cache creation, metadata-only refresh, revision guards and clearing passed`);
	} finally {
		await browser.close();
	}
}
