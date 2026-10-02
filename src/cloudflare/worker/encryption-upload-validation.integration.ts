/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex, sha256HexBytes } from './auth';
import { ENCRYPTION_STATE_KEY } from './encryption-state';
import { trackStagedUploads } from './staged-uploads';
import { createVaultKeyBundle, generateRecoveryCode, sealRecoveryBundle } from '../../encryption/key-bundle';
import { createEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { FileKeyAuthority } from '../../encryption/file-authority';
import { sealFile } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { createReminderOperationId } from '../../protocol/reminder-operation';

let state: EncryptionServerState;
let keys: FileKeyAuthority;
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
const headers = () => ({ Authorization: 'Bearer owner', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
	'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) });

beforeEach(async () => {
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	const bundle = createVaultKeyBundle();
	state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, await generateRecoveryCode())), mode: 'active' };
	keys = await FileKeyAuthority.fromVault(bundle);
	await env.DB.prepare('INSERT INTO maintenance_state(key, value) VALUES (?, ?)').bind(ENCRYPTION_STATE_KEY, JSON.stringify(state)).run();
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
	const other = await FileKeyAuthority.fromVault(createVaultKeyBundle());
	const file = await sealFile({ path: 'wrong.bin', content: new Uint8Array([1]), contentType: 'application/octet-stream' }, other.forPath('wrong.bin'));
	const response = await worker.fetch(new Request('https://test/sync/upload?path=wrong.bin', { method: 'PUT', body: file.bytes,
		headers: { ...headers(), 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-Crate-Expected-Hash': 'absent', 'X-Crate-Upload-Operation': operationId() },
	}), env);
	expect(response.status, await response.clone().text()).toBe(428);
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
	expect(await sha256HexBytes(await (await env.BUCKET.get(objects[0]!.key))!.arrayBuffer())).toBe(file.hash);
});
