/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleReadingRoute } from '../test-support/reading-route-test-harness';
import { publishCapture, type PendingCapture } from './captures';
import { pruneReadingRemovals } from './library-index';
import { READING_LIST_PAGE } from './queries';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { DELTA_BASE_HEADER } from '@/protocol/http-headers';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { commitFileDelete } from '../sync/mutations';
import { getStoredFileRow } from '../sync/storage';
import { createReadingNote } from '@/reading/core/notes';

interface ListBody { delta?: true; changedPaths?: string[]; items: Array<{ crate_reading_id: string; path: string; saved_at: string }>; issues: Array<{ path: string; message: string }>; cursor: string | null }
const principal = { tokenId: 'vault', scope: 'vault' as const };
const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
const command = (action: string, body: Record<string, unknown>) => handleReadingRoute(new Request(`https://test/reading/${action}`, { method: 'POST', body: JSON.stringify(body) }), env, principal);
async function list(since?: string | null) {
	const response = await handleReadingRoute(new Request(`https://test/reading/list${since ? `?since=${encodeURIComponent(since)}` : ''}`), env, principal);
	expect(response.status).toBe(200);
	return { body: await response.json() as ListBody, etag: response.headers.get('ETag'), base: response.headers.get(DELTA_BASE_HEADER) };
}
async function note(path: string, { id = crypto.randomUUID(), savedAt = new Date().toISOString() } = {}) {
	const existing = await getStoredFileRow(env.DB, path);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, createReadingNote({ id, url: `https://example.invalid/${id}`, savedAt }), existing?.hash ?? null);
	return id;
}
async function remove(path: string) {
	const file = (await getStoredFileRow(env.DB, path))!;
	await commitFileDelete(env.DB, { path, previousFile: file, expectedHash: file.hash, expectedRevision: file.storageKey });
}
/** What a client holding `previous` shows after applying `delta`. */
function merged(previous: ListBody, delta: ListBody) {
	const changed = new Set(delta.changedPaths);
	return {
		ids: [...delta.items, ...previous.items.filter(item => item.path && !changed.has(item.path))].map(item => item.crate_reading_id).sort(),
		issues: [...previous.issues.filter(issue => !changed.has(issue.path)), ...delta.issues].map(issue => issue.path).sort(),
	};
}
const shown = (body: ListBody) => ({ ids: body.items.map(item => item.crate_reading_id).sort(), issues: body.issues.map(issue => issue.path).sort() });

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
	expect((await command('policy', { enabled: true, folderPath: 'Reading', revision: null })).status).toBe(200);
});
afterEach(reset);

it('pages newest first', async () => {
	await note('Reading/Z.md', { savedAt: '2026-01-01T00:00:00.000Z' });
	await note('Reading/A.md', { savedAt: '2026-03-01T00:00:00.000Z' });
	await note('Reading/M.md', { savedAt: '2026-02-01T00:00:00.000Z' });
	expect((await list()).body.items.map(item => item.path)).toEqual(['Reading/A.md', 'Reading/M.md', 'Reading/Z.md']);
	const malformed = await handleReadingRoute(new Request('https://test/reading/list?cursor=not-json'), env, principal);
	expect(malformed.status).toBe(400);
});

it('answers a delta base with only changed and removed notes and the whole capture queue', async () => {
	await note('Reading/A.md'); await note('Reading/B.md');
	const first = await list();
	expect(first.base).toMatch(/^\d+\.[a-f0-9]{32}$/);
	expect(first.body).not.toHaveProperty('delta');
	await note('Reading/B.md');
	await remove('Reading/A.md');
	await note('Reading/C.md');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Notes/Elsewhere.md', 'Unrelated', null);
	expect((await command('capture', { url: 'https://example.com/queued', operationId: operation() })).status).toBe(200);

	const delta = await list(first.base);
	expect(delta.body).toMatchObject({ delta: true, cursor: null, issues: [] });
	expect([...delta.body.changedPaths!].sort()).toEqual(['Reading/A.md', 'Reading/B.md', 'Reading/C.md']);
	expect(delta.body.items.map(item => item.path).sort()).toEqual(['', 'Reading/B.md', 'Reading/C.md']);
	const full = await list();
	expect(merged(first.body, delta.body)).toEqual(shown(full.body));
	expect(delta.etag).toBe(full.etag);

	// Writes elsewhere in the vault leave nothing to replay.
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Notes/Other.md', 'Unrelated', null);
	expect((await list(delta.base)).body).toMatchObject({ delta: true, changedPaths: [], items: [{ path: '' }] });

	// Publishing the capture removes it from the queue and writes its note.
	const queued = (await env.DB.prepare('SELECT * FROM reading_captures').first<PendingCapture>())!;
	await publishCapture(env, queued.id, queued.generation, null);
	const published = await list(delta.base);
	expect(published.body.changedPaths).toHaveLength(1);
	expect(published.body.items).toEqual([expect.objectContaining({ crate_reading_id: queued.id, path: published.body.changedPaths![0] })]);
	// The client then holds what `full` listed.
	expect(merged(full.body, published.body)).toEqual(shown((await list()).body));
});

it('replays the notes a shared Reading ID hides or shows', async () => {
	const shared = await note('Reading/A.md');
	const first = await list();
	await note('Reading/B.md', { id: shared });
	const hidden = await list(first.base);
	expect(hidden.body).toMatchObject({ delta: true, items: [] });
	expect([...hidden.body.changedPaths!].sort()).toEqual(['Reading/A.md', 'Reading/B.md']);
	const before = await list();
	expect(merged(first.body, hidden.body)).toEqual(shown(before.body));
	// Ending the duplicate in B lists A again, although A did not change.
	await note('Reading/B.md');
	const resolved = await list(hidden.base);
	expect([...resolved.body.changedPaths!].sort()).toEqual(['Reading/A.md', 'Reading/B.md']);
	const after = await list();
	expect(merged(before.body, resolved.body)).toEqual(shown(after.body));
	expect(shown(after.body).ids).toContain(shared);
});

it('lists everything when a delta cannot be proven', async () => {
	await note('Reading/A.md');
	const first = await list();
	await note('Reading/B.md');
	const [seq, suffix] = first.base!.split('.');
	// Another view, a malformed base, or a base from the future.
	for (const since of [`${seq}.${'0'.repeat(32)}`, 'not-a-base', `${Number(seq) + 100}.${suffix}`]) {
		expect((await list(since)).body).not.toHaveProperty('delta');
	}
	// A changed fetching setting changes issue messages without changing notes.
	await env.DB.prepare('UPDATE reading_policy SET enabled = 0').run();
	expect((await list(first.base)).body).not.toHaveProperty('delta');
	await env.DB.prepare('UPDATE reading_policy SET enabled = 1').run();
	// So do pruned removals the base would need.
	const current = await list();
	await remove('Reading/B.md');
	expect(await pruneReadingRemovals(env.DB, Date.now() + 31 * 86400_000)).toBe(false);
	expect(await env.DB.prepare('SELECT 1 FROM reading_removals').first()).toBeNull();
	expect((await list(current.base)).body).not.toHaveProperty('delta');
	const after = await list();
	expect((await list(after.base)).body).toMatchObject({ delta: true, changedPaths: [] });
	// And a rebuilt index, here for a new Reading generation.
	await env.DB.prepare("UPDATE reading_policy SET generation = 'other'").run();
	expect((await list(after.base)).body).not.toHaveProperty('delta');
});

it('lists everything when more notes changed than one page holds', async () => {
	await note('Reading/A.md');
	const first = await list();
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO reading_items(portable_path, path, storage_key, hash, size, change_seq) SELECT 'reading/x' || x || '.md', 'Reading/x' || x || '.md', 'k', '', 0, 1000 FROM n`)
		.bind(READING_LIST_PAGE + 1).run();
	await env.DB.prepare('UPDATE reading_index SET seq = 1000').run();
	expect((await list(first.base)).body).not.toHaveProperty('delta');
});
