/* global reminderCache -- Injected browser bundle exposes the cache API for native IndexedDB tests. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

const { outputFiles } = await build({
	stdin: { contents: `export * from './src/pwa/reminders/cache/reminder-cache'; export { requirePrivateStorageUnlock, useUnencryptedStorage } from './src/pwa/storage/private-storage';`, resolveDir: process.cwd(), loader: 'ts' },
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
			const readStore = (store, query) => new Promise((resolve, reject) => {
				const request = indexedDB.open('crate-reminders');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result;
					const tx = db.transaction(store, 'readonly');
					const read = query === undefined ? tx.objectStore(store).getAll() : tx.objectStore(store).get(query);
					tx.oncomplete = () => { db.close(); resolve(read.result); };
				};
			});
			const stored = await readStore('snapshots', 'Reminders');
			const note = (id, filePath) => ({ ...reminder(id), filePath });
			// Only notes whose reminders changed are rewritten; a note another tab
			// replaced is rewritten too, so the metadata always matches the notes.
			await cache.saveCachedReminderSnapshot('Reminders', [note('a', 'Reminders/A.md'), note('b', 'Reminders/B.md')], ['Inbox'], 110, 'two-notes');
			const versions = async () => Object.fromEntries((await readStore('notes')).map(row => [row.path, row.version]));
			const before = await versions();
			await cache.saveCachedReminderSnapshot('Reminders', [note('a', 'Reminders/A.md'), note('b2', 'Reminders/B.md')], ['Inbox'], 120, 'one-changed');
			const afterPartial = await versions();
			// Replace note A; another tab also updates the metadata in the same transaction.
			const replaceNoteA = (withMetadata, nextVersion = 'other-tab') => new Promise((resolve, reject) => {
				const request = indexedDB.open('crate-reminders');
				request.onsuccess = () => {
					const db = request.result, tx = db.transaction(['notes', 'snapshots'], 'readwrite'), store = tx.objectStore('notes');
					const read = store.get(['Reminders', 'Reminders/A.md']);
					read.onsuccess = () => store.put({ ...read.result, version: nextVersion });
					if (withMetadata) {
						const snapshots = tx.objectStore('snapshots'), metadata = snapshots.get('Reminders');
						metadata.onsuccess = () => snapshots.put({ ...metadata.result,
							noteVersions: metadata.result.noteVersions.map(([path, version]) => [path, path === 'Reminders/A.md' ? nextVersion : version]) });
					}
					tx.oncomplete = () => { db.close(); resolve(); };
					tx.onerror = () => reject(tx.error);
				};
				request.onerror = () => reject(request.error);
			});
			await replaceNoteA(true);
			const peerWritten = await cache.loadCachedReminderSnapshot('Reminders');
			await replaceNoteA(true, 'other-tab-2');
			await cache.saveCachedReminderSnapshot('Reminders', [note('a', 'Reminders/A.md'), note('b2', 'Reminders/B.md')], ['Inbox'], 130, 'after-peer');
			const afterPeer = await versions();
			await replaceNoteA(false);
			const tampered = await cache.loadCachedReminderSnapshot('Reminders');
			await cache.saveCachedReminderSnapshot('Reminders', [note('a', 'Reminders/A.md'), note('b2', 'Reminders/B.md')], ['Inbox'], 140, 'after-tamper');
			const merged = await cache.loadCachedReminderSnapshot('Reminders');
			// A save reads no note records: the metadata lists the stored versions.
			const many = Array.from({ length: 50 }, (_, index) => note(`n${index}`, `Reminders/N${index}.md`));
			await cache.saveCachedReminderSnapshot('Reminders', many, ['Inbox'], 150, 'many');
			let noteRecordsRead = 0;
			const originals = {};
			for (const method of ['get', 'getAll', 'openCursor']) {
				originals[method] = IDBObjectStore.prototype[method];
				IDBObjectStore.prototype[method] = function (...args) {
					const request = originals[method].apply(this, args);
					if (this.name === 'notes') request.addEventListener('success', () => {
						noteRecordsRead += Array.isArray(request.result) ? request.result.length : request.result ? 1 : 0;
					});
					return request;
				};
			}
			try {
				await cache.saveCachedReminderSnapshot('Reminders', [...many.slice(1), note('changed', 'Reminders/N0.md')], ['Inbox'], 160, 'one-of-many');
			} finally {
				Object.assign(IDBObjectStore.prototype, originals);
			}
			const afterMany = await cache.loadCachedReminderSnapshot('Reminders');
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
            return { initial, refreshed, stored, before, afterPartial, peerWritten, afterPeer, tampered, merged, noteRecordsRead, afterMany, afterStaleRefresh, afterOldTimestamp, cleared, afterClear, missing, unsupported, preservedVersion, fresh };
		});
		assert.equal(result.initial.reminders[0].id, 'original');
		assert.equal(result.refreshed.savedAt, 200);
		assert.deepEqual(result.refreshed.issues, [{ path: 'Reminders/Large.md', reason: 'Source exceeds the reminder size limit' }]);
		assert.match(result.stored.sessionScope, /^[a-f0-9]{64}$/);
		assert.equal(result.stored.savedAt, 100, '304 must not rewrite the snapshot');
		assert.equal(result.stored.layout, 'notes');
		assert.equal(result.afterPartial['Reminders/A.md'], result.before['Reminders/A.md'], 'An unchanged note keeps its record');
		assert.notEqual(result.afterPartial['Reminders/B.md'], result.before['Reminders/B.md']);
		assert.deepEqual(result.peerWritten.reminders.map(item => item.id), ['a', 'b2'], 'Another tab\'s complete write is a valid snapshot');
		assert.notEqual(result.afterPeer['Reminders/A.md'], 'other-tab-2', 'A note another tab rewrote is rewritten');
		assert.equal(result.tampered, null, 'A note replaced outside the metadata rejects the whole snapshot');
		assert.deepEqual(result.merged.reminders.map(item => item.id), ['a', 'b2'], 'The next save repairs a rejected snapshot');
		assert.equal(result.noteRecordsRead, 0, 'A save must not read stored notes');
		assert.equal(result.afterMany.reminders.length, 50);
		assert.ok(result.afterMany.reminders.some(item => item.id === 'changed'));
		console.log(`${browserType.name()}: note records read by a 50-note save: ${result.noteRecordsRead}`);
		assert.equal(result.afterStaleRefresh.savedAt, 300);
		assert.equal(result.afterStaleRefresh.reminders[0].id, 'new');
		assert.equal(result.afterOldTimestamp.savedAt, 300);
		assert.equal(result.cleared, null);
		assert.equal(result.afterClear.savedAt, 50);
		assert.equal(result.missing, null);
		assert.equal(result.unsupported, null);
		assert.equal(result.preservedVersion, 1, 'Unsupported cache must remain untouched');
		assert.equal(result.fresh.reminders[0].id, 'fresh');
		const privacy = await page.evaluate(async () => {
			const cache = reminderCache;
			const count = store => new Promise((resolve, reject) => {
				const request = indexedDB.open('crate-reminders');
				request.onerror = () => reject(request.error);
				request.onsuccess = () => {
					const db = request.result, tx = db.transaction(store, 'readonly'), read = tx.objectStore(store).count();
					tx.oncomplete = () => { db.close(); resolve(read.result); };
				};
			});
			await cache.saveCachedReminderSnapshot('Private', [{ id: 'p', content: 'Plaintext task', priority: 4, completed: false, project: 'Inbox', filePath: 'Private/Inbox.md' }], ['Inbox'], 700, 'plain');
			await cache.refreshCachedReminderSnapshot('Private', 800, 'plain');
			const before = { notes: await count('notes'), freshness: await count('freshness') };
			cache.requirePrivateStorageUnlock();
			const loaded = await cache.loadCachedReminderSnapshot('Private');
			const after = { notes: await count('notes'), freshness: await count('freshness') };
			cache.useUnencryptedStorage();
			return { loaded, before, after };
		});
		assert.equal(privacy.loaded, null);
		assert.ok(privacy.before.notes > privacy.after.notes, 'Plaintext notes are removed once private storage is required');
		assert.ok(privacy.before.freshness > privacy.after.freshness, 'Plaintext freshness records are removed too');
		console.log(`${browserType.name()}: cache creation, per-note partial writes, peer-replaced notes, metadata-only refresh, revision guards, clearing and private storage cleanup passed`);
	} finally {
		await browser.close();
	}
}
