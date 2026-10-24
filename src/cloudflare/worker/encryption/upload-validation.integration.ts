/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { trackStagedUploads } from '../sync/staged-uploads';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
import type { EncryptionServerState } from '../../../encryption/server-state';
import type { FileKeyAuthority } from '../../../encryption/file-authority';
import { createReminderProjection, type NotificationKeys } from '../../../encryption/reminder-projection';
import { sealFile } from '../../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../../encryption/file-format';
import { CRATE_PLUGIN_PROTOCOL } from '../../../protocol/server-info';
import { createReminderOperationId } from '../../../protocol/reminder-operation';
import { sha256Hex } from '../../../platform/sha256';

let state: EncryptionServerState;
let keys: FileKeyAuthority;
let notifications: NotificationKeys;
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
const headers = () => ({ Authorization: 'Bearer owner', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
	'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) });

beforeEach(async () => {
	await applySchema(env.DB);
	({ state, keys, notifications } = await createEncryptionFixture('active'));
	await storeEncryptionState(env.DB, state);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('owner', ?, 'vault')").bind(await sha256Hex('owner')).run();
});
afterEach(reset);

async function expectNoPublication() {
	expect((await env.BUCKET.list()).objects).toHaveLength(0);
	for (const table of ['files', 'file_versions', 'changelog', 'staged_uploads', 'staged_upload_batches', 'upload_operations']) {
		expect(await env.DB.prepare(`SELECT 1 FROM ${table}`).first(), table).toBeNull();
	}
}

it.each(['single markdown', 'single binary', 'batch', 'mixed batch'] as const)('rejects plaintext before durable storage through the authenticated %s route', async kind => {
	const path = kind === 'single binary' ? 'leak.bin' : 'leak.md';
	const content = 'private plaintext';
	const hash = await sha256Hex(content);
	const batch = kind.includes('batch');
	const files = [{ path, content: btoa(content), contentType: 'text/markdown', hash, size: content.length, expectedHash: null, operationId: operationId() }];
	if (kind === 'mixed batch') {
		const valid = await sealFile({ path: 'valid.md', content: new TextEncoder().encode('encrypted'), contentType: 'text/markdown' }, keys.forPath('valid.md'));
		files.unshift({ path: 'valid.md', content: btoa(new TextDecoder().decode(valid.bytes)), contentType: ENCRYPTED_FILE_CONTENT_TYPE,
			hash: valid.hash, size: valid.bytes.length, expectedHash: null, operationId: operationId() });
	}
	const response = await worker.fetch(new Request(batch ? 'https://test/sync/batch-upload' : `https://test/sync/upload?path=${path}`, {
		method: batch ? 'POST' : 'PUT', body: batch ? JSON.stringify({ files }) : content,
		headers: { ...headers(), 'Content-Type': batch ? 'application/json' : 'text/markdown',
			'X-File-Hash': hash, 'X-File-Size': String(content.length), 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId() },
	}), env);
	expect(response.status, await response.clone().text()).toBe(428);
	expect(await response.json()).toMatchObject({ code: 'encryption_required' });
	expect(response.headers.get('X-Crate-Encryption-State')).toBe('on');
	await expectNoPublication();
});

it.each(['single', 'batch'] as const)('rejects malformed ciphertext framing before staging a %s upload', async kind => {
	const content = 'CRATE-E2EE/1\nnot-json\nprivate plaintext';
	const response = await worker.fetch(new Request(kind === 'single' ? 'https://test/sync/upload?path=leak.md' : 'https://test/sync/batch-upload', {
		method: kind === 'single' ? 'PUT' : 'POST',
		body: kind === 'single' ? content : JSON.stringify({ files: [{ path: 'leak.md', content: btoa(content), contentType: ENCRYPTED_FILE_CONTENT_TYPE, expectedHash: null, operationId: operationId() }] }),
		headers: { ...headers(), 'Content-Type': kind === 'single' ? ENCRYPTED_FILE_CONTENT_TYPE : 'application/json',
			'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId() },
	}), env);
	expect(response.status, await response.clone().text()).toBe(428);
	await expectNoPublication();
});

it('keeps the content guard when a caller supplies the authenticated encryption state', async () => {
	await expect(trackStagedUploads(env.DB, [{ storageKey: 'rejected', path: 'leak.md' }], false, state, null)).rejects.toThrow();
	await expectNoPublication();
});

it('rejects ciphertext from another vault before storing it', async () => {
	const { keys: other } = await createEncryptionFixture('active');
	const file = await sealFile({ path: 'wrong.bin', content: new Uint8Array([1]), contentType: 'application/octet-stream' }, other.forPath('wrong.bin'));
	const response = await worker.fetch(new Request('https://test/sync/upload?path=wrong.bin', { method: 'PUT', body: file.bytes,
		headers: { ...headers(), 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId() },
	}), env);
	expect(response.status, await response.clone().text()).toBe(428);
	await expectNoPublication();
});

it.each(['another notification key', 'a non-Markdown file'] as const)('rejects reminder schedules sealed for %s before storing them', async kind => {
	const path = kind === 'a non-Markdown file' ? 'Reminders/note.bin' : 'Reminders/note.md';
	const content = new TextEncoder().encode('- [ ] Private reminder 2099-01-02T10:00:00.000Z <!-- crate-id:r1 -->');
	// Same vault identity, but a notification key this vault never published.
	const projectionKeys = kind === 'another notification key' ? { ...(await createEncryptionFixture('active')).notifications, vaultId: state.vaultId } : notifications;
	const publicData = await createReminderProjection(projectionKeys, ['Reminders'], 'Reminders/note.md', content.buffer);
	expect(publicData?.reminders).toHaveLength(1);
	const file = await sealFile({ path, content, contentType: 'application/octet-stream', publicData }, keys.forPath(path));
	const response = await worker.fetch(new Request(`https://test/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file.bytes,
		headers: { ...headers(), 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId() },
	}), env);
	expect(response.status, await response.clone().text()).toBe(409);
	expect(await response.json()).toMatchObject({ code: 'encryption_required' });
	await expectNoPublication();
});

it.each(['/sync-upload', '/sync-batch-upload'])('does not expose the internal transfer endpoint %s publicly', async path => {
	const response = await worker.fetch(new Request('https://test' + path, { method: path === '/sync-upload' ? 'PUT' : 'POST', body: 'plaintext', headers: headers() }), env);
	expect(response.status, await response.clone().text()).toBe(404);
	await expectNoPublication();
});

it('accepts valid encrypted uploads and replays their exact receipt through the public route', async () => {
	const file = await sealFile({ path: 'safe.bin', content: new Uint8Array([1, 2, 3]), contentType: 'application/octet-stream' }, keys.forPath('safe.bin'));
	const id = operationId();
	const send = () => worker.fetch(new Request('https://test/sync/upload?path=safe.bin', { method: 'PUT', body: file.bytes,
		headers: { ...headers(), 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-File-Hash': file.hash,
			'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': id },
	}), env);
	const first = await send();
	expect(first.status, await first.clone().text()).toBe(200);
	const receipt: unknown = await first.json();
	expect(await (await send()).json()).toEqual(receipt);
	const objects = (await env.BUCKET.list()).objects;
	expect(objects).toHaveLength(1);
	expect(await sha256Hex(await (await env.BUCKET.get(objects[0]!.key))!.arrayBuffer())).toBe(file.hash);
});

it.each(['single', 'batch'] as const)('commits an encrypted %s Markdown upload without reading it back from R2', async kind => {
	const file = await sealFile({ path: 'note.md', content: new TextEncoder().encode('# Private'), contentType: 'text/markdown' }, keys.forPath('note.md'));
	const get = env.BUCKET.get.bind(env.BUCKET);
	let reads = 0;
	env.BUCKET.get = ((...args: Parameters<R2Bucket['get']>) => { reads += 1; return get(...args); });
	try {
		const response = await worker.fetch(new Request(kind === 'single' ? 'https://test/sync/upload?path=note.md' : 'https://test/sync/batch-upload', {
			method: kind === 'single' ? 'PUT' : 'POST',
			body: kind === 'single' ? file.bytes : JSON.stringify({ files: [{ path: 'note.md', content: btoa(String.fromCharCode(...file.bytes)),
				contentType: ENCRYPTED_FILE_CONTENT_TYPE, hash: file.hash, size: file.bytes.length, expectedHash: null, operationId: operationId() }] }),
			headers: { ...headers(), 'Content-Type': kind === 'single' ? ENCRYPTED_FILE_CONTENT_TYPE : 'application/json', 'X-File-Hash': file.hash,
				'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId() },
		}), env);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(response.headers.get('X-Crate-Encryption-State')).toBe('on');
	} finally { env.BUCKET.get = get; }
	expect(reads).toBe(0);
	expect(await env.DB.prepare('SELECT path FROM files').first()).toEqual({ path: 'note.md' });
	expect(await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key LIKE 'e2ee:file:%'").first()).not.toBeNull();
});

it('rejects a client upload sealed to the vault seal key, even inside the Reading folder', async () => {
	const { sealFileForVault } = await import('../../../encryption/sealed-file');
	const path = 'Reading/Article - forged.md';
	const sealed = await sealFileForVault({ path, content: new TextEncoder().encode('forged article'), contentType: 'text/markdown' },
		{ vaultId: state.vaultId, keyId: state.seal.keyId, publicKey: state.seal.publicKey });
	const response = await worker.fetch(new Request(`https://test/sync/upload?path=${encodeURIComponent(path)}`, {
		method: 'PUT', body: sealed.bytes,
		headers: { ...headers(), 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE,
			'X-File-Hash': sealed.hash, 'X-File-Size': String(sealed.bytes.length), 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId() },
	}), env);
	expect(response.status, await response.clone().text()).toBe(428);
	await expectNoPublication();
});
