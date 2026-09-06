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
		await page.goto('http://pwa-cache.test');
		// Seed the old schema to verify that upgrading preserves an existing offline snapshot.
		await page.evaluate(async () => {
			await new Promise((resolve, reject) => {
				const request = indexedDB.open('crate-reminders', 1);
				request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: 'folderPath' });
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction('snapshots', 'readwrite');
					tx.objectStore('snapshots').put({
						folderPath: 'Reminders', reminders: [{ id: 'original' }], projects: ['Inbox'], savedAt: 100, etag: 'old',
					});
					tx.oncomplete = () => { db.close(); resolve(); };
					tx.onerror = () => reject(tx.error);
				};
			});
		});
		await page.addScriptTag({ content: outputFiles[0].text });
		const result = await page.evaluate(async () => {
			const cache = reminderCache;
			const migrated = await cache.loadCachedReminderSnapshot('Reminders');
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
			await cache.saveCachedReminderSnapshot('Reminders', [{ id: 'new' }], ['Inbox'], 300, 'new');
			await cache.refreshCachedReminderSnapshot('Reminders', 400, 'old');
			const afterStaleRefresh = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.refreshCachedReminderSnapshot('Reminders', 250, 'new');
			const afterOldTimestamp = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.clearCachedReminderSnapshots();
			const cleared = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.saveCachedReminderSnapshot('Reminders', [{ id: 'next' }], ['Inbox'], 50, 'new');
			const afterClear = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.refreshCachedReminderSnapshot('Missing', 500, 'missing');
			const missing = await cache.loadCachedReminderSnapshot('Missing');
			return { migrated, refreshed, stored, afterStaleRefresh, afterOldTimestamp, cleared, afterClear, missing };
		});
		assert.equal(result.migrated.reminders[0].id, 'original');
		assert.equal(result.refreshed.savedAt, 200);
		assert.deepEqual(result.stored, result.migrated, '304 must not rewrite the snapshot');
		assert.equal(result.afterStaleRefresh.savedAt, 300);
		assert.equal(result.afterStaleRefresh.reminders[0].id, 'new');
		assert.equal(result.afterOldTimestamp.savedAt, 300);
		assert.equal(result.cleared, null);
		assert.equal(result.afterClear.savedAt, 50);
		assert.equal(result.missing, null);
		console.log(`${browserType.name()}: cache migration, metadata-only refresh, revision guards and clearing passed`);
	} finally {
		await browser.close();
	}
}
