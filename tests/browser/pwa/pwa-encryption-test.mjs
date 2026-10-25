import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import { openLocalRuntime, issueLocalDevice } from '../../../packages/server/src/local-server-runtime.mjs';
import { listenLocalServer } from '../../../packages/server/src/local-server-http.mjs';
import { verifyEncryptionReset } from './pwa-encryption-reset-checks.mjs';
import { verifyEncryptedAttemptCleanup } from './pwa-encryption-cleanup-checks.mjs';
import { assertNoPlaintextNames, isWirePath, recordPlaintextNames } from './pwa-encrypted-names-checks.mjs';

if (process.env.CRATE_PWA_PREBUILT !== '1') {
	const result = spawnSync(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'inherit' });
	if (result.status !== 0) throw new Error('Worker build failed');
}
const harness = (await build({ stdin: { contents: `
export * from './src/encryption/key-bundle';
export { createEncryptionState } from './src/encryption/server-state';
export { PathTags } from './src/encryption/path-tags';
export * from './src/encryption/reminder-projection';
export * from './src/sync/encryption/server-encryption';
export * from './src/sync/encryption/reset';
export * from './src/sync/worker-api/http';
export * from './src/sync/worker-api/client';
export * from './src/sync/encryption/encrypted-files';
export * from './src/sync/worker-api/sync';
export * from './src/sync/durability/durable-restores';
export { sha256Hex } from './src/platform/sha256';
export { arrayBufferToBase64, base64ToArrayBuffer } from './src/sync/encoding';
export * from './src/pwa/encryption/encrypted-push';
export * from './src/pwa/encryption/encryption-keys';
export * from './src/pwa/reminders/encrypted-reminder-attempts';
export { unlockPrivateStorage } from './src/pwa/reminders/private-storage';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'crateEncryptionTest', platform: 'browser', target: 'es2022', alias: { obsidian: resolve('src/test/mocks/obsidian.ts') } })).outputFiles[0].text;

// Plaintext names that may exist only inside ciphertext once the vault is encrypted.
const PLAINTEXT_NAMES = ['Reminders/', '"Reminders"', 'folder=Reminders', 'folderPath=Reminders', 'Inbox.md', 'Private.md',
	'Encrypted appointment', 'Private browser task', 'Offline encrypted task', 'Private surrounding', 'secret paragraph', 'Excluded/project'];

async function verify(type) {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-e2ee-browser-'));
	const runtime = await openLocalRuntime({ dataDir });
	const replays = []; let faultPhase = 'none', offlineApis = false;
	// Inject faults at the HTTP boundary: WebKit does not reliably route requests
	// owned by an installed service worker through Playwright's route handlers.
	const server = await listenLocalServer({ origin: runtime.origin, mf: { dispatchFetch: async (url, init) => {
		// Only the app is offline; its Obsidian peer keeps its connection.
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
	let context;
	try {
		// A plaintext server copy, with history and settings, that turning encryption on replaces.
		const plain = Buffer.from('# Inbox\n\n- [ ] Plaintext task before encryption <!-- crate-id:r0 -->\n');
		const plainUpload = await fetch(`${origin}/sync/upload?path=${encodeURIComponent('Reminders/Inbox.md')}`, { method: 'PUT', body: plain, headers: {
			...headers, 'Content-Type': 'text/markdown', 'X-File-Hash': createHash('sha256').update(plain).digest('hex'), 'X-File-Size': String(plain.length),
			'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${randomUUID()}`,
		} });
		assert.equal(plainUpload.status, 200, await plainUpload.text());
		// Valid settings larger than the former encrypted envelope limit must remain editable.
		const seedSettings = { ignorePatterns: Array.from({ length: 2000 }, (_, index) => `Excluded/project-${String(index).padStart(4, '0')}/archive/`), syncInterval: 300, pushEnabled: false };
		const settings = await fetch(`${origin}/settings`, { method: 'PUT', headers, body: JSON.stringify({ settings: seedSettings, expectedVersion: null }) });
		assert.equal(settings.status, 200, await settings.text());
		await admin.goto(`${origin}/health`);
		await admin.addScriptTag({ content: harness });
		const enrolled = await admin.evaluate(async ({ origin, token, seedSettings }) => {
			const t = window.crateEncryptionTest;
			const bundle = await t.createVaultKeyBundle();
			const recovery = await t.generateRecoveryCode();
			let loseSetupResponse = true, loseRestoreResponse = false;
			const restoreBodies = [];
			const transport = async request => {
				if (request.url.endsWith('/sync/restore-version')) restoreBodies.push(request.body);
				const response = await fetch(request.url, { method: request.method, body: request.body, headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
				const buffer = await response.arrayBuffer();
				if (loseSetupResponse && request.method === 'POST' && request.url.includes('/encryption/reset?') && response.ok) { loseSetupResponse = false; throw new Error('Injected lost setup response'); }
				if (loseRestoreResponse && request.url.endsWith('/sync/restore-version')) { loseRestoreResponse = false; throw new Error('Injected lost restore response'); }
				return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: buffer, text: new TextDecoder().decode(buffer) };
			};
			const createHttp = token => new t.WorkerApiHttpClient(origin, token, transport);
			// Turning encryption on replaces the server copy. The saved checkpoint resumes
			// with its replacement credential after the begin response is lost.
			let saved = t.createEncryptionSetup(origin, token, bundle, true);
			const target = async () => t.createEncryptionState(bundle, await t.sealRecoveryBundle(bundle, recovery));
			const persist = reset => { saved = structuredClone(reset); };
			try { await t.resetRemoteEncryption(saved, () => {}, () => {}, createHttp, persist, target); throw new Error('Expected a lost setup response'); }
			catch (error) { if (!error.message.includes('Injected lost')) throw error; }
			if (saved.beginState !== 'attempted') throw new Error('Interrupted setup was not saved');
			await t.resetRemoteEncryption(structuredClone(saved), () => {}, () => {}, createHttp, persist, target);
			const owner = saved.replacementToken;
			const http = createHttp(owner);
			const state = await t.readServerEncryption(http);
			if (state.mode !== 'active' || state.vaultId !== bundle.vaultId) throw new Error('Encryption setup did not activate the new vault');
			const recovered = await t.openRecoveryBundle(state.recovery, recovery);
			if (JSON.stringify(recovered) !== JSON.stringify(bundle)) throw new Error('Vault recovery failed');
			if ((await createHttp(token).requestJson('/health').then(() => 200, error => error.status)) !== 401) throw new Error('Setup kept the old device credential');
			const api = new t.SyncApiClient(origin, owner, transport); await api.configureEncryption(bundle, () => ['Reminders']);
			if (Object.keys((await api.getManifest()).files).length) throw new Error('Setup kept plaintext server files');
			if ((await api.getSharedSettings()).settings !== null) throw new Error('Setup kept plaintext shared settings');
			// A new client must create the first encrypted settings version.
			const settingsWriter = new t.SyncApiClient(origin, owner, transport); await settingsWriter.configureEncryption(bundle, () => ['Reminders']);
			await settingsWriter.putSharedSettings(seedSettings);
			if (JSON.stringify((await api.getSharedSettings()).settings) !== JSON.stringify(seedSettings)) throw new Error('First encrypted settings write failed');
			// Upload this device's notes as the plugin does: sealed, at their tagged server paths.
			http.setEncryptionAuthority(bundle.vaultId, bundle.generation);
			const notifications = await t.importNotificationKeys(bundle.vaultId, bundle.notifications);
			const files = await t.EncryptedFiles.create(http, bundle, (path, bytes) => t.createReminderProjection(notifications, ['Reminders'], path, bytes));
			const syncApi = new t.SyncWorkerApi(http); syncApi.setEncryption(files);
			const upload = async (path, text, expectedHash = null) => {
				const bytes = new TextEncoder().encode(text).buffer, hash = await t.sha256Hex(bytes);
				const wire = await files.prepare({ path, content: t.arrayBufferToBase64(bytes), hash, size: bytes.byteLength, contentType: 'text/markdown', expectedHash,
					operationId: 'prepared-by-test', intent: { kind: 'local' }, origin: { clientSession: 'test', at: new Date().toISOString() } });
				const receipt = await syncApi.uploadFile(wire.path, t.base64ToArrayBuffer(wire.content), wire.hash, wire.size, wire.contentType, wire.expectedHash);
				if (!receipt.success || receipt.path !== wire.path) throw new Error(`Encrypted upload of ${path} failed: ${receipt.error}`);
				return hash;
			};
			await upload('Reminders/Inbox.md', '# Inbox\n\nPrivate surrounding note text\n\n- [ ] Encrypted appointment 2099-01-02 <!-- crate-id:r1 -->\n');
			await upload('Private.md', 'Current secret paragraph', await upload('Private.md', 'Retained secret paragraph'));
			const tags = await t.PathTags.fromSecret(bundle.vaultId, bundle.vault);
			const wires = { inbox: await tags.wire('Reminders/Inbox.md'), private: await tags.wire('Private.md'), folder: await tags.wire('Reminders') };
			if (!wires.inbox.startsWith(`${wires.folder}/`)) throw new Error('A note was not stored under its folder tag');
			const checkpointId = (await http.requestJson('/sync/checkpoints', { method: 'POST', body: '{}' })).checkpoint.id;
			if (new TextDecoder().decode((await api.downloadFile('Private.md')).content) !== 'Current secret paragraph') throw new Error('Current note did not decrypt');
			const history = await api.listFileVersions({ path: 'Private.md' });
			if (new TextDecoder().decode(await api.previewFileVersion(history.versions[0])) !== 'Retained secret paragraph') throw new Error('Retained history did not decrypt');
			const snapshot = await api.sharedHistory.load(checkpointId);
			if (!snapshot.files['Private.md'] || !snapshot.files['Reminders/Inbox.md']) throw new Error('Encrypted checkpoint did not resolve plaintext paths');
			const manifest = await api.getManifest();
			if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(['Private.md', 'Reminders/Inbox.md'])) throw new Error('Manifest did not resolve plaintext paths');
			if (manifest.files['Private.md'].size !== 24) throw new Error('Plaintext metadata was not recovered');
			// The actual restore endpoint must receive ciphertext preconditions and
			// retain its original receipt across a client restart after response loss.
			let intents = [];
			const journal = { getRestoreIntents: () => structuredClone(intents),
				setRestoreIntent: intent => { intents = [structuredClone(intent)]; }, removeRestoreIntent: () => { intents = []; }, save: async () => {} };
			loseRestoreResponse = true;
			try { await new t.DurableRestores(journal, syncApi).restore(history.versions[0]); throw new Error('Expected lost restore response'); }
			catch (error) { if (!error.message.includes('Injected lost restore response')) throw error; }
			if (intents[0]?.phase !== 'pending' || intents[0].encryptedWire?.path !== wires.private) throw new Error('Encrypted restore intent was not retained');
			await new t.DurableRestores(journal, syncApi).restore(history.versions[0]);
			if (restoreBodies.length !== 2 || restoreBodies[0] !== restoreBodies[1] || intents[0].phase !== 'committed') throw new Error('Restore replay changed its original request');
			if (restoreBodies[0].includes('Private.md')) throw new Error('Restore named the plaintext path');
			if (new TextDecoder().decode((await api.downloadFile('Private.md')).content) !== 'Retained secret paragraph') throw new Error('Encrypted restore did not recover the original bytes');
			window.encryptedTestApi = api;
			window.encryptedTestKeys = bundle;
			window.encryptedTestRecovery = recovery;
			return { ...(await api.createRemindersEnrollmentToken('Reminders')), grant: recovery, vaultId: bundle.vaultId, owner, wires };
		}, { origin, token: owner.token, seedSettings });
		// The plugin's replacement credential is the vault's only device credential now.
		owner.token = enrolled.owner;
		const fileRows = (await runtime.db.prepare('SELECT path FROM files').all()).results.map(row => row.path).sort();
		assert.deepEqual(fileRows, [enrolled.wires.inbox, enrolled.wires.private].sort());
		const rows = await runtime.db.prepare('SELECT path, storage_key FROM files UNION SELECT path, storage_key FROM file_versions').all();
		for (const row of rows.results) {
			assert.ok(isWirePath(row.path), `${row.path} is not a tagged server path`);
			const text = await (await bucket.get(row.storage_key)).text();
			assert.ok(text.startsWith('CRATE-E2EE/1\n')); assert.ok(!text.includes('secret paragraph')); assert.ok(!text.includes('Private surrounding'));
		}
		assert.equal((await runtime.db.prepare('SELECT folder_path FROM web_enrollment_tokens LIMIT 1').first()).folder_path, enrolled.wires.folder);
		await assertNoPlaintextNames(runtime.db, PLAINTEXT_NAMES);
		context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		// Every request the web app sends while the vault is encrypted, URL and body.
		const sent = recordPlaintextNames(context, origin, PLAINTEXT_NAMES);
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
		// The plugin's link for an encrypted vault: the folder's name travels only in the fragment.
		const fragment = new URLSearchParams({ crateKey: enrolled.grant, crateReadingKey: enrolled.grant, crateFolder: 'Reminders' });
		await page.goto(`${origin}/notifications?browserToken=${enrolled.browserToken}&tab=inbox#${fragment}`);
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
		assert.ok(replays[0].includes(enrolled.wires.folder), 'Encrypted commits name the folder by its tag');
		await page.reload();
		await expect(page.locator('.premium-reminder-title').filter({ hasText: /^Offline encrypted task$/ })).toBeVisible();
		await page.addScriptTag({ url: `${origin}/test-encryption-harness.js` });
		await verifyEncryptedAttemptCleanup(page, enrolled.vaultId, info.reminderOperationDay);
		const notification = await admin.evaluate(async () => {
			const t = window.crateEncryptionTest, bundle = window.encryptedTestKeys;
			const projection = await t.createReminderProjection(await t.importNotificationKeys(bundle.vaultId, bundle.notifications), ['Reminders'], 'Reminders/Inbox.md', new TextEncoder().encode('- [ ] Private push title 2099-01-02 <!-- crate-id:push-test -->').buffer);
			return projection.reminders[0].notification;
		});
		await page.evaluate(async notice => {
			const t = window.crateEncryptionTest;
			const keys = await t.readVaultKeys(notice.vaultId);
			if (keys.vault.key.extractable || keys.notifications.key.extractable || keys.seal.privateKey.extractable || keys.pathTag.extractable || keys.vault.secret || keys.notifications.secret) throw new Error('Browser persisted extractable keys');
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
		const lockedSent = recordPlaintextNames(lockedContext, origin, PLAINTEXT_NAMES);
		if (type === webkit) await lockedContext.addInitScript(() => {
			Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { get: () => undefined });
		});
		try {
			const locked = await lockedContext.newPage();
			await locked.goto(`${origin}/notifications?browserToken=${second.browserToken}&tab=inbox#crateFolder=Reminders`);
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
			await runtime.db.prepare("UPDATE maintenance_state SET value = ? WHERE key = 'e2ee:state'").bind(JSON.stringify({ ...state, mode: 'resetting' })).run();
			try {
				await locked.waitForLoadState('networkidle');
				await locked.reload();
				await expect(locked.getByRole('heading', { name: 'Encryption setup in progress' })).toBeVisible();
				await expect(locked.getByRole('button', { name: 'Unlock Crate', exact: true })).toHaveCount(0);
			} finally { await runtime.db.prepare("UPDATE maintenance_state SET value = ? WHERE key = 'e2ee:state'").bind(JSON.stringify(state)).run(); }
			// Background verification may already have dismissed the setup gate.
			// Reload checks durable recovery without racing that dismissal.
			await locked.waitForLoadState('networkidle');
			await locked.reload();
			await expect(locked.getByText('Private browser task', { exact: true })).toBeVisible();
		} finally { await lockedContext.close(); }
		assert.deepEqual(sent.leaks, [], 'The web app sent a plaintext file or folder name');
		assert.deepEqual(lockedSent.leaks, [], 'The locked web app sent a plaintext file or folder name');
		assert.ok(sent.count > 0 && lockedSent.count > 0);
		await assertNoPlaintextNames(runtime.db, PLAINTEXT_NAMES);
		sent.stop();
		await verifyEncryptionReset({ admin, page, origin, owner, runtime });
		assert.equal(recoverySent, false, 'Recovery key must never be sent to the server');
		assert.deepEqual(errors, []);
		console.log(`${type.name()}: destructive setup/resume, tagged paths, recovery, history, enrollment, offline reload, lost-response replay, private storage, no plaintext names in requests, push decryption and separate-app unlock, destructive reset and plaintext re-enrollment passed`);
	} finally {
		await context?.close(); await adminContext.close(); await browser.close();
		await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		await runtime.close(); await rm(dataDir, { recursive: true, force: true });
	}
}
const requestedBrowser = process.env.CRATE_TEST_BROWSER;
if (requestedBrowser && !['chromium', 'webkit'].includes(requestedBrowser)) throw new Error('CRATE_TEST_BROWSER must be chromium or webkit');
for (const type of [chromium, webkit]) if (!requestedBrowser || type.name() === requestedBrowser) await verify(type);
