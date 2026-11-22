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
import { writeCommittedMarkdownFile } from './markdown-files';
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
/** Simulates elapsed time: every checkpoint was saved `minutes` ago. */
const checkpointsAgo = (minutes: number) => env.DB.prepare('UPDATE history_checkpoints SET created_at = created_at - ?').bind(minutes * 60_000).run();

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
	['single', 'drawing.excalidraw'], ['batch', 'drawing.excalidraw'], ['single', 'note.md'], ['batch', 'note.md'], ['single', 'video.bin'],
] as const)('keeps one replaced version per checkpoint during rapid %s saves of %s and removes the others from R2', async (kind, path) => {
	const content = (text: string) => path.endsWith('.bin') ? new Uint8Array(1024 * 1024).fill(text.length) : text;
	const before = await save(kind, path, content('before the session'));
	// The first commit of a session saves a checkpoint, which keeps the copy before it.
	const first = await save(kind, path, content('save 1'));
	const second = await save(kind, path, content('save 2 .'));
	const third = await save(kind, path, content('save 3 ..'));
	// Copies live for seconds after the checkpoint are not.
	expect(await keys('file_versions')).toEqual([before]);
	expect(await keys('object_cleanup_queue')).toEqual([first, second].sort());
	await checkpointsAgo(11);
	await save(kind, path, content('save 4 ...'));
	expect(await keys('file_versions')).toEqual([before, third].sort());

	expect(await drainObjectCleanupQueue(env.BUCKET, env.DB)).toBe(2);
	expect(await keys('object_cleanup_queue')).toEqual([]);
	for (const key of [first, second]) expect(await env.BUCKET.get(key)).toBeNull();
	for (const key of [before, third, (await live(path))!.storage_key]) expect(await env.BUCKET.get(key)).not.toBeNull();
});

it('keeps the first version of a file created since the latest checkpoint, and one copy per checkpoint after', async () => {
	await save('single', 'other.md', 'other');
	await save('single', 'other.md', 'other edited');
	// A checkpoint exists; this file is created after it.
	const created = await save('single', 'new.md', 'first version');
	const second = await save('single', 'new.md', 'second version');
	await save('single', 'new.md', 'third version');
	expect(await keys('file_versions')).toContain(created);
	expect(await keys('file_versions')).not.toContain(second);
	expect(await keys('object_cleanup_queue')).toContain(second);
});

it('keeps the copy of a file untouched since the latest checkpoint while other files change', async () => {
	const quiet = await save('single', 'quiet.md', 'quiet');
	await save('single', 'busy.md', 'busy 1');
	await save('single', 'busy.md', 'busy 2');
	await checkpointsAgo(30);
	await save('single', 'busy.md', 'busy 3');
	await save('single', 'quiet.md', 'quiet edited');
	expect(await keys('file_versions')).toContain(quiet);
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
	// The second file's first commit saved a checkpoint with only the first file. The second
	// file's first version is kept as the first copy of its path since that checkpoint.
	expect(await keys('file_versions')).toEqual([a1.storage_key, b1.storage_key].sort());
	await checkpointsAgo(11);
	const [a2, b2] = [await read('Reminders/a.md'), await read('Reminders/b.md')];
	await writeCommittedMarkdownFilePair(env.BUCKET, env.DB, {
		source: { path: 'Reminders/a.md', content: '- [ ] One <!-- crate-id:one -->', expectedHash: a2.hash },
		destination: { path: 'Reminders/b.md', content: '- [ ] Two <!-- crate-id:two -->', expectedHash: b2.hash },
	});
	const a3 = await read('Reminders/a.md');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/a.md', '- [x] One <!-- crate-id:one -->', a3.hash);
	expect(await keys('file_versions')).toEqual([a1.storage_key, b1.storage_key, a2.storage_key, b2.storage_key].sort());
	expect(await keys('object_cleanup_queue')).toEqual([a3.storage_key]);
});

const checkpointFile = (id: string, path: string, revision: string) =>
	worker.fetch(new Request(`https://worker.test/sync/checkpoint-file?id=${id}&path=${encodeURIComponent(path)}&revision=${encodeURIComponent(revision)}`, { headers: headers() }), env);
const createCheckpoint = async () => (await (await createSharedCheckpoint(env.DB)).json() as { checkpoint: { id: string } }).checkpoint;

it('keeps the copy a shared checkpoint recorded when a bulk change replaces it within the window', async () => {
	// An edit keeps the older copy, a checkpoint records the edit, then a bulk change replaces it within ten minutes.
	const before = await save('single', 'notes.txt', 'before the session');
	const checkpointed = await save('single', 'notes.txt', 'checkpointed');
	const checkpoint = await createCheckpoint();
	const bulk = await save('single', 'notes.txt', 'bulk change');
	// A copy that became live after the checkpoint is still coalesced.
	await save('single', 'notes.txt', 'next change');
	await drainObjectCleanupQueue(env.BUCKET, env.DB);
	const response = await checkpointFile(checkpoint.id, 'notes.txt', checkpointed);
	expect(response.status, await response.clone().text()).toBe(200);
	expect(await response.text()).toBe('checkpointed');
	expect(await keys('file_versions')).toEqual([before, checkpointed].sort());
	expect(await env.BUCKET.get(bulk)).toBeNull();
});

it('answers a checkpoint read of a version that is no longer retained with a distinct code', async () => {
	await save('single', 'notes.txt', 'first');
	const checkpointed = await save('single', 'notes.txt', 'second');
	const checkpoint = await createCheckpoint();
	await save('single', 'notes.txt', 'third');
	// The saved version is no longer kept.
	await env.DB.prepare('UPDATE file_versions SET kept_at = 0 WHERE storage_key = ?').bind(checkpointed).run();
	const response = await checkpointFile(checkpoint.id, 'notes.txt', checkpointed);
	expect(response.status).toBe(410);
	expect(await response.json()).toMatchObject({ code: 'version_unavailable' });
});
