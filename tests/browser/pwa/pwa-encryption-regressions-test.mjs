import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';
import { openLocalRuntime, issueLocalDevice } from '../../../packages/server/src/local-server-runtime.mjs';
import { listenLocalServer } from '../../../packages/server/src/local-server-http.mjs';
import { isWirePath } from './pwa-encrypted-names-checks.mjs';

if (process.env.CRATE_PWA_PREBUILT !== '1') {
	const result = spawnSync(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'inherit' });
	if (result.status !== 0) throw new Error('Worker build failed');
}
const harness = (await build({ stdin: { contents: `
export * from './src/encryption/key-bundle';
export { createEncryptionState } from './src/encryption/server-state';
export * from './src/encryption/file-authority';
export * from './src/encryption/file-codec';
export { PathTags } from './src/encryption/path-tags';
export * from './src/encryption/reminder-projection';
export * from './src/sync/encryption/reset';
export * from './src/sync/worker-api/http';
export * from './src/pwa/encryption/encryption-keys';
export * from './src/pwa/reminders/encrypted-reminder-api';
export { unlockPrivateStorage } from './src/pwa/reminders/private-storage';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'regression', platform: 'browser', target: 'es2022', alias: { obsidian: resolve('src/test/mocks/obsidian.ts') } })).outputFiles[0].text;

async function verify(browser, scenario) {
	const dataDir = await mkdtemp(join(tmpdir(), 'crate-encryption-regression-'));
	const runtime = await openLocalRuntime({ dataDir });
	const server = await listenLocalServer({ origin: runtime.origin, mf: { dispatchFetch: async (url, init) =>
		new URL(url).pathname === '/regression.js' ? new Response(harness, { headers: { 'Content-Type': 'application/javascript' } }) : runtime.mf.dispatchFetch(url, init),
	} }, { port: 0 });
	const origin = `http://127.0.0.1:${server.address().port}`;
	const page = await browser.newPage();
	try {
		const owner = await issueLocalDevice(runtime.db, 'Encryption regression');
		const info = await (await fetch(`${origin}/.well-known/crate`)).json();
		const descriptionLength = scenario === 'large-receipt' ? 800000 : 30000;
		const prefix = scenario === 'plaintext-prefix';
		// A note that merely looks like the encrypted file format must stay an ordinary note.
		const text = prefix ? 'CRATE-E2EE/1\nThis is a plaintext format example.\n- [ ] Ordinary task <!-- crate-id:existing-task -->\n'
			: '- [ ] Review this task <!-- crate-id:existing-task -->\n<!-- crate-desc:v1:' + 'x'.repeat(descriptionLength) + ' -->\n';
		await page.goto(`${origin}/health`);
		await page.addScriptTag({ url: `${origin}/regression.js` });
		const result = await page.evaluate(async ({ origin, token, day, protocol, text }) => {
			const t = window.regression;
			const bundle = await t.createVaultKeyBundle();
			const code = await t.generateRecoveryCode();
			let lostSetup = false;
			const transport = async request => {
				const response = await fetch(request.url, { method: request.method, body: request.body, headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
				const buffer = await response.arrayBuffer(), body = new TextDecoder().decode(buffer);
				// Lose the reply that reports the finished wipe; the saved reset must resume.
				if (!lostSetup && request.url.includes('/encryption/reset?') && response.ok && JSON.parse(body).complete === true) {
					lostSetup = true;
					throw new Error('Injected lost setup response');
				}
				return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: buffer, text: body };
			};
			const createHttp = token => new t.WorkerApiHttpClient(origin, token, transport);
			let saved = t.createEncryptionSetup(origin, token, bundle, true);
			const target = async () => t.createEncryptionState(bundle, await t.sealRecoveryBundle(bundle, code));
			const persist = reset => { saved = structuredClone(reset); };
			try { await t.resetRemoteEncryption(saved, () => {}, () => {}, createHttp, persist, target); }
			catch (error) { if (!error.message.includes('Injected lost setup response')) throw error; }
			await t.resetRemoteEncryption(structuredClone(saved), () => {}, () => {}, createHttp, persist, target);
			const vaultToken = saved.replacementToken;
			const http = createHttp(vaultToken);
			http.setEncryptionAuthority(bundle.vaultId, bundle.generation);
			const mode = (await http.requestJson('/encryption')).encryption.mode;
			// The plugin uploads the note sealed, at its tagged server path.
			const tags = await t.PathTags.fromSecret(bundle.vaultId, bundle.vault);
			const path = 'Reminders/Inbox.md', wire = await tags.wire(path);
			const authority = await t.FileKeyAuthority.fromBundle(bundle);
			const content = new TextEncoder().encode(text);
			const publicData = await t.createReminderProjection(await t.importNotificationKeys(bundle.vaultId, bundle.notifications), ['Reminders'], path, content.buffer);
			const sealed = await t.sealFile({ path, content, contentType: 'text/markdown', publicData }, authority.forPath(wire));
			const authorityHeaders = { Authorization: `Bearer ${vaultToken}`, 'X-Crate-Protocol': String(protocol),
				'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) };
			const plainUpload = await fetch(`/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: sealed.bytes, headers: { ...authorityHeaders,
				'Content-Type': 'application/vnd.crate.encrypted-file', 'X-File-Hash': sealed.hash, 'X-File-Size': String(sealed.bytes.byteLength),
				'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': `e1_${String(day).padStart(8, '0')}_${crypto.randomUUID()}` } });
			const upload = await fetch(`/sync/upload?path=${encodeURIComponent(wire)}`, { method: 'PUT', body: sealed.bytes, headers: { ...authorityHeaders,
				'Content-Type': 'application/vnd.crate.encrypted-file', 'X-File-Hash': sealed.hash, 'X-File-Size': String(sealed.bytes.byteLength),
				'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': `e1_${String(day).padStart(8, '0')}_${crypto.randomUUID()}` } });
			if (!upload.ok) throw new Error(await upload.text());
			const stored = await t.rememberVaultKeys(bundle);
			const keys = { ...stored, folderPath: 'Reminders', wireFolder: await tags.wire('Reminders'), paths: new t.PathTags(stored.pathTag) };
			t.unlockPrivateStorage(await t.unlockLocalState(keys, 'reminders'), 'Reminders', localStorage, sessionStorage);
			let lostSave = false;
			const requests = [];
			const apiFetch = async (path, init = {}) => {
				if (path === '/reminders/encrypted-commit') requests.push(init.body);
				const response = await fetch(path, { ...init, headers: { ...authorityHeaders, 'Content-Type': 'application/json' } });
				if (!lostSave && path === '/reminders/encrypted-commit' && response.ok) {
					lostSave = true; await response.arrayBuffer();
					return Response.json({ error: 'Injected lost save response' }, { status: 503 });
				}
				return response;
			};
			const api = new t.EncryptedReminderApi(keys, apiFetch);
			const listed = await (await api.handle('/reminders/list?folderPath=Reminders')).json();
			const reminder = listed.reminders[0];
			const change = { method: 'POST', body: JSON.stringify({ operationId: `e1_${String(day).padStart(8, '0')}_${crypto.randomUUID()}`,
				folderPath: 'Reminders', id: reminder.id, filePath: reminder.filePath, expectedRevision: reminder.revision, completed: true }) };
			const first = await api.handle('/reminders/set-completed', change);
			// A fresh API must settle the committed immutable attempt from the server.
			const retry = await new t.EncryptedReminderApi(keys, apiFetch).handle('/reminders/set-completed', change);
			const after = await (await api.handle('/reminders/list?folderPath=Reminders')).json();
			const download = await http.requestBinary(`/sync/download?path=${encodeURIComponent(wire)}`);
			const opened = await t.openFile(new Uint8Array(download.body), path, authority.forPath(wire));
			return { mode, lostSetup, plainUpload: plainUpload.status, wire, filePath: reminder.filePath, first: first.status, retry: retry.status,
				sameRequest: requests.length === 2 && requests[0] === requests[1], plaintextNames: requests.some(body => body.includes('Reminders/') || body.includes('Inbox.md')),
				ackLength: JSON.parse(requests[0]).acknowledgment.length, completed: after.reminders[0].completed, descriptionLength: after.reminders[0].description?.length,
				preservedPrefix: new TextDecoder().decode(opened.content).startsWith('CRATE-E2EE/1\nThis is a plaintext format example.\n- [x] Ordinary task') };
		}, { origin, token: owner.token, day: info.reminderOperationDay, protocol: info.protocol.current, text });
		assert.equal(result.mode, 'active');
		assert.equal(result.lostSetup, true);
		// Readable names are refused in an encrypted vault.
		assert.equal(result.plainUpload, 428);
		assert.ok(isWirePath(result.wire));
		assert.deepEqual((await runtime.db.prepare('SELECT path FROM files').all()).results.map(row => row.path), [result.wire]);
		assert.equal(result.filePath, 'Reminders/Inbox.md');
		assert.equal(result.first, 503); assert.equal(result.retry, 200);
		assert.equal(result.sameRequest, true); assert.equal(result.completed, true);
		assert.equal(result.plaintextNames, false);
		if (prefix) assert.equal(result.preservedPrefix, true);
		else {
			assert.equal(result.descriptionLength, descriptionLength);
			assert.ok(result.ackLength > 32 * 1024);
			if (scenario === 'large-receipt') {
				// The acknowledgment exceeds one D1 value, so its receipt is stored in bounded chunks.
				const chunks = await runtime.db.prepare("SELECT COUNT(*) AS count, MAX(LENGTH(value)) AS longest FROM maintenance_state WHERE key GLOB 'e2ee:receipt:reminder:*'").first();
				assert.ok(chunks.count >= 2, `Expected a chunked receipt, found ${chunks.count} rows`);
				assert.ok(chunks.longest <= 512 * 1024);
			}
		}
	} finally {
		await page.close(); await new Promise(resolve => server.close(resolve)); await runtime.close(); await rm(dataDir, { recursive: true, force: true });
	}
}
for (const type of [chromium, webkit]) {
	const browser = await type.launch();
	try {
		for (const scenario of ['long-reminder', 'large-receipt', 'plaintext-prefix']) {
			await verify(browser, scenario);
			console.log(`${type.name()}: ${scenario}, setup resume after a lost reply, tagged paths and lost-response replay passed`);
		}
	} finally { await browser.close(); }
}
