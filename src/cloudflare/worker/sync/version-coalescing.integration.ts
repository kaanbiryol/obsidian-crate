/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '../../../protocol/server-info';
import { createReminderOperationId } from '../../../protocol/reminder-operation';
import type { RemoteFileVersion } from '../../../protocol/sync-types';
import { sha256Hex } from '../../../platform/sha256';
import { drainObjectCleanupQueue } from '../maintenance/object-cleanup';
import { writeCommittedMarkdownFile } from '../storage';
import { writeCommittedMarkdownFilePair } from './atomic-markdown-write';
import { createSharedCheckpoint } from './history-checkpoints';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens (id, token_hash, scope) VALUES ('owner', ?, 'vault')").bind(await sha256Hex('owner')).run();
});
afterEach(reset);

const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86_400_000));
const headers = (extra: Record<string, string> = {}) => ({ Authorization: 'Bearer owner', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), ...extra });
const live = (path: string) => env.DB.prepare('SELECT hash, storage_key FROM files WHERE path = ?').bind(path).first<{ hash: string; storage_key: string }>();
const keys = async (table: 'file_versions' | 'object_cleanup_queue') =>
	(await env.DB.prepare(`SELECT storage_key FROM ${table} ORDER BY storage_key`).all<{ storage_key: string }>()).results.map(row => row.storage_key).sort();
/** Simulates elapsed time: the live copy became current, or each retained version was kept, `minutes` ago. */
const liveFor = (path: string, minutes: number) => env.DB.prepare("UPDATE files SET modified = datetime('now', ?) WHERE path = ?").bind(`-${minutes} minutes`, path).run();
const retainedAgo = (minutes: number) => env.DB.prepare("UPDATE file_versions SET created_at = datetime('now', ?)").bind(`-${minutes} minutes`).run();

/** Saves `content` over the current file through a real upload route and returns the new revision. */
async function save(kind: 'single' | 'batch', path: string, content: string | Uint8Array<ArrayBuffer>): Promise<string> {
	const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
	const expected = (await live(path))?.hash ?? null;
	const response = kind === 'single'
		? await worker.fetch(new Request(`https://worker.test/sync/upload?path=${encodeURIComponent(path)}`, { method: 'PUT', body: bytes,
			headers: headers({ 'Content-Type': 'application/octet-stream', 'X-Crate-Expected-Hash': expected ?? 'absent', 'X-Crate-Upload-Operation': operationId() }) }), env)
		: await worker.fetch(new Request('https://worker.test/sync/batch-upload', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
			body: JSON.stringify({ files: [{ path, operationId: operationId(), expectedHash: expected, content: btoa(String.fromCharCode(...bytes)) }] }) }), env);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await live(path))!.storage_key;
}

it.each([
	['single', 'drawing.excalidraw'], ['batch', 'drawing.excalidraw'], ['single', 'note.md'], ['batch', 'note.md'],
] as const)('keeps one replaced version per window during rapid %s saves of %s and removes the others from R2', async (kind, path) => {
	const before = await save(kind, path, 'before the session');
	await liveFor(path, 24 * 60);
	const first = await save(kind, path, 'save 1');
	const second = await save(kind, path, 'save 2');
	const third = await save(kind, path, 'save 3');
	// The pre-session copy is kept; copies live for seconds while a version is recent are not.
	expect(await keys('file_versions')).toEqual([before]);
	expect(await keys('object_cleanup_queue')).toEqual([first, second].sort());
	await retainedAgo(11);
	await save(kind, path, 'save 4');
	expect(await keys('file_versions')).toEqual([before, third].sort());

	expect(await drainObjectCleanupQueue(env.BUCKET, env.DB)).toBe(2);
	expect(await keys('object_cleanup_queue')).toEqual([]);
	for (const key of [first, second]) expect(await env.BUCKET.get(key)).toBeNull();
	for (const key of [before, third, (await live(path))!.storage_key]) expect(await env.BUCKET.get(key)).not.toBeNull();
});

it('keeps a copy that was live for the whole window even when a version was just retained', async () => {
	const first = await save('single', 'notes.txt', 'first');
	const second = await save('single', 'notes.txt', 'second');
	expect(await keys('file_versions')).toEqual([first]);
	await liveFor('notes.txt', 11);
	await save('single', 'notes.txt', 'third');
	expect(await keys('file_versions')).toEqual([first, second].sort());
	expect(await keys('object_cleanup_queue')).toEqual([]);
});

it('uses a sixty-minute window for files of 1 MiB or more', async () => {
	const large = (fill: number) => new Uint8Array(1024 * 1024).fill(fill);
	const first = await save('single', 'video.bin', large(1));
	await save('single', 'video.bin', large(2));
	expect(await keys('file_versions')).toEqual([first]);
	await liveFor('video.bin', 11); await retainedAgo(11);
	const dropped = (await live('video.bin'))!.storage_key;
	await save('single', 'video.bin', large(3));
	expect(await keys('file_versions')).toEqual([first]);
	expect(await keys('object_cleanup_queue')).toEqual([dropped]);
	await liveFor('video.bin', 61);
	const lived = (await live('video.bin'))!.storage_key;
	await save('single', 'video.bin', large(4));
	await retainedAgo(61);
	const recent = (await live('video.bin'))!.storage_key;
	await save('single', 'video.bin', large(5));
	expect(await keys('file_versions')).toEqual([first, lived, recent].sort());
});

it('lists kept versions and restores one, keeping the copy an explicit restore replaces', async () => {
	const original = await save('single', 'notes.txt', 'original');
	await save('single', 'notes.txt', 'edit 1');
	await save('single', 'notes.txt', 'edit 2');
	const list = await worker.fetch(new Request('https://worker.test/sync/versions?path=notes.txt', { headers: headers() }), env);
	const { versions } = await list.json() as { versions: RemoteFileVersion[] };
	expect(versions.map(version => version.storage_key)).toEqual([original]);
	const replaced = (await live('notes.txt'))!;
	const restore = await worker.fetch(new Request('https://worker.test/sync/restore-version', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
		body: JSON.stringify({ path: 'notes.txt', storageKey: original, expectedHash: replaced.hash, expectedRevision: replaced.storage_key, operationId: operationId() }) }), env);
	expect(restore.status, await restore.clone().text()).toBe(200);
	expect(await (await env.BUCKET.get((await live('notes.txt'))!.storage_key))!.text()).toBe('original');
	expect(await keys('file_versions')).toEqual([original, replaced.storage_key].sort());
});

it('coalesces Worker-side Markdown commits and atomic two-file writes', async () => {
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	const read = async (path: string) => (await live(path))!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/a.md', '- [ ] One <!-- crate-id:one -->', null);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/b.md', '- [ ] Two <!-- crate-id:two -->', null);
	const [a1, b1] = [await read('Reminders/a.md'), await read('Reminders/b.md')];
	await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, {
		source: { path: 'Reminders/a.md', content: '# A', expectedHash: a1.hash },
		destination: { path: 'Reminders/b.md', content: '- [ ] Two <!-- crate-id:two -->\n- [ ] One <!-- crate-id:one -->', expectedHash: b1.hash },
	});
	expect(await keys('file_versions')).toEqual([a1.storage_key, b1.storage_key].sort());
	const [a2, b2] = [await read('Reminders/a.md'), await read('Reminders/b.md')];
	await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, {
		source: { path: 'Reminders/a.md', content: '- [ ] One <!-- crate-id:one -->', expectedHash: a2.hash },
		destination: { path: 'Reminders/b.md', content: '- [ ] Two <!-- crate-id:two -->', expectedHash: b2.hash },
	});
	const a3 = await read('Reminders/a.md');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/a.md', '- [x] One <!-- crate-id:one -->', a3.hash);
	expect(await keys('file_versions')).toEqual([a1.storage_key, b1.storage_key].sort());
	expect(await keys('object_cleanup_queue')).toEqual([a2.storage_key, b2.storage_key, a3.storage_key].sort());
});

it('answers a checkpoint read of a coalesced version with a distinct code', async () => {
	await save('single', 'notes.txt', 'first');
	await save('single', 'notes.txt', 'second');
	const checkpointed = (await live('notes.txt'))!.storage_key;
	const { checkpoint } = await (await createSharedCheckpoint(env.BUCKET, env.DB)).json() as { checkpoint: { id: string } };
	await save('single', 'notes.txt', 'third');
	expect(await keys('object_cleanup_queue')).toEqual([checkpointed]);
	const response = await worker.fetch(new Request(`https://worker.test/sync/checkpoint-file?id=${checkpoint.id}&path=notes.txt&revision=${encodeURIComponent(checkpointed)}`, { headers: headers() }), env);
	expect(response.status).toBe(410);
	expect(await response.json()).toMatchObject({ code: 'version_unavailable' });
});
