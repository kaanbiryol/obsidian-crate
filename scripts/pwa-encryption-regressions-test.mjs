import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';
import { openLocalRuntime, issueLocalDevice } from '../packages/server/src/local-server-runtime.mjs';
import { listenLocalServer } from '../packages/server/src/local-server-http.mjs';

if (process.env.CRATE_PWA_PREBUILT !== '1') {
	const result = spawnSync(process.execPath, ['scripts/build-worker.mjs'], { stdio: 'inherit' });
	if (result.status !== 0) throw new Error('Worker build failed');
}
const harness = (await build({ stdin: { contents: `
export * from './src/encryption/key-bundle';
export * from './src/encryption/file-authority';
export * from './src/encryption/file-codec';
export * from './src/sync/encryption-conversion';
export * from './src/sync/worker-api/http';
export * from './src/pwa/encryption-keys';
export * from './src/pwa/encrypted-reminder-api';
export { unlockPrivateStorage } from './src/pwa/private-storage';
export { scanReminderMarkdownContent } from './src/reminders/core/markdownScan';
export { reminderCommandPayload } from './src/reminders/core/reminderFileCommand';
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
		const headers = { Authorization: `Bearer ${owner.token}`, 'X-Crate-Protocol': String(info.protocol.current), 'Content-Type': 'application/json' };
		const operation = () => `e1_${String(info.reminderOperationDay).padStart(8, '0')}_${randomUUID()}`;
		const descriptionLength = scenario === 'large-receipt' ? 800000 : 30000;
		const prefix = scenario === 'plaintext-prefix';
		const text = prefix ? 'CRATE-E2EE/1\nThis is a plaintext format example.\n- [ ] Ordinary task <!-- crate-id:existing-task -->\n'
			: '- [ ] Review this task <!-- crate-id:existing-task -->\n<!-- crate-desc:v1:' + 'x'.repeat(descriptionLength) + ' -->\n';
		const path = 'Reminders/Inbox.md', bytes = Buffer.from(text);
		const upload = await fetch(`${origin}/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: bytes, headers: {
			...headers, 'Content-Type': prefix ? 'application/vnd.crate.encrypted-file' : 'text/markdown',
			'X-File-Hash': createHash('sha256').update(bytes).digest('hex'), 'X-File-Size': String(bytes.length),
			'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operation(),
		} });
		assert.equal(upload.status, 200, await upload.text());
		await page.goto(`${origin}/health`);
		await page.addScriptTag({ url: `${origin}/regression.js` });
		const reminder = await page.evaluate(async ({ text, path }) => window.regression.reminderCommandPayload(window.regression.scanReminderMarkdownContent(path, text, 'Reminders').reminders[0]), { text, path });
		const legacyBody = { operationId: operation(), folderPath: 'Reminders', id: reminder.id, filePath: path, expectedRevision: reminder.revision, completed: true };
		const completed = await fetch(`${origin}/reminders/set-completed`, { method: 'POST', headers, body: JSON.stringify(legacyBody) });
		assert.equal(completed.status, 200, await completed.clone().text());
		const legacyResponse = await completed.json();
		const result = await page.evaluate(async ({ origin, token, day, protocol, legacyBody, prefix }) => {
			const t = window.regression;
			const bundle = t.addReminderScope(t.createVaultKeyBundle(), 'Reminders');
			const code = await t.generateRecoveryCode();
			let lostConversion = false;
			const transport = async request => {
				const response = await fetch(request.url, { method: request.method, body: request.body, headers: { ...request.headers, 'Content-Type': request.contentType ?? 'application/json' } });
				const buffer = await response.arrayBuffer();
				if (!lostConversion && request.url.includes('/conversion/receipt') && response.ok) {
					lostConversion = true;
					throw new Error('Injected lost conversion response');
				}
				return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: buffer, text: new TextDecoder().decode(buffer) };
			};
			const http = new t.WorkerApiHttpClient(origin, token, transport);
			try { await t.convertEncryptedVault(http, bundle, code, () => {}); }
			catch (error) { if (!error.message.includes('Injected lost conversion response')) throw error; }
			await t.convertEncryptedVault(http, bundle, code, () => {});
			const mode = (await t.readServerEncryption(http)).mode;
			const keys = await t.rememberReminderKeys(t.createReminderKeyGrant(bundle, 'Reminders'));
			t.unlockPrivateStorage(await t.unlockLocalState(keys), 'Reminders', localStorage, sessionStorage);
			let lostSave = false;
			const requests = [];
			const apiFetch = async (path, init = {}) => {
				if (path === '/reminders/encrypted-commit') requests.push(init.body);
				const response = await fetch(path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
					'X-Crate-Protocol': String(protocol), 'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation) } });
				if (!lostSave && path === '/reminders/encrypted-commit' && response.ok) {
					lostSave = true; await response.arrayBuffer();
					return Response.json({ error: 'Injected lost save response' }, { status: 503 });
				}
				return response;
			};
			const api = new t.EncryptedReminderApi(keys, apiFetch);
			const legacyReplay = await (await api.handle('/reminders/set-completed', { method: 'POST', body: JSON.stringify(legacyBody) })).json();
			const listed = await (await api.handle('/reminders/list?folderPath=Reminders')).json();
			const reminder = listed.reminders[0];
			const change = { method: 'POST', body: JSON.stringify({ operationId: `e1_${String(day).padStart(8, '0')}_${crypto.randomUUID()}`,
				folderPath: 'Reminders', id: reminder.id, filePath: reminder.filePath, expectedRevision: reminder.revision, completed: false }) };
			const first = await api.handle('/reminders/set-completed', change);
			// A fresh API must settle the committed immutable attempt from the server.
			const retry = await new t.EncryptedReminderApi(keys, apiFetch).handle('/reminders/set-completed', change);
			const after = await (await api.handle('/reminders/list?folderPath=Reminders')).json();
			let preservedPrefix;
			if (prefix) {
				const download = await http.requestBinary(`/sync/download?path=${encodeURIComponent(reminder.filePath)}`);
				const authority = await t.FileKeyAuthority.fromVault(bundle);
				const opened = await t.openFile(new Uint8Array(download.body), reminder.filePath, authority.forPath(reminder.filePath));
				preservedPrefix = new TextDecoder().decode(opened.content).startsWith('CRATE-E2EE/1\nThis is a plaintext format example.');
			}
			return { mode, lostConversion, first: first.status, retry: retry.status, legacyReplay,
				sameRequest: requests.length === 2 && requests[0] === requests[1], ackLength: JSON.parse(requests[0]).acknowledgment.length,
				completed: after.reminders[0].completed, descriptionLength: after.reminders[0].description?.length, preservedPrefix };
		}, { origin, token: owner.token, day: info.reminderOperationDay, protocol: info.protocol.current, legacyBody, prefix });
		assert.equal(result.mode, 'active');
		assert.equal(result.lostConversion, true);
		assert.deepEqual(result.legacyReplay, legacyResponse);
		assert.equal(result.first, 503); assert.equal(result.retry, 200);
		assert.equal(result.sameRequest, true); assert.equal(result.completed, false);
		if (prefix) assert.equal(result.preservedPrefix, true);
		else {
			assert.equal(result.descriptionLength, descriptionLength);
			assert.ok(result.ackLength > 32 * 1024);
			if (scenario === 'large-receipt') {
				const count = await runtime.db.prepare("SELECT COUNT(*) AS count FROM maintenance_state WHERE key GLOB 'e2ee:receipt:*'").first();
				assert.ok(count.count > 4);
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
			console.log(`${type.name()}: ${scenario}, conversion resume and lost-response replay passed`);
		}
	} finally { await browser.close(); }
}
