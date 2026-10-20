/* global reminderCache -- Test bundle exposes production cache functions in the browser. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const { outputFiles } = await build({ stdin: { contents: `export * from './src/pwa/reminders/cache/reminder-cache'; export { reminderCacheHealth } from './src/pwa/reminders/cache/reminder-cache-database';`, resolveDir: process.cwd() },
	bundle: true, format: 'iife', globalName: 'reminderCache', write: false });

for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage();
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
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
			// An unknown store layout is preserved rather than reset.
			const old = await seedLegacy(); old.close();
			const migrated = await cache.loadCachedReminderSnapshot('Reminders');
			const migration = await inspect();

			const nativeOpen = IDBFactory.prototype.open;

			// Another tab holding the database while it is being replaced blocks
			// opening; the cache reports it instead of hanging.
			await cache.clearCachedReminderSnapshots();
			await cache.saveCachedReminderSnapshot({ folderPath: 'Reminders', reminders: [reminder], projects: ['Inbox'], savedAt: 100, etag: 'one' });
			const held = await open();
			const replacing = indexedDB.deleteDatabase('crate-reminders');
			const started = performance.now();
			const blocked = await cache.loadCachedReminderSnapshot('Reminders');
			const blockedMs = performance.now() - started;
			const blockedProblem = cache.reminderCacheHealth.getSnapshot();
			held.close();
			await new Promise(resolve => { replacing.onsuccess = replacing.onerror = resolve; });
			const unblocked = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.clearCachedReminderSnapshots();
			await cache.saveCachedReminderSnapshot({ folderPath: 'Reminders', reminders: [reminder], projects: ['Inbox'], savedAt: 100, etag: 'one' });

			let db = await open();
			await put(db, { ...snapshot, reminders: [null] });
			await put(db, { ...snapshot, folderPath: 'Other' }); db.close();
			const damaged = await cache.loadCachedReminderSnapshot('Reminders');
			const damagedProblem = cache.reminderCacheHealth.getSnapshot();
			const beforeRebuild = await inspect();
			const rebuilt = await cache.rebuildCachedReminderSnapshot('Reminders');
			const afterRebuild = await inspect();
			await cache.saveCachedReminderSnapshot({ folderPath: 'Reminders', reminders: [reminder], projects: ['Inbox'], savedAt: 200, etag: 'two' });
			const healthy = await cache.loadCachedReminderSnapshot('Reminders');
			const nativePut = IDBObjectStore.prototype.put;
			IDBObjectStore.prototype.put = function (...args) {
				if (this.name === 'snapshots') throw new DOMException('Injected quota failure', 'QuotaExceededError');
				return nativePut.apply(this, args);
			};
			await cache.saveCachedReminderSnapshot({ folderPath: 'Reminders', reminders: [{ ...reminder, content: 'Uncached change' }], projects: ['Inbox'], savedAt: 300, etag: 'three' });
			const quotaProblem = cache.reminderCacheHealth.getSnapshot();
			IDBObjectStore.prototype.put = nativePut;
			const afterQuota = await cache.loadCachedReminderSnapshot('Reminders');

			// A request succeeding does not mean its transaction committed.
			IDBObjectStore.prototype.put = function (...args) {
				const request = nativePut.apply(this, args);
				if (this.name === 'snapshots') request.addEventListener('success', () => this.transaction.abort());
				return request;
			};
			await cache.saveCachedReminderSnapshot({ folderPath: 'Reminders', reminders: [{ ...reminder, content: 'Aborted write' }], projects: ['Inbox'], savedAt: 350, etag: 'aborted' });
			const abortedWriteProblem = cache.reminderCacheHealth.getSnapshot();
			IDBObjectStore.prototype.put = nativePut;
			const afterAbortedWrite = await cache.loadCachedReminderSnapshot('Reminders');
			const nativeGet = IDBObjectStore.prototype.get;
			IDBObjectStore.prototype.get = function (...args) {
				const request = nativeGet.apply(this, args);
				if (this.name === 'snapshots') request.addEventListener('success', () => this.transaction.abort());
				return request;
			};
			const abortedRead = await cache.loadCachedReminderSnapshot('Reminders');
			const abortedReadProblem = cache.reminderCacheHealth.getSnapshot();
			IDBObjectStore.prototype.get = nativeGet;

			IDBFactory.prototype.open = () => { throw new DOMException('Injected denied storage', 'SecurityError'); };
			const denied = await cache.loadCachedReminderSnapshot('Reminders');
			const deniedProblem = cache.reminderCacheHealth.getSnapshot();
			IDBFactory.prototype.open = nativeOpen;
			localStorage.setItem('crate-reminders-auth-token', 'new-session');
			const otherSession = await cache.loadCachedReminderSnapshot('Reminders');

			// A future client owns this format: current code cannot migrate or reset it.
			await cache.clearCachedReminderSnapshots();
			db = await open(4, db => {
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
			await cache.saveCachedReminderSnapshot({ folderPath: 'Reminders', reminders: [reminder], projects: ['Inbox'], savedAt: 400, etag: 'four' });
			const afterClear = await cache.loadCachedReminderSnapshot('Reminders');
			return { snapshot, migrated, migration, blocked, blockedMs, blockedProblem, unblocked,
				damaged, damagedProblem, beforeRebuild, rebuilt, afterRebuild, healthy, quotaProblem, afterQuota,
				abortedWriteProblem, afterAbortedWrite, abortedRead, abortedReadProblem, denied, deniedProblem, otherSession,
				future, futureProblem, futureReset, futurePreserved, blockedClear, afterClear,
				pending: localStorage.getItem('crate-reminder-outbox:recovery-fixture'), draft: sessionStorage.getItem('crate-reminder-draft:recovery-fixture') };
		});
		assert.equal(results.migrated, null);
		assert.deepEqual(results.migration, { version: 1, stores: ['snapshots'], raw: [results.snapshot] });
		assert.equal(results.blocked, null); assert.equal(results.blockedProblem, 'blocked'); assert.ok(results.blockedMs < 4_500);
		assert.equal(results.unblocked, null);

		assert.equal(results.damaged, null); assert.equal(results.damagedProblem, 'damaged');
		assert.equal(results.beforeRebuild.raw.length, 2); assert.equal(results.rebuilt, true);
		assert.deepEqual(results.afterRebuild.raw.map(row => row.folderPath), ['Other']);
		assert.equal(results.healthy.savedAt, 200); assert.equal(results.quotaProblem, 'unavailable');
		assert.deepEqual(results.afterQuota, results.healthy);
		assert.equal(results.abortedWriteProblem, 'unavailable');
		assert.deepEqual(results.afterAbortedWrite, results.healthy);
		assert.equal(results.abortedRead, null); assert.equal(results.abortedReadProblem, 'unavailable');
		assert.equal(results.denied, null); assert.equal(results.deniedProblem, 'unavailable'); assert.equal(results.otherSession, null);
		assert.equal(results.future, null); assert.equal(results.futureProblem, 'unsupported'); assert.equal(results.futureReset, false);
		assert.deepEqual(results.futurePreserved, { version: 4, stores: ['future-store', 'snapshots'], raw: [results.snapshot] });
		assert.equal(results.blockedClear, false); assert.equal(results.afterClear.savedAt, 400);
		assert.equal(results.pending, 'local-only text must survive'); assert.equal(results.draft, results.pending);
		assert.deepEqual(errors, [], 'Cache failures must not leak unhandled promise rejections');
		console.log(`${browserType.name()}: native IndexedDB unsupported-format preservation, blocking, corruption, quota, session isolation and future-format preservation passed`);
	} finally { await browser.close(); }
}
