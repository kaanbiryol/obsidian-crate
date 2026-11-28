/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../../protocol/server-info';
import { createReminderOperationId } from '../../../protocol/reminder-operation';
import { D1_USAGE_HEADER, parseD1Usage } from '../../../protocol/d1-usage';
import { BATCH_MOVE_MAX_FILES } from '../../../protocol/sync-limits';
import type { BatchMoveResponse } from '../../../protocol/sync-types';
import { sha256Hex } from '../../../platform/sha256';
import { D1_QUERIES_PER_INVOCATION } from '../d1/platform-limits';
import { meterD1Usage } from '../d1/d1-usage';
import { drainObjectCleanupQueue, expireFileVersions } from '../maintenance/object-cleanup';
import { cleanUploadLeases } from '../maintenance/upload-lease-cleanup';
import { createSharedCheckpoint, FILE_MOVE_PRUNE_BATCH, getSharedCheckpoint, pruneSharedCheckpoints } from './history-checkpoints';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT OR REPLACE INTO auth_tokens (id, token_hash, scope) VALUES ('owner', ?, 'vault')").bind(await sha256Hex('owner')).run();
});
afterEach(reset);

interface Live { path: string; hash: string; storage_key: string }
const DAY = 86_400_000;
const operationId = () => createReminderOperationId(Math.floor(Date.now() / DAY));
const headers = (extra: Record<string, string> = {}) => ({ Authorization: 'Bearer owner', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current),
	'Content-Type': 'application/json', ...extra });
const post = (route: string, body: unknown) => worker.fetch(new Request(`https://worker.test${route}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) }), env);
const live = (path: string) => env.DB.prepare('SELECT path, hash, storage_key FROM files WHERE path = ?').bind(path).first<Live>();
const usage = (response: Response) => parseD1Usage(response.headers.get(D1_USAGE_HEADER))!;
const objectCount = async () => (await env.BUCKET.list()).objects.length;
const changelog = async () => (await env.DB.prepare('SELECT path, action, hash, revision FROM changelog ORDER BY seq').all<{ path: string; action: string; hash: string; revision: string }>()).results;

/** Uploads `files` (path to text) through the batch route, 32 per request. */
async function upload(files: Record<string, string>): Promise<Response[]> {
	const entries = Object.entries(files), responses: Response[] = [];
	for (let offset = 0; offset < entries.length; offset += 32) {
		const batch = await Promise.all(entries.slice(offset, offset + 32).map(async ([path, text]) =>
			({ path, operationId: operationId(), expectedHash: (await live(path))?.hash ?? null, content: btoa(text) })));
		const response = await post('/sync/batch-upload', { files: batch });
		expect(response.status, await response.clone().text()).toBe(200);
		responses.push(response);
	}
	return responses;
}
async function moveRequest(pairs: Array<[from: string, to: string]>): Promise<Array<{ from: string; to: string; expectedHash: string; expectedRevision: string }>> {
	return Promise.all(pairs.map(async ([from, to]) => {
		const row = (await live(from))!;
		return { from, to, expectedHash: row.hash, expectedRevision: row.storage_key };
	}));
}
async function move(pairs: Array<[from: string, to: string]>) {
	const response = await post('/sync/batch-move', { moves: await moveRequest(pairs) });
	return { response, body: await response.clone().json() as BatchMoveResponse };
}
const names = (count: number, folder: string) => Array.from({ length: count }, (_, index) => `${folder}/note ${index}.md`);

it('moves a full batch without writing R2, keeping each revision, for under half the rows of delete and upload', async () => {
	const sources = names(BATCH_MOVE_MAX_FILES, 'Old');
	await upload(Object.fromEntries(sources.map(path => [path, `body of ${path}`])));
	const before = await Promise.all(sources.map(async path => (await live(path))!));
	const objects = await objectCount();

	const { response, body } = await move(sources.map(path => [path, path.replace('Old/', 'New/')]));
	expect(response.status).toBe(200);
	expect(body.success).toBe(true);
	expect(body.results).toEqual(before.map(row => ({ from: row.path, to: row.path.replace('Old/', 'New/'), success: true, hash: row.hash, revision: row.storage_key })));
	expect(await objectCount()).toBe(objects);
	for (const row of before) {
		expect(await live(row.path)).toBeNull();
		expect(await live(row.path.replace('Old/', 'New/'))).toMatchObject({ hash: row.hash, storage_key: row.storage_key });
		const download = await worker.fetch(new Request(`https://worker.test/sync/download?path=${encodeURIComponent(row.path.replace('Old/', 'New/'))}`, { headers: headers() }), env);
		expect(new TextDecoder().decode(await download.arrayBuffer())).toBe(`body of ${row.path}`);
	}
	// Receivers see the same delete and same-hash put a rename always produced.
	const entries = (await changelog()).slice(-2 * sources.length);
	expect(entries.filter(entry => entry.action === 'delete').map(entry => entry.path).sort()).toEqual([...sources].sort());
	expect(entries.filter(entry => entry.action === 'put').map(({ path, hash, revision }) => ({ path, hash, revision })))
		.toEqual(before.map(row => ({ path: row.path.replace('Old/', 'New/'), hash: row.hash, revision: row.storage_key })));
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM file_versions').first()).toEqual({ count: 0 });

	const moved = usage(response);
	expect(moved.queries).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION);
	// The same renames as an upload of each new path and a delete of each old one.
	const baselineSources = names(BATCH_MOVE_MAX_FILES, 'Before');
	await upload(Object.fromEntries(baselineSources.map(path => [path, `other ${path}`])));
	const deletes = await Promise.all(baselineSources.map(async path => ({ path, expectedHash: (await live(path))!.hash, expectedRevision: (await live(path))!.storage_key })));
	const uploads = await upload(Object.fromEntries(baselineSources.map(path => [path.replace('Before/', 'After/'), `other ${path}`])));
	const deleted = await post('/sync/batch-delete', { files: deletes });
	expect(deleted.status).toBe(200);
	const baseline = usage(uploads[0]!).rowsWritten + usage(deleted).rowsWritten;
	// Later cleanup: the move log once no checkpoint precedes it, the deleted copies once they expire.
	await env.DB.prepare('DELETE FROM history_checkpoints').run();
	const pruneMeter = meterD1Usage(env.DB);
	await pruneSharedCheckpoints(pruneMeter.db, Date.now(), { moves: true });
	const expiryMeter = meterD1Usage(env.DB);
	while (await expireFileVersions(env.BUCKET, expiryMeter.db, Date.now() + 400 * DAY)) { /* drain */ }
	await drainObjectCleanupQueue(env.BUCKET, expiryMeter.db);
	console.info('crate.move-cost', { files: BATCH_MOVE_MAX_FILES, moveRowsWritten: moved.rowsWritten, movePruneRowsWritten: pruneMeter.usage.rowsWritten,
		uploadAndDeleteRowsWritten: baseline, versionExpiryRowsWritten: expiryMeter.usage.rowsWritten });
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM file_moves').first()).toEqual({ count: 0 });
	expect(moved.rowsWritten / BATCH_MOVE_MAX_FILES).toBeLessThanOrEqual(5);
	expect((moved.rowsWritten + pruneMeter.usage.rowsWritten) * 2).toBeLessThan(baseline + expiryMeter.usage.rowsWritten);
});

it('answers a retry after a lost response from the moved row, writing nothing', async () => {
	await upload({ 'a.md': 'alpha' });
	const request = await moveRequest([['a.md', 'b.md']]);
	expect((await post('/sync/batch-move', { moves: request })).status).toBe(200);
	const entries = await changelog();
	const retry = await post('/sync/batch-move', { moves: request });
	expect(await retry.json()).toEqual({ success: true, results: [{ from: 'a.md', to: 'b.md', success: true, hash: request[0]!.expectedHash, revision: request[0]!.expectedRevision }] });
	expect(await changelog()).toEqual(entries);
});

it('refuses moves it cannot make and changes nothing for them', async () => {
	await upload({ 'stale.md': 'one', 'taken.md': 'two', 'occupied.md': 'three', 'blocked.md': 'four', 'file.md': 'five', 'reminder.md': 'six', 'Reminders/task.md': '- [ ] Task' });
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	const request = await moveRequest([['stale.md', 'stale moved.md'], ['taken.md', 'occupied.md'], ['blocked.md', 'file.md/child.md'],
		['reminder.md', 'Reminders/reminder.md'], ['Reminders/task.md', 'task.md']]);
	request[0]!.expectedHash = await sha256Hex('older bytes');
	const entries = await changelog();
	const response = await post('/sync/batch-move', { moves: [...request, { from: 'x.md', to: 'X.md', expectedHash: request[1]!.expectedHash, expectedRevision: 'r' }] });
	const body = await response.json() as BatchMoveResponse;
	expect(body.success).toBe(false);
	expect(body.results.map(result => [result.from, result.code])).toEqual([
		['stale.md', 'version_conflict'], ['taken.md', 'version_conflict'], ['blocked.md', 'move_unsupported'],
		['reminder.md', 'move_unsupported'], ['Reminders/task.md', 'move_unsupported'], ['x.md', 'validation'],
	]);
	expect(await changelog()).toEqual(entries);
	for (const path of ['stale.md', 'taken.md', 'blocked.md', 'reminder.md', 'Reminders/task.md']) expect(await live(path)).not.toBeNull();
});

it('refuses a key a lease or cleanup still names', async () => {
	await upload({ 'leased.md': 'leased', 'queued.md': 'queued' });
	const leased = (await live('leased.md'))!, queued = (await live('queued.md'))!;
	await env.DB.prepare("INSERT INTO upload_leases(id, keys, expires_at) VALUES ('lease', ?, 0)").bind(JSON.stringify([{ storageKey: leased.storage_key, path: 'leased.md' }])).run();
	await env.DB.prepare('INSERT INTO object_cleanup_queue(storage_key, file_path) VALUES (?, ?)').bind(queued.storage_key, 'queued.md').run();
	const { body } = await move([['leased.md', 'leased moved.md'], ['queued.md', 'queued moved.md']]);
	expect(body.results.map(result => result.code)).toEqual(['move_unsupported', 'move_unsupported']);
});

const saveCheckpoint = async () => (await (await createSharedCheckpoint(env.DB)).json() as { checkpoint: { id: string } }).checkpoint.id;
const rebuild = async (id: string) => Object.fromEntries(Object.entries((await (await getSharedCheckpoint(new Request(`https://test/sync/checkpoint?id=${id}`), env.DB))
	.json() as { files: Record<string, { revision: string }> }).files).map(([path, file]) => [path, file.revision]));
const checkpointFile = (id: string, path: string, revision: string) =>
	worker.fetch(new Request(`https://worker.test/sync/checkpoint-file?id=${id}&path=${encodeURIComponent(path)}&revision=${encodeURIComponent(revision)}`, { headers: headers() }), env);

it('lists a moved file at its path then in earlier checkpoints and keeps its object until nothing references it', async () => {
	await upload({ 'Inbox/idea.md': 'first idea' });
	const original = (await live('Inbox/idea.md'))!;
	const beforeMoves = await saveCheckpoint();
	expect((await move([['Inbox/idea.md', 'Archive/idea.md']])).body.success).toBe(true);
	const betweenMoves = await saveCheckpoint();
	expect((await move([['Archive/idea.md', 'Done/idea.md']])).body.success).toBe(true);

	expect(await rebuild(beforeMoves)).toEqual({ 'Inbox/idea.md': original.storage_key });
	expect(await rebuild(betweenMoves)).toEqual({ 'Archive/idea.md': original.storage_key });
	expect(await rebuild(await saveCheckpoint())).toEqual({ 'Done/idea.md': original.storage_key });
	for (const [id, path] of [[beforeMoves, 'Inbox/idea.md'], [betweenMoves, 'Archive/idea.md']] as const) {
		expect(new TextDecoder().decode(await (await checkpointFile(id, path, original.storage_key)).arrayBuffer())).toBe('first idea');
	}
	expect((await checkpointFile(beforeMoves, 'Elsewhere/idea.md', original.storage_key)).status).toBe(410);

	// Maintenance, at any time, leaves the object of a live moved file alone.
	const far = Date.now() + 400 * DAY;
	await drainObjectCleanupQueue(env.BUCKET, env.DB);
	await cleanUploadLeases(env.BUCKET, env.DB, far);
	await expireFileVersions(env.BUCKET, env.DB, far);
	expect(await env.BUCKET.head(original.storage_key)).not.toBeNull();

	// Once it is replaced and deleted, its kept copy at the new path owns the object until it
	// expires, and earlier checkpoints still list that copy at its path then.
	await env.DB.prepare('UPDATE history_checkpoints SET created_at = created_at - ?').bind(11 * 60_000).run();
	await upload({ 'Done/idea.md': 'second idea' });
	const replaced = (await live('Done/idea.md'))!;
	expect((await post('/sync/batch-delete', { files: [{ path: 'Done/idea.md', expectedHash: replaced.hash, expectedRevision: replaced.storage_key }] })).status).toBe(200);
	expect(await env.DB.prepare('SELECT path FROM file_versions WHERE storage_key = ?').bind(original.storage_key).first()).toEqual({ path: 'Done/idea.md' });
	expect(await rebuild(beforeMoves)).toEqual({ 'Inbox/idea.md': original.storage_key });
	expect(new TextDecoder().decode(await (await checkpointFile(beforeMoves, 'Inbox/idea.md', original.storage_key)).arrayBuffer())).toBe('first idea');
	await expireFileVersions(env.BUCKET, env.DB);
	expect(await env.BUCKET.head(original.storage_key)).not.toBeNull();
	while (await expireFileVersions(env.BUCKET, env.DB, far)) { /* drain */ }
	expect(await env.BUCKET.head(original.storage_key)).toBeNull();
});

it('lists both files in a checkpoint from before a move onto a path whose older file it kept', async () => {
	await upload({ 'old.md': 'removed later', 'source.md': 'source' });
	const old = (await live('old.md'))!, source = (await live('source.md'))!;
	const checkpoint = await saveCheckpoint();
	expect((await post('/sync/batch-delete', { files: [{ path: 'old.md', expectedHash: old.hash, expectedRevision: old.storage_key }] })).status).toBe(200);
	expect((await move([['source.md', 'old.md']])).body.success).toBe(true);
	expect(await rebuild(checkpoint)).toEqual({ 'old.md': old.storage_key, 'source.md': source.storage_key });
	expect(await rebuild(await saveCheckpoint())).toEqual({ 'old.md': source.storage_key });
});

it('prunes the moves no kept checkpoint precedes', async () => {
	await upload({ 'a.md': 'alpha', 'b.md': 'beta' });
	await saveCheckpoint();
	expect((await move([['a.md', 'moved a.md']])).body.success).toBe(true);
	const between = await saveCheckpoint();
	expect((await move([['b.md', 'moved b.md']])).body.success).toBe(true);
	const moves = async () => (await env.DB.prepare('SELECT from_path FROM file_moves ORDER BY seq').all<{ from_path: string }>()).results.map(row => row.from_path);
	await pruneSharedCheckpoints(env.DB, Date.now(), { moves: true });
	expect(await moves()).toEqual(['a.md', 'b.md']);

	await env.DB.prepare('DELETE FROM history_checkpoints WHERE seq < (SELECT seq FROM history_checkpoints ORDER BY seq LIMIT 1 OFFSET 1)').run();
	await pruneSharedCheckpoints(env.DB, Date.now(), { moves: true });
	expect(Object.keys(await rebuild(between)).sort()).toEqual(['b.md', 'moved a.md']);
	expect(await moves()).toEqual(['b.md']);

	await env.DB.prepare('DELETE FROM history_checkpoints').run();
	await pruneSharedCheckpoints(env.DB, Date.now(), { moves: true });
	expect(await moves()).toEqual([]);

	// One pass removes a bounded batch; the next episode removes the rest.
	await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO file_moves (storage_key, seq, from_path, to_portable) SELECT 'key-' || i, i, 'a.md', 'b.md' FROM n`).bind(FILE_MOVE_PRUNE_BATCH + 5).run();
	const meter = meterD1Usage(env.DB);
	await pruneSharedCheckpoints(meter.db, Date.now(), { moves: true });
	expect(meter.usage.rowsWritten).toBeLessThanOrEqual(FILE_MOVE_PRUNE_BATCH);
	expect(await moves()).toHaveLength(5);
});
