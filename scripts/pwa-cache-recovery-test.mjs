/* global reminderCache -- Test bundle exposes production cache functions in the browser. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const { outputFiles } = await build({ stdin: { contents: `export * from './src/pwa/reminder-cache'; export { reminderCacheHealth } from './src/pwa/reminder-cache-database';`, resolveDir: process.cwd() },
	bundle: true, format: 'iife', globalName: 'reminderCache', write: false });

for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage();
		await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Cache recovery</title>' }));
		await page.goto('https://pwa-cache-recovery.test');
		await page.addScriptTag({ content: outputFiles[0].text });
		const results = await page.evaluate(async () => {
			const cache = reminderCache;
			const marker = 'local-only text must survive';
			localStorage.setItem('crate-reminder-outbox:recovery-fixture', marker);
			sessionStorage.setItem('crate-reminder-draft:recovery-fixture', marker);
			const reminder = { id: 'one', content: 'Healthy cached task', priority: 4, completed: false, project: 'Inbox', filePath: 'Reminders/Inbox.md' };
			const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
			const snapshot = { folderPath: 'Reminders', reminders: [reminder], projects: ['Inbox'], savedAt: 100, etag: 'one', issues: [], sessionScope: await hash('') };
			const open = (version, upgrade) => new Promise((resolve, reject) => {
				const request = version ? indexedDB.open('crate-reminders', version) : indexedDB.open('crate-reminders');
				request.onupgradeneeded = () => upgrade?.(request.result);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const put = (db, value) => new Promise((resolve, reject) => {
				const tx = db.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').put(value);
				tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
			});
			const inspect = async () => {
				const db = await open();
				try {
					const raw = await new Promise((resolve, reject) => {
						const tx = db.transaction('snapshots', 'readonly'); const request = tx.objectStore('snapshots').getAll();
						tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error);
					});
					return { version: db.version, stores: Array.from(db.objectStoreNames), raw };
				} finally { db.close(); }
			};
			const seedLegacy = async () => {
				await cache.clearCachedReminderSnapshots();
				const db = await open(1, db => db.createObjectStore('snapshots', { keyPath: 'folderPath' }));
				await put(db, snapshot); return db;
			};
			let old = await seedLegacy(); old.close();
			const migrated = await cache.loadCachedReminderSnapshot('Reminders');
			const migration = await inspect();

			old = await seedLegacy(); old.close();
			const nativeOpen = IDBFactory.prototype.open;
			IDBFactory.prototype.open = function (...args) {
				const request = nativeOpen.apply(this, args);
				request.addEventListener('upgradeneeded', () => queueMicrotask(() => request.transaction?.abort()));
				return request;
			};
			const interrupted = await cache.loadCachedReminderSnapshot('Reminders');
			IDBFactory.prototype.open = nativeOpen;
			const afterInterruption = await inspect();
			const retried = await cache.loadCachedReminderSnapshot('Reminders');

			old = await seedLegacy();
			const started = performance.now();
			const blocked = await cache.loadCachedReminderSnapshot('Reminders');
			const blockedMs = performance.now() - started;
			const blockedProblem = cache.reminderCacheHealth.getSnapshot();
			old.close();
			const afterAbandonedOpen = await inspect();
			const unblocked = await cache.loadCachedReminderSnapshot('Reminders');

			let db = await open();
			await put(db, { ...snapshot, reminders: [null] });
			await put(db, { ...snapshot, folderPath: 'Other' }); db.close();
			const damaged = await cache.loadCachedReminderSnapshot('Reminders');
			const damagedProblem = cache.reminderCacheHealth.getSnapshot();
			const beforeRebuild = await inspect();
			const rebuilt = await cache.rebuildCachedReminderSnapshot('Reminders');
			const afterRebuild = await inspect();
			await cache.saveCachedReminderSnapshot('Reminders', [reminder], ['Inbox'], 200, 'two');
			const healthy = await cache.loadCachedReminderSnapshot('Reminders');
			const nativePut = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (...args) {
				if (this.name === 'snapshots') throw new DOMException('Injected quota failure', 'QuotaExceededError');
				return nativePut.apply(this, args);
			};
			await cache.saveCachedReminderSnapshot('Reminders', [{ ...reminder, content: 'Uncached change' }], ['Inbox'], 300, 'three');
			const quotaProblem = cache.reminderCacheHealth.getSnapshot();
			IDBObjectStore.prototype.put = nativePut;
			const afterQuota = await cache.loadCachedReminderSnapshot('Reminders');

			IDBFactory.prototype.open = () => { throw new DOMException('Injected denied storage', 'SecurityError'); };
			const denied = await cache.loadCachedReminderSnapshot('Reminders');
			const deniedProblem = cache.reminderCacheHealth.getSnapshot();
			IDBFactory.prototype.open = nativeOpen;
			localStorage.setItem('crate-reminders-auth-token', 'new-session');
			const otherSession = await cache.loadCachedReminderSnapshot('Reminders');

			// A future client owns this format: current code cannot migrate or reset it.
			await cache.clearCachedReminderSnapshots();
			db = await open(3, db => {
				db.createObjectStore('snapshots', { keyPath: 'folderPath' });
				db.createObjectStore('future-store');
			});
			await put(db, snapshot); db.close();
			const future = await cache.loadCachedReminderSnapshot('Reminders');
			const futureProblem = cache.reminderCacheHealth.getSnapshot();
			const futureReset = await cache.rebuildCachedReminderSnapshot('Reminders');
			const futurePreserved = await inspect();

			// A blocked logout still ends promptly and must not claim private bytes were erased.
			db = await open();
			const blockedClear = await cache.clearCachedReminderSnapshots();
			db.close();
			await cache.saveCachedReminderSnapshot('Reminders', [reminder], ['Inbox'], 400, 'four');
			const afterClear = await cache.loadCachedReminderSnapshot('Reminders');
			return { snapshot, migrated, migration, interrupted, afterInterruption, retried, blocked, blockedMs, blockedProblem, afterAbandonedOpen, unblocked,
				damaged, damagedProblem, beforeRebuild, rebuilt, afterRebuild, healthy, quotaProblem, afterQuota, denied, deniedProblem, otherSession,
				future, futureProblem, futureReset, futurePreserved, blockedClear, afterClear,
				pending: localStorage.getItem('crate-reminder-outbox:recovery-fixture'), draft: sessionStorage.getItem('crate-reminder-draft:recovery-fixture') };
		});
		assert.equal(results.migrated.reminders[0].id, 'one');
		assert.deepEqual(results.migration, { version: 2, stores: ['freshness', 'snapshots'], raw: [results.snapshot] });
		assert.equal(results.interrupted, null);
		assert.deepEqual(results.afterInterruption, { version: 1, stores: ['snapshots'], raw: [results.snapshot] });
		assert.deepEqual(results.retried, results.migrated);
		assert.equal(results.blocked, null); assert.equal(results.blockedProblem, 'blocked'); assert.ok(results.blockedMs < 2_000);
		assert.deepEqual(results.afterAbandonedOpen, results.afterInterruption, 'Abandoned request must not migrate later');
		assert.deepEqual(results.unblocked, results.migrated);
		assert.equal(results.damaged, null); assert.equal(results.damagedProblem, 'damaged');
		assert.equal(results.beforeRebuild.raw.length, 2); assert.equal(results.rebuilt, true);
		assert.deepEqual(results.afterRebuild.raw.map(row => row.folderPath), ['Other']);
		assert.equal(results.healthy.savedAt, 200); assert.equal(results.quotaProblem, 'unavailable');
		assert.deepEqual(results.afterQuota, results.healthy);
		assert.equal(results.denied, null); assert.equal(results.deniedProblem, 'unavailable'); assert.equal(results.otherSession, null);
		assert.equal(results.future, null); assert.equal(results.futureProblem, 'unsupported'); assert.equal(results.futureReset, false);
		assert.deepEqual(results.futurePreserved, { version: 3, stores: ['future-store', 'snapshots'], raw: [results.snapshot] });
		assert.equal(results.blockedClear, false); assert.equal(results.afterClear.savedAt, 400);
		assert.equal(results.pending, 'local-only text must survive'); assert.equal(results.draft, results.pending);
		console.log(`${browserType.name()}: native IndexedDB migration, interruption, blocking, corruption, quota, session isolation and future-format preservation passed`);
	} finally { await browser.close(); }
}
