/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
import type { EncryptionServerState } from '../../../encryption/server-state';
import type { FileKeyAuthority } from '../../../encryption/file-authority';
import type { PathTags } from '../../../encryption/path-tags';
import { sealFile } from '../../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../../encryption/file-format';
import { CRATE_PLUGIN_PROTOCOL } from '../../../protocol/server-info';
import { createReminderOperationId } from '../../../protocol/reminder-operation';
import { sha256Hex } from '../../../platform/sha256';

let state: EncryptionServerState;
let keys: FileKeyAuthority;
let paths: PathTags;
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400000));
const headers = () => ({ Authorization: 'Bearer owner', 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
	'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) });
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://test${path}`, { ...init, headers: { ...headers(), ...init.headers } }), env);
const json = async <T>(response: Response): Promise<T> => {
	expect(response.status, await response.clone().text()).toBe(200);
	return await response.json() as T;
};

beforeEach(async () => {
	await applySchema(env.DB);
	({ state, keys, paths } = await createEncryptionFixture('active'));
	await storeEncryptionState(env.DB, state);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('owner', ?, 'vault')").bind(await sha256Hex('owner')).run();
});
afterEach(reset);

async function upload(wire: string, text: string, expectedHash: string | null) {
	const file = await sealFile({ path: 'Files/photo.bin', content: new TextEncoder().encode(text), contentType: 'application/octet-stream' }, keys.forPath(wire));
	const result = await json<{ revision: string }>(await call(`/sync/upload?path=${encodeURIComponent(wire)}`, { method: 'PUT', body: file.bytes,
		headers: { 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-File-Hash': file.hash, 'X-File-Size': String(file.bytes.length),
			'X-Crate-Expected-Hash': expectedHash ?? 'absent', 'X-Crate-Upload-Operation': operationId() } }));
	return { hash: file.hash, revision: result.revision, descriptor: file.descriptor };
}

it('lists each revision with the descriptor written in its own rows', async () => {
	const wire = await paths.wire('Files/photo.bin');
	const first = await upload(wire, 'first', null);
	const second = await upload(wire, 'second', first.hash);

	const manifest = await json<{ files: Record<string, { revision: string; descriptor: unknown }> }>(await call('/sync/manifest?limit=10'));
	expect(manifest.files[wire]).toMatchObject({ revision: second.revision, descriptor: second.descriptor });
	const metadata = await json<{ files: Record<string, { descriptor: unknown }> }>(await call('/sync/metadata', { method: 'POST', body: JSON.stringify({ paths: [wire] }) }));
	expect(metadata.files[wire]?.descriptor).toEqual(second.descriptor);

	const deleted = await json<{ deleted: string[] }>(await call('/sync/batch-delete', { method: 'POST',
		body: JSON.stringify({ files: [{ path: wire, expectedHash: second.hash, expectedRevision: second.revision }] }) }));
	expect(deleted.deleted).toEqual([wire]);

	const changes = await json<{ changes: Array<{ action: string; revision: string; descriptor?: unknown }> }>(await call('/sync/changes?since=0'));
	expect(changes.changes.map(({ action, revision, descriptor }) => ({ action, revision, descriptor }))).toEqual([
		{ action: 'put', revision: first.revision, descriptor: first.descriptor },
		{ action: 'put', revision: second.revision, descriptor: second.descriptor },
		{ action: 'delete', revision: expect.any(String) as string, descriptor: undefined },
	]);
	// The replaced copy and the deleted file keep their descriptors as retained versions.
	const versions = await json<{ versions: Array<{ storage_key: string; reason: string; descriptor: unknown }> }>(await call(`/sync/versions?path=${encodeURIComponent(wire)}`));
	expect(Object.fromEntries(versions.versions.map(version => [version.storage_key, [version.reason, version.descriptor]]))).toEqual({
		[first.revision]: ['replaced', first.descriptor], [second.revision]: ['deleted', second.descriptor] });
	const receipt = await json<{ receipt: { hash: string; descriptor: unknown } }>(await call(`/encryption/deletion-precondition?${new URLSearchParams({ path: wire, revision: second.revision })}`));
	expect(receipt.receipt).toEqual({ hash: second.hash, descriptor: second.descriptor });
	// Before: each descriptor was also a maintenance_state row that three cleanup paths released.
	expect(await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key LIKE 'e2ee:file:%'").first()).toBeNull();
});

it('still answers older clients from /encryption/metadata until the last row of a revision is gone', async () => {
	const wire = await paths.wire('Files/photo.bin');
	const first = await upload(wire, 'first', null);
	const second = await upload(wire, 'second', first.hash);
	const lookup = async (revisions: string[]) => (await json<{ descriptors: Record<string, unknown> }>(await call('/encryption/metadata', {
		method: 'POST', body: JSON.stringify({ revisions }) }))).descriptors;
	expect(await lookup([first.revision, second.revision, 'missing'])).toEqual({ [first.revision]: first.descriptor, [second.revision]: second.descriptor });
	// Without its retained copy, the first revision is known only to its changelog put.
	await env.DB.prepare('DELETE FROM file_versions WHERE storage_key = ?').bind(first.revision).run();
	expect(await lookup([first.revision])).toEqual({ [first.revision]: first.descriptor });
	// Pruning that put releases the descriptor with it; nothing else holds one.
	await env.DB.prepare('DELETE FROM changelog WHERE revision = ?').bind(first.revision).run();
	expect(await lookup([first.revision, second.revision])).toEqual({ [second.revision]: second.descriptor });
});
