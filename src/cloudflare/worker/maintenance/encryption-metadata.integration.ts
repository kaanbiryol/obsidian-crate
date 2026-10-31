/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
import { DESCRIPTOR_CLEANUP_PAGE, pruneEncryptionMetadata, releaseExpiredVersionDescriptors, releasePrunedChangelogDescriptors } from './encryption-metadata';
import { enqueueExpiredFileVersions } from './object-cleanup';
import { runMaintenanceEpisode } from './lifecycle';
import { pruneChangelog } from '../db';
import { sealFile } from '../../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../../encryption/file-format';
import { createReminderOperationId } from '../../../protocol/reminder-operation';
import { handleUpload } from '../sync/file-handlers';
import { commitStagedFile } from '../sync/mutations';
import { commitNewFiles } from '../sync/staging/bulk-new-file-commit';
import { getStoredFileRow } from '../sync/storage';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare(`INSERT INTO server_state(id, encryption) VALUES (1, '{"mode":"active"}')`).run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

/** Descriptors are written with their revision's changelog entry, so tests give both the same age. */
async function descriptor(revision: string, age = '-40 days') {
	await env.DB.prepare("INSERT INTO maintenance_state(key, value, updated_at) VALUES (?, 'opaque descriptor', datetime('now', ?))").bind('e2ee:file:' + revision, age).run();
}
async function put(revision: string, path: string, age: string) {
	await env.DB.prepare("INSERT INTO changelog(path, action, revision, created_at) VALUES (?, 'put', ?, datetime('now', ?))").bind(path, revision, age).run();
}
async function retained() {
	return (await env.DB.prepare("SELECT key FROM maintenance_state WHERE key GLOB 'e2ee:file:*' ORDER BY key").all<{ key: string }>()).results.map(row => row.key.slice('e2ee:file:'.length));
}
async function many(count: number) {
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
		INSERT INTO maintenance_state(key, value, updated_at) SELECT 'e2ee:file:'||printf('%05d', x), 'opaque descriptor', datetime('now', '-40 days') FROM n`).bind(count).run();
}

it('sweeps old unreferenced and receipt-only descriptors, preserving data, history and upload leases', async () => {
	const references = ['live', 'history', 'changelog', 'deletion', 'upload', 'batch-owned'];
	for (const revision of [...references, 'receipt', 'orphan']) await descriptor(revision, revision === 'changelog' ? '-3 days' : '-40 days');
	await descriptor('new', '-1 hour');
	await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('live.md', 'live.md', 'live')").run();
	await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES ('history', 'old.md', 'hash', 1, 'replaced', 0)").run();
	await put('changelog', 'changed.md', '-3 days');
	await env.DB.prepare("INSERT INTO file_deletion_receipts(consumed_revision, revision, changelog_seq, path, consumed_hash, request_id) VALUES ('deletion', 'deleted', 1, 'deleted.md', 'hash', 'request')").run();
	// A replayed upload receipt returns its stored response and never needs the descriptor.
	await env.DB.prepare(`INSERT INTO upload_operations(operation_id, request_hash, response_json) VALUES ('operation', 'hash', '{"revision":"receipt"}')`).run();
	await env.DB.prepare("INSERT INTO staged_uploads(storage_key, file_path) VALUES ('upload', 'upload.md')").run();
	await env.DB.prepare(`INSERT INTO staged_upload_batches(id, storage_keys) VALUES ('batch', '[{"storageKey":"batch-owned"}, {"other":1}]')`).run();
	expect(await pruneEncryptionMetadata(env.DB, true)).toBe(false);
	expect(await retained()).toEqual([...references, 'new'].sort());
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toEqual({ n: 1 });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM file_versions').first()).toEqual({ n: 1 });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM upload_operations').first()).toEqual({ n: 1 });
});

it('retains everything during an encryption reset and continues a backlog only on passes that found one', async () => {
	await many(DESCRIPTOR_CLEANUP_PAGE + 5);
	await env.DB.prepare(`UPDATE server_state SET encryption = '{"mode":"resetting"}' WHERE id = 1`).run();
	expect(await pruneEncryptionMetadata(env.DB, true)).toBe(false);
	expect(await retained()).toHaveLength(DESCRIPTOR_CLEANUP_PAGE + 5);
	await env.DB.prepare(`UPDATE server_state SET encryption = '{"mode":"active"}' WHERE id = 1`).run();
	// That page found nothing, so a later pass of the episode skips the sweep.
	expect(await pruneEncryptionMetadata(env.DB, false)).toBe(false);
	expect(await retained()).toHaveLength(DESCRIPTOR_CLEANUP_PAGE + 5);
	expect(await pruneEncryptionMetadata(env.DB, true)).toBe(false); // the remaining five
	expect(await retained()).toHaveLength(DESCRIPTOR_CLEANUP_PAGE);
	expect(await pruneEncryptionMetadata(env.DB, true)).toBe(true);
	expect(await retained()).toHaveLength(0);
	expect(await pruneEncryptionMetadata(env.DB, false)).toBe(false);
	expect(await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key = 'e2ee:descriptor-cleanup-cursor'").first()).toBeNull();
});

it('rechecks references created after the cleanup page was read', async () => {
	await descriptor('publishing');
	const db = { prepare: (sql: string) => {
		const statement = env.DB.prepare(sql);
		if (!sql.startsWith('DELETE FROM maintenance_state WHERE key > ?')) return statement;
		return { bind: (...args: unknown[]) => ({ run: async () => {
			await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('new.md', 'new.md', 'publishing')").run();
			return statement.bind(...args).run();
		} }) };
	} } as D1Database;
	await pruneEncryptionMetadata(db, true);
	expect(await retained()).toEqual(['publishing']);
});

it('releases a descriptor in the changelog pruning transaction when that entry was its last reference', async () => {
	for (const revision of ['released', 'live', 'history', 'deletion', 'upload']) {
		await descriptor(revision, '-31 days');
		await put(revision, `${revision}.md`, '-31 days');
	}
	await put('newest', 'newest.md', '-1 minute');
	await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('live.md', 'live.md', 'live')").run();
	await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES ('history', 'history.md', 'hash', 1, 'replaced', ?)").bind(Date.now() + 60_000).run();
	await env.DB.prepare("INSERT INTO file_deletion_receipts(consumed_revision, revision, changelog_seq, path, consumed_hash, request_id) VALUES ('deletion', 'deleted', 99, 'deletion.md', 'hash', 'request')").run();
	await env.DB.prepare("INSERT INTO staged_uploads(storage_key, file_path) VALUES ('upload', 'upload.md')").run();
	expect(await pruneChangelog(env.DB, expired => releasePrunedChangelogDescriptors(env.DB, expired))).toBe(false);
	expect(await retained()).toEqual(['deletion', 'history', 'live', 'upload']);
	expect((await env.DB.prepare('SELECT revision FROM changelog').all()).results).toEqual([{ revision: 'newest' }]);
});

it('releases a descriptor in the version expiry transaction only after its changelog entry is gone', async () => {
	const now = Date.now();
	for (const [revision, age] of [['released', '-40 days'], ['logged', '-2 days'], ['deletion', '-40 days'], ['restored', '-40 days']] as const) {
		await descriptor(revision, age);
		await env.DB.prepare("INSERT INTO file_versions(storage_key, path, hash, size, reason, expires_at) VALUES (?, ?, 'hash', 1, 'deleted', ?)").bind(revision, `${revision}.md`, now - 1).run();
	}
	await put('logged', 'logged.md', '-2 days');
	await env.DB.prepare("INSERT INTO file_deletion_receipts(consumed_revision, revision, changelog_seq, path, consumed_hash, request_id) VALUES ('deletion', 'deleted', 99, 'deletion.md', 'hash', 'request')").run();
	await env.DB.prepare("INSERT INTO files(path, portable_path, storage_key) VALUES ('restored.md', 'restored.md', 'restored')").run();
	expect(await enqueueExpiredFileVersions(env.DB, now, expired => releaseExpiredVersionDescriptors(env.DB, expired))).toBe(false);
	expect(await retained()).toEqual(['deletion', 'logged', 'restored']);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM file_versions').first()).toEqual({ n: 0 });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM object_cleanup_queue').first()).toEqual({ n: 4 });
});

it('keeps pace with a descriptor backlog across scheduled passes within the query budget', async () => {
	await storeEncryptionState(env.DB, (await createEncryptionFixture('active')).state);
	await many(2 * DESCRIPTOR_CLEANUP_PAGE + 10);
	const values = new Map<string, unknown>();
	const setAlarm = vi.fn();
	const state = { storage: { get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => { values.set(key, value); }, setAlarm } } as never;
	let passes = 0;
	do {
		passes++;
		setAlarm.mockClear();
		const prepare = vi.spyOn(env.DB, 'prepare');
		await runMaintenanceEpisode(state, env);
		expect(prepare.mock.calls.length).toBeLessThanOrEqual(50);
		prepare.mockRestore();
	} while (setAlarm.mock.calls.length && passes < 10);
	expect(await retained()).toEqual([]);
	expect(passes).toBe(3);
});

it('replays an encrypted upload receipt after its revision and descriptor are gone', async () => {
	const fixture = await createEncryptionFixture('active');
	await storeEncryptionState(env.DB, fixture.state);
	const path = await fixture.paths.wire('note.md');
	const upload = async (text: string, expected: string | null, operation = createReminderOperationId(Math.floor(Date.now() / 86_400_000))) => {
		const file = await sealFile({ path: 'note.md', content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: null }, fixture.keys.forPath(path));
		const send = () => handleUpload(new Request(`https://test/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file.bytes,
			headers: { 'Content-Type': ENCRYPTED_FILE_CONTENT_TYPE, 'X-File-Hash': file.hash, 'X-File-Size': String(file.bytes.length),
				'X-Crate-Expected-Hash': expected ?? 'absent', 'X-Crate-Upload-Operation': operation } }), env.BUCKET, env.DB, { commitUpload: commitStagedFile, commitNewFiles });
		const response = await send();
		expect(response.status, await response.clone().text()).toBe(200);
		return { file, receipt: await response.json() as { revision: string }, send };
	};
	const first = await upload('first', null);
	await upload('second', first.file.hash);
	await env.DB.batch([
		env.DB.prepare('DELETE FROM file_versions'),
		env.DB.prepare('DELETE FROM maintenance_state WHERE key = ?').bind('e2ee:file:' + first.receipt.revision),
	]);
	const replay = await first.send();
	expect(replay.status).toBe(200);
	expect(await replay.json()).toEqual(first.receipt);
	expect((await getStoredFileRow(env.DB, path))!.storageKey).not.toBe(first.receipt.revision);
});
