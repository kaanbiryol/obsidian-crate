import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { openLocalRuntime, issueLocalDevice } from '../packages/server/src/local-server-runtime.mjs';
import { listenLocalServer } from '../packages/server/src/local-server-http.mjs';
import { verifyEncryptionReset } from './pwa-encryption-reset-checks.mjs';
import { verifyEncryptedAttemptCleanup } from './pwa-encryption-cleanup-checks.mjs';
import { verifyReminderFolderMove } from './pwa-reminder-folder-move-checks.mjs';

if (process.env.CRATE_PWA_PREBUILT !== '1') {
	const result = spawnSync(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'inherit' });
	if (result.status !== 0) throw new Error('Worker build failed');
}
const harness = (await build({ stdin: { contents: `
export * from './src/encryption/key-bundle';

export * from './src/encryption/file-codec';
export * from './src/encryption/file-authority';
export * from './src/encryption/reminder-projection';
export * from './src/sync/encryption-conversion';
export * from './src/sync/encryption-reset';
export * from './src/sync/worker-api/http';
export * from './src/sync/api';
export * from './src/sync/encrypted-files';
export * from './src/sync/worker-api/sync';
export * from './src/sync/durable-restores';
export { makeApiFetch } from './src/pwa/api';
export { AUTH_TOKEN_KEY } from './src/pwa/config';
export * from './src/pwa/encrypted-push';
export * from './src/pwa/encryption-keys';
export * from './src/pwa/encrypted-reminder-attempts';
export { unlockPrivateStorage } from './src/pwa/private-storage';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'crateEncryptionTest', platform: 'browser', target: 'es2022', alias: { obsidian: resolve('src/test/mocks/obsidian.ts') } })).outputFiles[0].text;

async function verify(type) {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-e2ee-browser-'));
	const runtime = await openLocalRuntime({ dataDir });
	const replays = []; let faultPhase = 'none', offlineApis = false;
	// Inject faults at the HTTP boundary: WebKit does not reliably route requests
	// owned by an installed service worker through Playwright's route handlers.
	const server = await listenLocalServer({ origin: runtime.origin, mf: { dispatchFetch: async (url, init) => {
		// Only the app is offline; its Obsidian peer must still be able to move
		// folders on the server before the app reconnects.
		if (offlineApis && new Headers(init.headers).get('Authorization') !== `Bearer ${owner.token}`
			&& /^\/(encryption|reminders|sync|settings|\.well-known)(\/|$)/.test(new URL(url).pathname)) return Response.json({ error: 'Injected offline API' }, { status: 503 });
		if (new URL(url).pathname === '/test-encryption-harness.js') return new Response(harness, { headers: { 'Content-Type': 'application/javascript' } });
		if (new URL(url).pathname !== '/reminders/encrypted-commit' || faultPhase === 'none') return runtime.mf.dispatchFetch(url, init);
		const body = await new Response(init.body).text(); replays.push(body);
		if (faultPhase === 'before') return Response.json({ error: 'Injected disconnect before commit' }, { status: 503 });
		const response = await runtime.mf.dispatchFetch(url, { ...init, body });
		if (faultPhase === 'after') { faultPhase = 'retry'; await response.arrayBuffer(); return Response.json({ error: 'Injected lost commit response' }, { status: 503 }); }
		return response;
	} } }, { port: 0 });
	const bucket = await runtime.mf.getR2Bucket('BUCKET');
	const origin = `http://127.0.0.1:${server.address().port}`;
	const browser = await type.launch();
	const adminContext = await browser.newContext();
	const admin = await adminContext.newPage();
	const owner = await issueLocalDevice(runtime.db, 'Encryption integration');
	const info = await (await fetch(`${origin}/.well-known/crate`)).json();
	const headers = { Authorization: `Bearer ${owner.token}`, 'X-Crate-Protocol': String(info.protocol.current), 'Content-Type': 'application/json' };
	const operation = () => `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${randomUUID()}`;
	const legacyUploads = [];
	const plain = '# Inbox\n\nPrivate surrounding note text\n\n- [ ] Encrypted appointment 2099-01-02 <!-- crate-id:r1 -->\n';
	const upload = async (path, content, previous = 'absent') => {
		const bytes = Buffer.from(content), hash = createHash('sha256').update(bytes).digest('hex'), operationId = operation();
		const response = await fetch(`${origin}/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: bytes, headers: {
			...headers, 'Content-Type': 'text/markdown', 'X-File-Hash': hash, 'X-File-Size': String(bytes.length), 'X-Crate-Expected-Hash': previous, 'X-Crate-Upload-Operation': operationId,
		} });
		assert.equal(response.status, 200, await response.text());
		legacyUploads.push({ operationId, payload: { path, hash, size: bytes.length, contentType: 'text/markdown', expectedHash: previous === 'absent' ? null : previous } });
		return hash;
	};
	let context;
	try {
		await upload('Reminders/Inbox.md', plain);
		const previous = await upload('Private.md', 'Retained secret paragraph');
		await upload('Private.md', 'Current secret paragraph', previous);
		const legacyId = operation();
		const legacyCreate = { operationId: legacyId, id: legacyId, folderPath: 'Reminders', project: 'Inbox', content: 'Accepted before conversion', priority: 4 };
		const oldCreate = await fetch(`${origin}/reminders/create`, { method: 'POST', headers, body: JSON.stringify(legacyCreate) });
		assert.equal(oldCreate.status, 200, await oldCreate.clone().text());
		const oldCreateReceipt = await oldCreate.json();
		// Valid plaintext settings larger than the former encrypted envelope limit
		// must convert, resume and remain editable through the production client.
		const seedSettings = { ignorePatterns: Array.from({ length: 2000 }, (_, index) => `Excluded/project-${String(index).padStart(4, '0')}/archive/`), syncOnStartup: true, syncOnResume: true, syncInterval: 300, pushEnabled: false };
		const initialSettings = type.name() === 'chromium' ? null : seedSettings;
		if (initialSettings) {
			const settings = await fetch(`${origin}/settings`, { method: 'PUT', headers, body: JSON.stringify({ settings: initialSettings, expectedVersion: null }) });
			assert.equal(settings.status, 200, await settings.text());
		}
		const checkpoint = await fetch(`${origin}/sync/checkpoints`, { method: 'POST', headers, body: '{}' });
		assert.equal(checkpoint.status, 200, await checkpoint.clone().text());
		const checkpointId = (await checkpoint.json()).checkpoint.id;
		await admin.goto(`${origin}/health`);
		await admin.addScriptTag({ content: harness });
		const enrolled = await admin.evaluate(async ({ origin, token, checkpointId, legacyUploads, initialSettings, seedSettings }) => {
			const t = window.crateEncryptionTest;
			const bundle = t.addReminderScope(t.createVaultKeyBundle(), 'Reminders');
			const recovery = await t.generateRecoveryCode();
			let loseResponse = true, loseRestoreResponse = false;
			const restoreBodies = [];
			const transport = async request => {
				if (request.url.endsWith('/sync/restore-version')) restoreBodies.push(request.body);
				const response = await fetch(request.url, { method: request.method, body: request.body, headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
				const buffer = await response.arrayBuffer();
				if (loseResponse && request.method === 'PUT' && request.url.includes('/conversion/file?')) { loseResponse = false; throw new Error('Injected lost conversion response'); }
				if (loseRestoreResponse && request.url.endsWith('/sync/restore-version')) { loseRestoreResponse = false; throw new Error('Injected lost restore response'); }
				return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: buffer, text: new TextDecoder().decode(buffer) };
			};
			const http = new t.WorkerApiHttpClient(origin, token, transport);
			try { await t.convertEncryptedVault(http, bundle, recovery, () => {}); throw new Error('Expected injected response loss'); }
			catch (error) { if (!error.message.includes('Injected lost')) throw error; }
			if ((await t.readServerEncryption(http)).mode !== 'converting') throw new Error('Interrupted conversion was not retained');
			await t.convertEncryptedVault(http, bundle, recovery, () => {});
			const recovered = await t.openRecoveryBundle((await t.readServerEncryption(http)).recovery, recovery);
			if (JSON.stringify(recovered) !== JSON.stringify(bundle)) throw new Error('Vault recovery failed');
			const api = new t.SyncApiClient(origin, token, transport); await api.configureEncryption(bundle);
			if (JSON.stringify((await api.getSharedSettings()).settings) !== JSON.stringify(initialSettings)) throw new Error('Converted shared settings did not round-trip');
			// A new client must obtain the converted version even when no settings existed.
			const settingsWriter = new t.SyncApiClient(origin, token, transport); await settingsWriter.configureEncryption(bundle);
			await settingsWriter.putSharedSettings(seedSettings);
			if (JSON.stringify((await api.getSharedSettings()).settings) !== JSON.stringify(seedSettings)) throw new Error('First encrypted settings write failed');
			const files = await t.EncryptedFiles.create(http, bundle, async () => null);
			for (const old of legacyUploads) {
				const receipt = await files.resolveLegacyOperation(old.operationId, old.payload);
				if (!receipt.success || receipt.hash !== old.payload.hash) throw new Error('Pre-conversion upload receipt was lost');
			}
			if (new TextDecoder().decode((await api.downloadFile('Private.md')).content) !== 'Current secret paragraph') throw new Error('Current note did not decrypt');
			const history = await api.listFileVersions({ path: 'Private.md' });
			if (new TextDecoder().decode(await api.previewFileVersion(history.versions[0])) !== 'Retained secret paragraph') throw new Error('Retained history did not decrypt');
			const snapshot = await api.sharedHistory.load(checkpointId);
			if (!snapshot.files['Private.md']) throw new Error('Encrypted checkpoint was lost');
			const manifest = await api.getManifest();
			if (manifest.files['Private.md'].size !== 24) throw new Error('Plaintext metadata was not recovered');
			// The actual restore endpoint must receive ciphertext preconditions and
			// retain its original receipt across a client restart after response loss.
			const restoreApi = new t.SyncWorkerApi(http); restoreApi.setEncryption(files);
			let intents = [];
			const journal = { getRestoreIntents: () => structuredClone(intents),
				setRestoreIntent: intent => { intents = [structuredClone(intent)]; }, removeRestoreIntent: () => { intents = []; }, save: async () => {} };
			loseRestoreResponse = true;
			try { await new t.DurableRestores(journal, restoreApi).restore(history.versions[0]); throw new Error('Expected lost restore response'); }
			catch (error) { if (!error.message.includes('Injected lost restore response')) throw error; }
			if (intents[0]?.phase !== 'pending' || !intents[0].encryptedWire) throw new Error('Encrypted restore intent was not retained');
			await new t.DurableRestores(journal, restoreApi).restore(history.versions[0]);
			if (restoreBodies.length !== 2 || restoreBodies[0] !== restoreBodies[1] || intents[0].phase !== 'committed') throw new Error('Restore replay changed its original request');
			if (new TextDecoder().decode((await api.downloadFile('Private.md')).content) !== 'Retained secret paragraph') throw new Error('Encrypted restore did not recover the original bytes');
			window.encryptedTestApi = api;
			window.encryptedTestKeys = bundle;
			window.encryptedTestRecovery = recovery;
			return { ...(await api.createRemindersEnrollmentToken('Reminders')), grant: recovery, scope: t.createReminderKeyGrant(bundle, 'Reminders') };
		}, { origin, token: owner.token, checkpointId, legacyUploads, initialSettings, seedSettings });
		const rows = await runtime.db.prepare('SELECT storage_key FROM files UNION SELECT storage_key FROM file_versions').all();
		for (const row of rows.results) {
			const text = await (await bucket.get(row.storage_key)).text();
			assert.ok(text.startsWith('CRATE-E2EE/1\n')); assert.ok(!text.includes('secret paragraph')); assert.ok(!text.includes('Private surrounding'));
		}
		const rawSettings = await runtime.db.prepare("SELECT value FROM maintenance_state WHERE key = 'e2ee:settings'").first();
		assert.ok(!rawSettings.value.includes('secret-pattern'));
		context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		// Native offline navigation in Playwright WebKit fails before its service
		// worker runs. Chromium covers real offline navigation; WebKit covers the
		// same launch policy with an offline signal and unavailable data APIs.
		if (type === webkit) await context.addInitScript(() => {
			// Native push queries freeze headless WebKit on this host, including
			// an empty-page reproduction. SW/storage remain real; push needs devices.
			Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get: () => undefined });
			Object.defineProperty(navigator, 'onLine', { get: () => sessionStorage.getItem('crate-test-offline') !== '1', configurable: true });
		});
		const page = await context.newPage();
		await page.bringToFront();
		const setOffline = async value => {
			if (type === chromium) await context.setOffline(value);
			else { offlineApis = value; await page.evaluate(value => { sessionStorage.setItem('crate-test-offline', value ? '1' : '0'); window.dispatchEvent(new Event(value ? 'offline' : 'online')); }, value); }
		};
		const errors = []; page.on('pageerror', error => { errors.push(error.message); if (process.env.CRATE_TEST_DEBUG === '1') console.log('PWA pageerror:', error.message, error.stack); });
		if (process.env.CRATE_TEST_DEBUG === '1') {
			page.on('framenavigated', frame => { if (frame === page.mainFrame()) console.log('PWA navigation:', new URL(frame.url()).pathname); });
			page.on('crash', () => console.log('PWA page crashed'));
			page.on('request', request => console.log('PWA request:', request.method(), new URL(request.url()).pathname));
			page.on('response', response => console.log('PWA response:', response.status(), new URL(response.url()).pathname));
			page.on('requestfailed', request => console.log('PWA request failed:', new URL(request.url()).pathname, request.failure()));
		}
		let recoverySent = false;
		const requests = []; page.on('request', request => { if ((request.url() + (request.postData() ?? '')).includes(enrolled.grant)) recoverySent = true; if (request.method() !== 'GET') requests.push({ url: request.url(), body: request.postData() }); });
		await page.goto(`${origin}/notifications?browserToken=${enrolled.browserToken}&folder=Reminders&tab=inbox#crateKey=${encodeURIComponent(enrolled.grant)}`);
		try { await expect(page.getByText('Encrypted appointment', { exact: true })).toBeVisible({ timeout: 20000 }); }
		catch (error) {
			console.log('PWA bootstrap errors:', errors);
			console.log('PWA bootstrap:', await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'Body unavailable'));
			await mkdir('.generated/browser-encryption', { recursive: true });
			await page.screenshot({ path: '.generated/browser-encryption/bootstrap-failure.png', fullPage: true, timeout: 2000 }).catch(() => {});
			throw error;
		}
		assert.ok(!page.url().includes('crateKey'));
		await page.locator('[data-action="toggle-settings"]').click();
		await expect(page.getByRole('region', { name: 'Encryption', exact: true }).locator('.settings-row').filter({ has: page.getByText('Reminders', { exact: true }) }).getByText('Unlocked', { exact: true })).toBeVisible();
		await page.getByText('Encryption details', { exact: true }).click();
		await expect(page.getByText('Notification keys ready', { exact: true })).toBeVisible();
		await mkdir('.generated/browser-encryption', { recursive: true });
		await page.screenshot({ path: `.generated/browser-encryption/${type.name()}-status.png`, fullPage: true });
		await page.getByRole('button', { name: 'Close settings', exact: true }).click();
		await page.locator('[data-action="open-create-modal"]').click();
		await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Private browser task');
		await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
		await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveCount(0);
		await expect(page.getByText('Private browser task', { exact: true })).toBeVisible();
		await expect.poll(() => requests.some(request => request.url.endsWith('/reminders/encrypted-commit'))).toBe(true);
		assert.ok(requests.every(request => !request.body?.includes('Private browser task')));
		await page.reload();
		await expect(page.getByText('Private browser task', { exact: true })).toBeVisible();
		// An interrupted save survives an offline reload, and
		// replays the same encrypted attempt after an accepted response is lost.
		await page.waitForFunction(() => !!navigator.serviceWorker.controller);
		faultPhase = 'before';
		await page.locator('[data-action="open-create-modal"]').click();
		await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Offline encrypted task');
		await page.getByRole('button', { name: 'Add reminder', exact: true }).click();
		try { await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toHaveCount(0); }
		catch (error) { console.log('Offline editor:', await page.locator('body').innerText(), errors); throw error; }
		await expect(page.locator('.premium-reminder-title').filter({ hasText: /^Offline encrypted task$/ })).toBeVisible();
		await expect.poll(() => replays.length).toBeGreaterThanOrEqual(1);
		await setOffline(true);
		const storage = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
		assert.ok(!storage.local.includes('Offline encrypted task')); assert.ok(!storage.session.includes('Offline encrypted task'));
		assert.ok(storage.local.includes('crate-local-e2ee-v1.'));
		await page.reload();
		await expect(page.locator('.premium-reminder-title').filter({ hasText: /^Offline encrypted task$/ })).toBeVisible({ timeout: 15000 });
		faultPhase = 'after';
		await setOffline(false);
		await expect.poll(() => replays.length, { timeout: 20000 }).toBeGreaterThanOrEqual(3);
		assert.equal(replays[0], replays[1]);
		assert.equal(replays[1], replays[2]);
		assert.ok(!replays[0].includes('Offline encrypted task'));
		await page.reload();
		await expect(page.locator('.premium-reminder-title').filter({ hasText: /^Offline encrypted task$/ })).toBeVisible();
		await page.addScriptTag({ url: `${origin}/test-encryption-harness.js` });
		const replayedLegacy = await page.evaluate(async body => {
			const t = window.crateEncryptionTest;
			const api = t.makeApiFetch(localStorage.getItem(t.AUTH_TOKEN_KEY), () => {});
			const response = await api('/reminders/create', { method: 'POST', body: JSON.stringify(body) });
			if (!response.ok) throw new Error(await response.text());
			return response.json();
		}, legacyCreate);
		assert.deepEqual(replayedLegacy, oldCreateReceipt);
		await verifyEncryptedAttemptCleanup(page, enrolled.scope, info.reminderOperationDay);
		const notification = await admin.evaluate(async () => {
			const t = window.crateEncryptionTest, bundle = window.encryptedTestKeys;
			const projection = await t.createReminderProjection(bundle, 'Reminders/Inbox.md', new TextEncoder().encode('- [ ] Private push title 2099-01-02 <!-- crate-id:push-test -->').buffer);
			return projection.reminders[0].notification;
		});
		await page.evaluate(async notice => {
			const t = window.crateEncryptionTest;
			const keys = await t.readReminderKeys(notice.vaultId, notice.scopeId);
			if (keys.data.key.extractable || keys.notifications.key.extractable || keys.data.secret || keys.notifications.secret) throw new Error('Browser persisted extractable keys');
			if ((await t.decryptPushDisplay(notice))?.title !== 'Private push title') throw new Error('Remembered keys cannot decrypt notifications');
			if (await t.decryptPushDisplay({ ...notice, reminderId: 'substitution' }) !== null) throw new Error('Notification context substitution accepted');
		}, notification);
		const persisted = await page.evaluate(async () => {
			const result = [];
			for (const { name } of await indexedDB.databases()) {
				const db = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
				for (const store of db.objectStoreNames) result.push(await new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }));
				db.close();
			}
			return JSON.stringify(result);
		});
		assert.ok(!persisted.includes('Private browser task')); assert.ok(!persisted.includes('Offline encrypted task')); assert.ok(!persisted.includes('Encrypted appointment'));
		await admin.evaluate(async () => {
			const text = new TextDecoder().decode((await window.encryptedTestApi.downloadFile('Reminders/Inbox.md')).content);
			if (!text.includes('Private surrounding note text') || !text.includes('Private browser task')) throw new Error('Whole-note editing lost surrounding text');
		});
		// A fresh installed-app storage partition can authenticate, but must ask
		// for the recovery key before downloading/decrypting reminder content.
		const second = await admin.evaluate(() => window.encryptedTestApi.createRemindersEnrollmentToken('Reminders'));
		const lockedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
		if (type === webkit) await lockedContext.addInitScript(() => {
			Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get: () => undefined });
		});
		try {
			const locked = await lockedContext.newPage();
			await locked.goto(`${origin}/notifications?browserToken=${second.browserToken}&folder=Reminders&tab=inbox`);
			await expect(locked.getByRole('heading', { name: 'Unlock Crate' })).toBeVisible();
			await mkdir('.generated/browser-encryption', { recursive: true });
			await locked.screenshot({ path: `.generated/browser-encryption/${type.name()}-unlock.png`, fullPage: true });
			await locked.getByRole('button', { name: 'Use recovery key instead', exact: true }).click();
			await locked.getByLabel('Recovery key', { exact: true }).fill(enrolled.grant);
			await locked.getByRole('button', { name: 'Unlock Crate', exact: true }).click();
			await expect(locked.getByText('Private browser task', { exact: true })).toBeVisible();
			// Partial CryptoKey damage must be repairable through the real unlock UI.
			await locked.evaluate(async () => {
				const db = await new Promise((resolve, reject) => { const r = indexedDB.open('crate-encryption-keys', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
				const tx = db.transaction('keys', 'readwrite'), store = tx.objectStore('keys');
				const request = store.openCursor();
				request.onsuccess = () => { const cursor = request.result; if (cursor) cursor.update({ ...cursor.value, notificationFingerprint: null }); };
				await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
			});
			await locked.waitForLoadState('networkidle');
			await locked.reload();
			await expect(locked.getByRole('heading', { name: 'Unlock Crate' })).toBeVisible();
			await locked.getByRole('button', { name: 'Use recovery key instead', exact: true }).click();
			await locked.getByLabel('Recovery key', { exact: true }).fill(enrolled.grant);
			await locked.getByRole('button', { name: 'Unlock Crate', exact: true }).click();
			await expect(locked.getByText('Private browser task', { exact: true })).toBeVisible();
			const state = JSON.parse((await runtime.db.prepare("SELECT value FROM maintenance_state WHERE key = 'e2ee:state'").first()).value);
			await runtime.db.prepare("UPDATE maintenance_state SET value = ? WHERE key = 'e2ee:state'").bind(JSON.stringify({ ...state, mode: 'converting' })).run();
			try {
				await locked.waitForLoadState('networkidle');
				await locked.reload();
				await expect(locked.getByRole('heading', { name: 'Encryption conversion in progress' })).toBeVisible();
				await expect(locked.getByRole('button', { name: 'Unlock Crate', exact: true })).toHaveCount(0);
			} finally { await runtime.db.prepare("UPDATE maintenance_state SET value = ? WHERE key = 'e2ee:state'").bind(JSON.stringify(state)).run(); }
			// Background verification may already have dismissed the conversion
			// gate. Reload checks durable recovery without racing that dismissal.
			await locked.waitForLoadState('networkidle');
			await locked.reload();
			await expect(locked.getByText('Private browser task', { exact: true })).toBeVisible();
		} finally { await lockedContext.close(); }
		await verifyReminderFolderMove({ admin, page, origin, owner, setOffline, setFault: value => { faultPhase = value; }, getFault: () => faultPhase, replays, notification });
		await verifyEncryptionReset({ admin, page, origin, owner, runtime });
		assert.equal(recoverySent, false, 'Recovery key must never be sent to the server');
		assert.deepEqual(errors, []);
		console.log(`${type.name()}: conversion/resume, recovery, history, enrollment, offline reload, lost-response replay, private storage, push decryption and separate-app unlock, destructive reset and plaintext re-enrollment passed`);
	} finally {
		await context?.close(); await adminContext.close(); await browser.close();
		await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		await runtime.close(); await rm(dataDir, { recursive: true, force: true });
	}
}
const requestedBrowser = process.env.CRATE_TEST_BROWSER;
if (requestedBrowser && !['chromium', 'webkit'].includes(requestedBrowser)) throw new Error('CRATE_TEST_BROWSER must be chromium or webkit');
for (const type of [chromium, webkit]) if (!requestedBrowser || type.name() === requestedBrowser) await verify(type);
