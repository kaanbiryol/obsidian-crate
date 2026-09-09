/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol';
import { pruneFileDeletionReceipts } from './file-delete-audit';
import { BATCH_DELETE_MAX_FILES } from '../../protocol/sync-limits';
import { commitFileDelete } from './sync-mutations';
import { getStoredFileRow } from './sync-storage';

const secret = 'Private note content and Bearer credential';
const path = 'Private folder/Confidential note.md';
const clientSession = '11111111-1111-4111-8111-111111111111';
const operation = '22222222-2222-4222-8222-222222222222';
interface File { path: string; hash: string; revision: string }
interface Receipt { consumed_revision: string; revision: string; changelog_seq: number; path: string; consumed_hash: string; request_id: string; device_id: string; client_session: string | null; operation_id: string | null }

async function applySchema(sql = schema) {
	for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
}
beforeEach(async () => {
	await applySchema();
	for (const device of ['first', 'second']) await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES (?, ?, 'vault')")
		.bind(`device-${device}`, await sha256Hex(`credential-${device}`)).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

function request(route: string, init: RequestInit = {}, device = 'first') {
	return worker.fetch(new Request(`https://delete-audit.test${route}`, {
		...init, headers: { Authorization: `Bearer credential-${device}`, 'X-Crate-Protocol': String(CRATE_PLUGIN_PROTOCOL.current),
			'X-Crate-Client-Session': clientSession, 'X-Crate-Operation-Id': operation, ...init.headers },
	}), env);
}
async function upload(filePath = path, body = secret): Promise<File> {
	const response = await request(`/sync/upload?path=${encodeURIComponent(filePath)}`, { method: 'PUT', body, headers: { 'X-Crate-Upload-Operation': createReminderOperationId(Math.floor(Date.now() / 86400000)), 'X-Crate-Expected-Hash': 'absent' } });
	expect(response.status).toBe(200);
	return response.json() as Promise<File>;
}
function remove(file: File, device?: string, headers?: Record<string, string>) {
	return request('/sync/delete', { method: 'POST', body: JSON.stringify({ path: file.path, expectedHash: file.hash, expectedRevision: file.revision }), headers }, device);
}
async function receipts() { return (await env.DB.prepare('SELECT * FROM file_deletion_receipts ORDER BY changelog_seq').all<Receipt>()).results; }
async function tombstones() { return (await env.DB.prepare("SELECT * FROM changelog WHERE action = 'delete' ORDER BY seq").all()).results; }

it('atomically correlates the consumed revision, tombstone, request and authenticated device without logging note data', async () => {
	const file = await upload();
	const log = vi.spyOn(console, 'info');
	const response = await remove(file, 'first', { 'X-Crate-Request-Id': 'forged-request-id', 'X-Crate-Device-Id': 'forged-device-id' });
	expect(response.status).toBe(200);
	const body = await response.json() as { revision: string; consumedRevision: string; deleteRequestId: string };
	expect(body).toMatchObject({ consumedRevision: file.revision, deleteRequestId: response.headers.get('X-Crate-Request-Id') });
	expect(body.revision).toMatch(/^__crate__\/deletions\//);
	expect(await receipts()).toMatchObject([{ consumed_revision: file.revision, revision: body.revision, path, consumed_hash: file.hash,
		request_id: body.deleteRequestId, device_id: 'device-first', client_session: clientSession, operation_id: operation }]);
	expect(await tombstones()).toMatchObject([{ seq: (await receipts())[0]!.changelog_seq, revision: body.revision, path }]);
	expect(log).toHaveBeenCalledWith('crate.mutation', expect.objectContaining({ requestId: body.deleteRequestId, deviceId: 'device-first',
		clientSession, operationId: operation, revisions: [body.revision], consumedRevisions: [file.revision], deleteRequestIds: [body.deleteRequestId] }));
	const logged = JSON.stringify(log.mock.calls);
	for (const privateValue of [path, secret, 'credential-first', 'forged-request-id', 'forged-device-id']) expect(logged).not.toContain(privateValue);
});

it('links a retry to the original deletion after the commit acknowledgement is lost', async () => {
	const file = await upload();
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('lost acknowledgement'); });
	const lost = await remove(file);
	expect(lost.status).toBe(503);
	const original = (await receipts())[0]!;
	expect(original.request_id).toBe(lost.headers.get('X-Crate-Request-Id'));
	const retry = await remove(file, 'second');
	expect(retry.status).toBe(200);
	expect(await retry.json()).toMatchObject({ revision: original.revision, consumedRevision: file.revision, deleteRequestId: original.request_id });
	expect(retry.headers.get('X-Crate-Request-Id')).not.toBe(original.request_id);
	expect(await receipts()).toEqual([original]);
	expect(await tombstones()).toHaveLength(1);
	const recreated = await upload();
	expect((await remove(file)).status).toBe(409);
	expect((await request(`/sync/download?path=${encodeURIComponent(path)}`)).headers.get('X-Crate-Revision')).toBe(recreated.revision);
});

it('attributes simultaneous single and batch deletes to exactly the transaction that consumed the revision', async () => {
	const file = await upload();
	const extra = await upload('Private folder/Other.md');
	const [single, batch] = await Promise.all([
		remove(file, 'first'),
		request('/sync/batch-delete', { method: 'POST', body: JSON.stringify({ files: [file, extra].map(item => ({ path: item.path, expectedHash: item.hash, expectedRevision: item.revision })) }) }, 'second'),
	]);
	expect(single.status).toBe(200);
	expect(batch.status).toBe(200);
	const singleBody = await single.json() as { revision: string; deleteRequestId: string };
	const batchBody = await batch.json() as { deleted: string[]; results: Array<{ path: string; revision: string; consumedRevision: string; deleteRequestId: string }> };
	expect(batchBody.deleted).toEqual([path, extra.path]);
	expect(batchBody.results[0]).toMatchObject({ revision: singleBody.revision, deleteRequestId: singleBody.deleteRequestId, consumedRevision: file.revision });
	const all = await receipts();
	expect(all).toHaveLength(2);
	expect(await tombstones()).toHaveLength(2);
	const owner = all.find(receipt => receipt.path === path)!;
	expect(owner.device_id).toBe(owner.request_id === single.headers.get('X-Crate-Request-Id') ? 'device-first' : 'device-second');
	expect(all.find(receipt => receipt.path === extra.path)).toMatchObject({ device_id: 'device-second', request_id: batch.headers.get('X-Crate-Request-Id') });
});

it('returns original per-file receipts when a whole batch response is lost', async () => {
	const files = [await upload(), await upload('Private folder/Other.md')];
	const body = JSON.stringify({ files: files.map(file => ({ path: file.path, expectedHash: file.hash, expectedRevision: file.revision })) });
	const original = await request('/sync/batch-delete', { method: 'POST', body }); // Caller discards this acknowledgement.
	expect(original.status).toBe(200);
	const before = await receipts();
	const retry = await request('/sync/batch-delete', { method: 'POST', body }, 'second');
	expect(await retry.json()).toMatchObject({ results: before.map(receipt => ({ path: receipt.path, revision: receipt.revision, deleteRequestId: receipt.request_id })) });
	expect(await receipts()).toEqual(before);
});

it('keeps a maximum absent-file retry batch within the Free-plan D1 query budget', async () => {
	const files = [];
	for (let index = 0; index < BATCH_DELETE_MAX_FILES; index++) files.push(await upload(`Notes/${index}.md`));
	const body = JSON.stringify({ files: files.map(file => ({ path: file.path, expectedHash: file.hash, expectedRevision: file.revision })) });
	expect((await request('/sync/batch-delete', { method: 'POST', body })).status).toBe(200);
	const prepare = vi.spyOn(env.DB, 'prepare');
	const retry = await request('/sync/batch-delete', { method: 'POST', body });
	expect(retry.status).toBe(200);
	expect(prepare.mock.calls.length).toBeLessThanOrEqual(50);
	expect(await retry.json()).toMatchObject({ deleted: files.map(file => file.path), results: files.map(file => ({ consumedRevision: file.revision })) });
});

it('returns the exact receipt without deleting a recreation after the absent snapshot', async () => {
	const old = await upload();
	const removed = await remove(old);
	const receipt = await removed.json() as { revision: string; consumedRevision: string; deleteRequestId: string };
	const absent = await getStoredFileRow(env.DB, path);
	expect(absent).toBeNull();
	const recreated = await upload();
	const before = await receipts();
	const retry = await commitFileDelete(env.BUCKET, env.DB, { path, expectedHash: old.hash, expectedRevision: old.revision, previousFile: absent });
	expect(retry).toMatchObject({ committed: true, idempotent: true, deletion: {
		revision: receipt.revision, consumedRevision: receipt.consumedRevision, deleteRequestId: receipt.deleteRequestId,
	} });
	expect(await getStoredFileRow(env.DB, path)).toMatchObject({ storageKey: recreated.revision });
	expect(await receipts()).toEqual(before);
});

it('does not record a deletion on a precondition conflict or failed receipt write', async () => {
	const file = await upload();
	expect((await remove({ ...file, revision: 'stale' })).status).toBe(409);
	expect(await receipts()).toEqual([]);
	await env.DB.prepare("CREATE TRIGGER reject_delete_audit BEFORE INSERT ON file_deletion_receipts BEGIN SELECT RAISE(ABORT, 'test audit failure'); END").run();
	expect((await remove(file)).status).toBe(503);
	expect(await receipts()).toEqual([]);
	expect(await tombstones()).toEqual([]);
	expect(await env.DB.prepare('SELECT * FROM file_versions').first()).toBeNull();
	expect(await (await request(`/sync/download?path=${encodeURIComponent(path)}`)).text()).toBe(secret);
});

it('drops non-opaque client correlation values and never treats absence as a new deletion', async () => {
	const file = await upload();
	const log = vi.spyOn(console, 'info');
	expect((await remove(file, 'first', { 'X-Crate-Client-Session': path, 'X-Crate-Operation-Id': secret })).status).toBe(200);
	expect(await receipts()).toMatchObject([{ client_session: null, operation_id: null }]);
	const absent = await remove({ ...file, path: 'Never uploaded.md' });
	expect(absent.status).toBe(200);
	expect(await absent.json()).not.toHaveProperty('revision');
	expect(await receipts()).toHaveLength(1);
	const logged = JSON.stringify(log.mock.calls);
	for (const privateValue of [path, secret, 'credential-first', 'Never uploaded.md']) expect(logged).not.toContain(privateValue);
});

it('applies the additive schema-2 upgrade repeatedly without changing existing vault rows', async () => {
	const file = await upload();
	await env.DB.prepare('DROP TABLE file_deletion_receipts').run();
	await env.DB.prepare('UPDATE crate_schema SET version = 2').run();
	const before = await env.DB.prepare('SELECT * FROM files').all();
	await applySchema(); await applySchema();
	expect(await env.DB.prepare('SELECT * FROM crate_schema').first()).toEqual({ id: 1, version: 5 });
	expect((await env.DB.prepare('SELECT * FROM files').all()).results).toEqual(before.results);
	expect((await remove(file)).status).toBe(200);
	expect(await receipts()).toHaveLength(1);
});

it('retains recent correlation and expires receipts after their documented 30-day window', async () => {
	const first = await upload(); await remove(first);
	await env.DB.prepare("UPDATE file_deletion_receipts SET created_at = datetime('now', '-31 days')").run();
	const second = await upload(); await remove(second);
	await pruneFileDeletionReceipts(env.DB);
	expect(await receipts()).toMatchObject([{ consumed_revision: second.revision }]);
	expect(await (await remove(first)).json()).not.toHaveProperty('revision');
});
