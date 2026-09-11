/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { sha256Hex, sha256HexBytes } from './auth';
import worker from './index';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../protocol';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import type { RemoteFileVersion, RestoreFileRequest } from '../../protocol/sync-types';
import { SyncTestDevice } from './sync-engine-test-harness';

const clients: SyncTestDevice[] = [];
beforeEach(async () => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	vi.spyOn(console, 'info').mockImplementation(() => {});
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('restore-test', ?, 'vault')").bind(await sha256Hex('restore-test')).run();
});
afterEach(async () => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });
const newId = (day = Math.floor(Date.now() / 86_400_000)) => createReminderOperationId(day);
async function request(path: string, body: unknown) {
	return worker.fetch(new Request(`https://worker.test${path}`, { method: 'POST',
		headers: { Authorization: 'Bearer restore-test', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
}
async function retained(): Promise<RemoteFileVersion> {
	const bytes = new TextEncoder().encode('retained content');
	const hash = await sha256HexBytes(bytes); const key = `__crate__/files/${hash}/${crypto.randomUUID()}`;
	await env.BUCKET.put(key, bytes, { customMetadata: { hash } });
	const version: RemoteFileVersion = { storage_key: key, path: 'note.md', hash, size: bytes.byteLength, reason: 'deleted', created_at: new Date().toISOString(), expires_at: Date.now() + 60_000 };
	await env.DB.prepare("INSERT INTO file_versions (storage_key,path,hash,size,reason,expires_at) VALUES (?,?,?,?,'deleted',?)").bind(key,version.path,hash,version.size,version.expires_at).run();
	return version;
}
const intent = (version: RemoteFileVersion): RestoreFileRequest => ({ path: version.path, storageKey: version.storage_key, expectedHash: null, expectedRevision: null, operationId: newId() });
const restore = (body: RestoreFileRequest) => request('/sync/restore-version', body);
const live = () => env.DB.prepare("SELECT hash,storage_key FROM files WHERE path='note.md'").first<{ hash: string; storage_key: string }>();
function loseCommitResponse() {
	const batch = env.DB.batch.bind(env.DB);
	vi.spyOn(env.DB, 'batch').mockImplementationOnce(async statements => { await batch(statements); throw new Error('Lost commit response'); });
}
async function removeCurrent() {
	const current = (await live())!;
	expect((await request('/sync/delete', { path:'note.md', expectedHash:current.hash, expectedRevision:current.storage_key })).status).toBe(200);
}

it('replays a committed receipt without resurrecting a later deletion, even after retained bytes expire', async () => {
	const version = await retained(); const body = intent(version);
	loseCommitResponse(); expect((await restore(body)).status).toBe(503);
	const revision = (await live())!.storage_key;
	await removeCurrent(); await env.DB.prepare('DELETE FROM file_versions').run(); await env.BUCKET.delete(version.storage_key);
	const response = await restore(body); expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ success:true, revision });
	expect(await live()).toBeNull();
	expect((await env.DB.prepare("SELECT action FROM changelog ORDER BY seq").all()).results.map(row=>row.action)).toEqual(['put','delete']);
});
it('concurrent identical requests publish exactly one incarnation', async () => {
	const body = intent(await retained());
	const responses = await Promise.all([restore(body), restore(body)]);
	expect(responses.map(response=>response.status)).toEqual([200,200]);
	const receipts = await Promise.all(responses.map(response=>response.json())); expect(receipts[0]).toEqual(receipts[1]);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM changelog').first()).toEqual({ n:1 });
});
it('retains a rejected restore even when its precondition becomes valid later', async () => {
	const version = await retained(); const first = intent(version);
	expect((await restore(first)).status).toBe(200);
	const rejected = intent(version); expect((await restore(rejected)).status).toBe(409);
	await removeCurrent(); expect((await restore(rejected)).status).toBe(409); expect(await live()).toBeNull();
});
it('does not consume an identical-byte replacement incarnation with an old revision', async () => {
	const version = await retained(); expect((await restore(intent(version))).status).toBe(200);
	const old = (await live())!; await removeCurrent(); expect((await restore(intent(version))).status).toBe(200);
	expect((await restore({ ...intent(version), expectedHash: old.hash, expectedRevision: old.storage_key })).status).toBe(409);
	expect((await live())!.storage_key).not.toBe(old.storage_key);
});
it('binds the operation to its retained key and rejects expired uncommitted intents', async () => {
	const version = await retained(); const body = intent(version); expect((await restore(body)).status).toBe(200);
	expect((await restore({ ...body, storageKey: version.storage_key + '-other' })).status).toBe(409);
	await removeCurrent();
	expect((await restore({ ...intent(version), operationId: newId(Math.floor(Date.now()/86_400_000)-181) })).status).toBe(410);
	expect(await live()).toBeNull();
});
it('resumes the local journal after restart without refreshing its original absent precondition', async () => {
	const client = new SyncTestDevice('restore-client',env); clients.push(client); await client.authorize(); await client.open();
	const version = await retained(); loseCommitResponse(); await expect(client.api.restoreFileVersion(version)).rejects.toThrow();
	expect(client.api.getPendingRestores()).toHaveLength(1); await removeCurrent();
	client.close(); await client.engine.waitForIdle(); await client.open();
	await client.api.restoreFileVersion(version); expect(await live()).toBeNull();
	await client.api.finishRestore(version.storage_key); expect(client.api.getPendingRestores()).toHaveLength(0);
});
it('fences legacy restore calls while preserving read access', async () => {
	expect((await request('/sync/restore-version',{ storageKey:'old',expectedHash:null })).status).toBe(428);
	expect(await live()).toBeNull();
});

it('never dispatches restore before its local checkpoint is durable and retries the saved intent', async () => {
 const client = new SyncTestDevice('restore-disk-failure', env); clients.push(client); await client.authorize(); await client.open();
 const version = await retained();
 vi.spyOn(client.disk.vault.adapter, 'write').mockRejectedValueOnce(new Error('Disk full'));
 await expect(client.api.restoreFileVersion(version)).rejects.toThrow('Disk full');
 expect(client.requests.some(path => path.includes('restore-version'))).toBe(false);
 expect(await live()).toBeNull();
 await client.api.restoreFileVersion(version); expect((await live())?.hash).toBe(version.hash);
 expect(await env.DB.prepare('SELECT count(*) AS n FROM upload_operations').first()).toEqual({ n: 1 });
});
