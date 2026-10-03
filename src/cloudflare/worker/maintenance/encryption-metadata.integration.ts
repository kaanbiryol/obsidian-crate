/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../../schema.sql?raw';
import { pruneEncryptionMetadata } from './encryption-metadata';

beforeEach(async () => {
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
	await env.DB.prepare(`INSERT INTO maintenance_state(key, value) VALUES ('e2ee:state', '{"mode":"active"}')`).run();
});
afterEach(async () => { await reset(); });

async function descriptor(revision: string, age = '-2 days') {
	await env.DB.prepare("INSERT INTO maintenance_state(key, value, updated_at) VALUES (?, 'opaque descriptor', datetime('now', ?))").bind('e2ee:file:' + revision, age).run();
}
async function retained() {
	return (await env.DB.prepare("SELECT key FROM maintenance_state WHERE key GLOB 'e2ee:file:*' ORDER BY key").all<{ key: string }>()).results.map(row => row.key.slice('e2ee:file:'.length));
}

it('removes only old unreferenced descriptors and preserves data, receipts, and upload leases', async () => {
	const references = ['live', 'history', 'changelog', 'deletion', 'receipt', 'upload', 'batch-legacy', 'batch-owned'];
	for (const revision of [...references, 'orphan']) await descriptor(revision);
	await descriptor('new', '-1 hour');
	await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('live.md', 'live.md', 'live')").run();
	await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES ('history', 'old.md', 'hash', 1, 'replaced', 0)").run();
	await env.DB.prepare("INSERT INTO changelog(path, action, revision) VALUES ('changed.md', 'put', 'changelog')").run();
	await env.DB.prepare("INSERT INTO file_deletion_receipts(consumed_revision, revision, changelog_seq, path, consumed_hash, request_id) VALUES ('deletion', 'deleted', 1, 'deleted.md', 'hash', 'request')").run();
	await env.DB.prepare(`INSERT INTO upload_operations(operation_id, request_hash, response_json) VALUES ('operation', 'hash', '{"revision":"receipt"}')`).run();
	await env.DB.prepare("INSERT INTO staged_uploads(storage_key) VALUES ('upload')").run();
	await env.DB.prepare(`INSERT INTO staged_upload_batches(id, storage_keys) VALUES ('batch', '["batch-legacy", {"storageKey":"batch-owned"}]')`).run();
	await pruneEncryptionMetadata(env.DB);
	expect(await retained()).toEqual([...references, 'new'].sort());
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toEqual({ n: 1 });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM file_versions').first()).toEqual({ n: 1 });
	await env.DB.prepare("DELETE FROM upload_operations WHERE operation_id = 'operation'").run();
	await pruneEncryptionMetadata(env.DB);
	expect(await retained()).not.toContain('receipt');
});

it('retains everything during conversion and advances bounded pages past live revisions', async () => {
	for (let index = 0; index < 105; index++) await descriptor(String(index).padStart(3, '0'));
	await env.DB.prepare(`UPDATE maintenance_state SET value = '{"mode":"converting"}' WHERE key = 'e2ee:state'`).run();
	await pruneEncryptionMetadata(env.DB);
	expect(await retained()).toHaveLength(105);
	await env.DB.prepare(`UPDATE maintenance_state SET value = '{"mode":"active"}' WHERE key = 'e2ee:state'`).run();
	await pruneEncryptionMetadata(env.DB); // remaining five from the first pass
	expect(await retained()).toHaveLength(100);
	await pruneEncryptionMetadata(env.DB);
	expect(await retained()).toHaveLength(0);
});

it('rechecks references created after the cleanup page was read', async () => {
	await descriptor('publishing');
	const db = { prepare: env.DB.prepare.bind(env.DB), batch: async (statements: D1PreparedStatement[]) => {
		await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('new.md', 'new.md', 'publishing')").run();
		return env.DB.batch(statements);
	} } as D1Database;
	await pruneEncryptionMetadata(db);
	expect(await retained()).toEqual(['publishing']);
});
