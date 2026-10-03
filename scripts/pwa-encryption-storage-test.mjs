import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';
import { verifyBlockedEncryptionStorage } from './pwa-encryption-blocked-storage-checks.mjs';
import { verifyFolderKeyFollowing } from './pwa-encryption-folder-storage-checks.mjs';
import { buildEncryptedPushWorker, verifyEncryptedPushWorker } from './pwa-encrypted-push-checks.mjs';

// Exercise the production session hook and native CryptoKey/IDB persistence.
// Only cache completion is delayed, to make the logout/re-enrollment race deterministic.
const harness = (await build({ stdin: { contents: `
export * from './src/encryption/key-bundle';
export * from './src/encryption/scope-binding';
export * from './src/encryption/server-state';
export * from './src/pwa/encryption-keys';
export * from './src/pwa/encrypted-reminder-attempts';
export * from './src/encryption/reminder-projection';
export * from './src/pwa/encrypted-push';
export * from './src/pwa/encryption-session';
export * from './src/pwa/session-generation';
export { unlockPrivateStorage } from './src/pwa/private-storage';
export { AUTH_TOKEN_KEY } from './src/pwa/config';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { usePwaSessionLifecycle } from './src/pwa/hooks/usePwaSessionLifecycle';
const noop = () => {};
function Harness() {
 window.lifecycle = usePwaSessionLifecycle({ apiFetch: async () => Response.json({}),
  resetView: noop, disablePushNotifications: async () => {},
  handleUnauthorizedRef: {current:noop}, setAuthToken: noop,
  setConfig: noop, reportError: noop, setSettingsOpen: noop, showToast: noop });
 return null;
}
export function mountLifecycle() { createRoot(document.getElementById('root')).render(<Harness />); }
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', globalName: 'encryptionStorageTest',
platform: 'browser', target: 'es2022', alias: { obsidian: resolve('src/test/mocks/obsidian.ts') }, plugins: [{ name: 'delay-cache-cleanup', setup(build) {
	build.onLoad({ filter: /src\/pwa\/reminder-cache\.ts$/ }, () => ({ contents: 'export async function clearCachedReminderSnapshots() { await window.cacheGate; return true; }', loader: 'js' }));
} }] })).outputFiles[0].text;
const pushWorker = await buildEncryptedPushWorker();
const server = createServer((req, res) => {
	if (req.url === '/encrypted-push-worker.js') {
		res.setHeader('Content-Type', 'application/javascript'); res.end(pushWorker); return;
	}
	res.setHeader('Content-Type', req.url === '/harness.js' ? 'application/javascript' : 'text/html');
	res.end(req.url === '/harness.js' ? harness : '<!doctype html><div id="root"></div><script src="/harness.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function verifyKeyRecovery(page) {
	const result = await page.evaluate(async () => {
		const t = window.encryptionStorageTest;
		const grant = t.createReminderKeyGrant(t.addReminderScope(t.createVaultKeyBundle(), 'Reminders'), 'Reminders');
		const stored = await t.rememberReminderKeys(grant);
		const cipher = await t.unlockLocalState(stored);
		const pending = cipher.seal('unsent draft survives recovery', 'test-draft');
		const db = await new Promise((resolve, reject) => { const r = indexedDB.open('crate-encryption-keys', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
		const key = `${grant.vaultId}:${grant.scope.id}`;
		const put = record => new Promise((resolve, reject) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(record, key); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
		const read = () => new Promise((resolve, reject) => { const r = db.transaction('keys').objectStore('keys').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
		let repaired = 0, preserved = 0;
		try {
			const movedGrant = { ...grant, generation: grant.generation + 1, scope: { ...grant.scope, folderPath: 'Tasks' } };
			const moved = await t.rememberReminderKeys(movedGrant);
			if (moved.folderPath !== 'Tasks' || (await t.unlockLocalState(moved)).open(pending, 'test-draft') !== 'unsent draft survives recovery') throw new Error('Folder move lost the local draft key');
			let staleRejected = false; try { await t.rememberReminderKeys(grant); } catch { staleRejected = true; }
			if (!staleRejected || (await read()).folderPath !== 'Tasks') throw new Error('Old enrollment reversed a folder move');
			for (const damage of [{ notifications: null }, { notificationFingerprint: null }, { data: null }, { data: { id: stored.data.id, key: { type: 'secret', extractable: false } } }]) {
				await put({ ...stored, ...damage });
				let locked = false; try { await t.readReminderKeys(grant.vaultId, grant.scope.id); } catch { locked = true; }
				if (!locked) throw new Error('Damaged keys were accepted without recovery');
				await t.rememberReminderKeys(grant);
				const restored = await t.readReminderKeys(grant.vaultId, grant.scope.id);
				if ((await t.unlockLocalState(restored)).open(pending, 'test-draft') !== 'unsent draft survives recovery') throw new Error('Recovery replaced the local draft key');
				repaired++;
			}
			const wrongSecret = t.createReminderKeyGrant(t.addReminderScope(t.createVaultKeyBundle(), 'Reminders'), 'Reminders').scope.data.secret;
			for (const [record, recovery] of [
				[{ ...stored, localState: 'damaged wrapped key' }, grant],
				[{ ...stored, version: 2 }, grant],
				[{ ...stored, generation: grant.generation + 1 }, grant],
				[{ ...stored, vaultId: crypto.randomUUID() }, grant],
				[{ ...stored, folderPath: 'Other' }, grant],
				[stored, { ...movedGrant, scope: { ...movedGrant.scope, data: { ...grant.scope.data, id: crypto.randomUUID() } } }],
				[stored, { ...grant, scope: { ...grant.scope, data: { ...grant.scope.data, secret: wrongSecret } } }],
			]) {
				await put(record);
				let rejected = false; try { await t.rememberReminderKeys(recovery); } catch { rejected = true; }
				const after = await read();
				if (!rejected || JSON.stringify(after) !== JSON.stringify(record)) throw new Error('Unsafe recovery replaced the original record');
				preserved++;
			}
			await put({ ...stored, notifications: null });
			let rejected = false;
			try { await t.rememberReminderKeys(grant, () => false); } catch { rejected = true; }
			if (!rejected || (await read()).notifications !== null) throw new Error('Stale recovery wrote keys');
		} finally { db.close(); }
		return { repaired, preserved };
	});
	assert.deepEqual(result, { repaired: 4, preserved: 7 });
}

async function verifyLogout(browser) {
	const context = await browser.newContext();
	try {
		const leaving = await context.newPage(), peer = await context.newPage();
		await leaving.goto(origin); await peer.goto(origin);
		await leaving.evaluate(() => window.encryptionStorageTest.mountLifecycle());
		await leaving.waitForFunction(() => window.lifecycle);
		const grant = await peer.evaluate(async () => {
			const t = window.encryptionStorageTest;
			localStorage.setItem(t.AUTH_TOKEN_KEY, 'old-test-session');
			const grant = t.createReminderKeyGrant(t.addReminderScope(t.createVaultKeyBundle(), 'Reminders'), 'Reminders');
			await t.rememberReminderKeys(grant);
			return grant;
		});
		await leaving.evaluate(() => {
			window.cacheGate = new Promise(resolve => { window.releaseCache = resolve; });
			window.logout = window.lifecycle.clearLocalSession();
		});
		await peer.evaluate(async grant => {
			const t = window.encryptionStorageTest;
			localStorage.setItem(t.AUTH_TOKEN_KEY, 'new-test-session'); t.invalidatePwaSession();
			const keys = await t.rememberReminderKeys(grant, t.capturePwaSession());
			const cipher = await t.unlockLocalState(keys);
			t.unlockPrivateStorage(cipher, keys.folderPath, localStorage, sessionStorage);
			sessionStorage.setItem('crate-reminder-draft:Reminders:test', cipher.seal('new unsent draft', 'test-draft'));
			await t.saveEncryptedReminderAttempt(`${keys.vaultId}:${keys.scopeId}:test-attempt`, { semanticHash: 'a'.repeat(64), body: 'original immutable request' }, undefined, t.capturePwaSession());
		}, grant);
		await leaving.evaluate(async () => { window.releaseCache(); await window.logout; });
		await peer.reload();
		await peer.evaluate(async grant => {
			const t = window.encryptionStorageTest;
			if (localStorage.getItem(t.AUTH_TOKEN_KEY) !== 'new-test-session') throw new Error('Logout removed the replacement session');
			const keys = await t.readReminderKeys(grant.vaultId, grant.scope.id);
			if (!keys) throw new Error('Logout removed replacement keys');
			const cipher = await t.unlockLocalState(keys);
			t.unlockPrivateStorage(cipher, keys.folderPath, localStorage, sessionStorage);
			if (cipher.open(sessionStorage.getItem('crate-reminder-draft:Reminders:test'), 'test-draft') !== 'new unsent draft') throw new Error('New draft became unrecoverable after reload');
			if ((await t.loadEncryptedReminderAttempt(`${keys.vaultId}:${keys.scopeId}:test-attempt`))?.body !== 'original immutable request') throw new Error('Logout removed the new immutable attempt');
			// A session change during the deletion transaction must roll back clear().
			for (const clear of [t.clearReminderKeys, t.clearEncryptedReminderAttempts]) {
				let checks = 0;
				await clear(() => ++checks < 3);
				checks = 0;
				let failed = false;
				try { await clear(() => { if (++checks === 3) throw new Error('Session storage unavailable'); return true; }); }
				catch (error) { if (error.message !== 'Session storage unavailable') throw error; failed = true; }
				if (!failed) throw new Error('Unconfirmed erasure was not reported');
			}
			if (!await t.readReminderKeys(grant.vaultId, grant.scope.id) || !await t.loadEncryptedReminderAttempt(`${keys.vaultId}:${keys.scopeId}:test-attempt`)) throw new Error('Stale transaction committed a deletion');
		}, grant);
		// Repeated sign-out events may advance the generation while cleanup waits.
		// With no replacement session, a current logout must still erase both stores.
		await leaving.evaluate(async () => {
			window.cacheGate = new Promise(resolve => { window.releaseCache = resolve; });
			const logout = window.lifecycle.clearLocalSession();
			window.encryptionStorageTest.invalidatePwaSession();
			window.releaseCache(); await logout;
		});
		await peer.evaluate(async grant => {
			const t = window.encryptionStorageTest;
			if (await t.readReminderKeys(grant.vaultId, grant.scope.id) || await t.loadEncryptedReminderAttempt(`${grant.vaultId}:${grant.scope.id}:test-attempt`)) throw new Error('Current logout did not remove private data');
		}, grant);
	} finally { await context.close(); }
}

try {
	for (const type of [chromium, webkit]) {
		const browser = await type.launch();
		try {
			const page = await browser.newPage(); await page.goto(origin);
			await verifyKeyRecovery(page); await verifyFolderKeyFollowing(page);
			await verifyEncryptedPushWorker(page, origin); await page.close();
			await verifyLogout(browser);
			const blocked = await browser.newPage(), errors = [];
			blocked.on('pageerror', error => errors.push(error.message));
			await blocked.goto(origin); await verifyBlockedEncryptionStorage(blocked); await blocked.close();
			assert.deepEqual(errors, []);
			console.log(`${type.name()}: key recovery, logout fencing, bounded blocked storage, service-worker push decryption and fallback, late-open fencing and future-format preservation passed`);
		} finally { await browser.close(); }
	}
} finally { await new Promise(resolve => server.close(resolve)); }
