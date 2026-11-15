/* global versionedDatabase -- Test bundle exposes the production database opener in the browser. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

// Native IndexedDB upgrade path for browser databases: ordered steps run in one upgrade
// transaction, a failed step keeps the previous version's data, and layouts this build
// cannot vouch for are preserved instead of upgraded.
const { outputFiles } = await build({ stdin: { contents: `export { openVersionedDatabase } from './src/pwa/storage/single-store-database';`, resolveDir: process.cwd() },
	bundle: true, format: 'iife', globalName: 'versionedDatabase', write: false });

for (const browserType of [chromium, webkit]) {
	const browser = await browserType.launch();
	try {
		const page = await browser.newPage();
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage upgrade</title>' }));
		await page.goto('https://pwa-storage-upgrade.test');
		await page.addScriptTag({ content: outputFiles[0].text });
		const results = await page.evaluate(async () => {
			const { openVersionedDatabase } = versionedDatabase;
			const done = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
			const remove = name => done(indexedDB.deleteDatabase(name));
			const rawOpen = (name, version, upgrade) => new Promise((resolve, reject) => {
				const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
				request.onupgradeneeded = () => upgrade?.(request.result);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			/** Version, stores and every record, read without upgrading. */
			const inspect = async name => {
				const db = await rawOpen(name);
				try {
					const stores = Array.from(db.objectStoreNames).sort();
					const records = {};
					for (const store of stores) {
						const tx = db.transaction(store, 'readonly');
						records[store] = await done(tx.objectStore(store).getAll());
					}
					return { version: db.version, stores, records };
				} finally { db.close(); }
			};
			const seedVersionOne = async (name, extraStore) => {
				await remove(name);
				const db = await rawOpen(name, 1, db => {
					db.createObjectStore('values');
					if (extraStore) db.createObjectStore(extraStore);
				});
				const tx = db.transaction('values', 'readwrite');
				tx.objectStore('values').put({ text: 'first', count: 1 }, 'a');
				tx.objectStore('values').put({ text: 'second', count: 2 }, 'b');
				await new Promise(resolve => { tx.oncomplete = resolve; });
				db.close();
			};
			const failures = [];
			const open = (name, versions) => openVersionedDatabase(name, versions, { fail: reason => { failures.push(reason); return new Error(reason); } })
				.then(db => { db.close(); return 'opened'; }, error => error.message);

			const v1 = { stores: [{ name: 'values' }] };
			// Version 2 moves each value into a keyed `items` store and doubles its count.
			const v2 = { stores: [{ name: 'items', keyPath: 'id' }], upgrade: (db, tx) => {
				const items = db.createObjectStore('items', { keyPath: 'id' });
				const cursor = tx.objectStore('values').openCursor();
				cursor.onsuccess = () => {
					const current = cursor.result;
					if (!current) { db.deleteObjectStore('values'); return; }
					items.put({ id: current.key, ...current.value, count: current.value.count * 2 });
					current.continue();
				};
			} };
			const v3 = { stores: [{ name: 'items', keyPath: 'id' }, { name: 'meta' }], upgrade: db => { db.createObjectStore('meta'); } };

			const out = {};
			await remove('fresh');
			out.fresh = await open('fresh', [v1, v2, v3]);
			out.freshState = await inspect('fresh');

			await seedVersionOne('current');
			out.current = await open('current', [v1]);
			out.currentState = await inspect('current');

			await seedVersionOne('upgrade');
			out.upgrade = await open('upgrade', [v1, v2, v3]);
			out.upgradeState = await inspect('upgrade');
			// Reopening the upgraded database runs no step again.
			out.reopen = await open('upgrade', [v1, v2, v3]);

			await seedVersionOne('failing');
			const failing = { stores: [{ name: 'items', keyPath: 'id' }], upgrade: (db, tx) => {
				v2.upgrade(db, tx);
				// A duplicate key fails a request, which aborts the whole upgrade transaction.
				const items = tx.objectStore('items');
				items.add({ id: 'dup' }); items.add({ id: 'dup' });
			} };
			out.failing = await open('failing', [v1, failing]);
			out.failingState = await inspect('failing');

			await seedVersionOne('throwing');
			out.throwing = await open('throwing', [v1, { ...v2, upgrade: () => { throw new Error('step failed'); } }]);
			out.throwingState = await inspect('throwing');

			await seedVersionOne('unknown-layout', 'stranger');
			out.unknownLayout = await open('unknown-layout', [v1, v2]);
			out.unknownLayoutState = await inspect('unknown-layout');

			await seedVersionOne('missing-step');
			out.missingStep = await open('missing-step', [v1, { stores: v2.stores }]);
			out.missingStepState = await inspect('missing-step');

			await remove('newer');
			const newer = await rawOpen('newer', 5, db => db.createObjectStore('values'));
			newer.close();
			out.newer = await open('newer', [v1, v2]);
			out.newerVersion = (await inspect('newer')).version;
			out.failures = failures;
			return out;
		});

		const original = [{ text: 'first', count: 1 }, { text: 'second', count: 2 }];
		const kept = { version: 1, stores: ['values'], records: { values: original } };
		assert.equal(results.fresh, 'opened');
		assert.deepEqual(results.freshState, { version: 3, stores: ['items', 'meta'], records: { items: [], meta: [] } });
		assert.equal(results.current, 'opened');
		assert.deepEqual(results.currentState, kept);
		assert.equal(results.upgrade, 'opened');
		assert.deepEqual(results.upgradeState, { version: 3, stores: ['items', 'meta'], records: {
			items: [{ id: 'a', text: 'first', count: 2 }, { id: 'b', text: 'second', count: 4 }], meta: [] } });
		assert.equal(results.reopen, 'opened');
		assert.equal(results.failing, 'unavailable');
		assert.deepEqual(results.failingState, kept);
		assert.equal(results.throwing, 'unavailable');
		assert.deepEqual(results.throwingState, kept);
		assert.equal(results.unknownLayout, 'unsupported');
		assert.deepEqual(results.unknownLayoutState, { version: 1, stores: ['stranger', 'values'], records: { stranger: [], values: original } });
		assert.equal(results.missingStep, 'unsupported');
		assert.deepEqual(results.missingStepState, kept);
		assert.equal(results.newer, 'unsupported');
		assert.equal(results.newerVersion, 5);
		assert.deepEqual(results.failures, ['unavailable', 'unavailable', 'unsupported', 'unsupported', 'unsupported']);
		assert.deepEqual(errors, []);
		console.log(`${browserType.name()}: native IndexedDB ordered upgrades, failed-step rollback and unsupported-layout preservation passed`);
	} finally {
		await browser.close();
	}
}
