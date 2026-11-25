/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../sync/markdown-files';
import { createReadingNote, updateReadingNote } from '@/reading/core/notes';
import { writeCommittedMarkdownMove } from '../sync/atomic-markdown-move';
import { commitFileDelete } from '../sync/mutations';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { ensureReadingIndex, READING_REBUILD_DAILY_ROWS } from './library-index';
import { meterD1Usage } from '../d1/d1-usage';
import { readStoredNote } from './common';
import { handleReadingRoute } from '../test-support/reading-route-test-harness';
import { getStoredFileRow } from '../sync/storage';
import { runNotificationCoordinator } from '../notifications/coordinator';
import { sha256Hex } from '@/platform/sha256';
import { updatePolicy } from './access';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';

const policy = { enabled: 0, folder_path: 'Reading', generation: 'g', revision: 'r' };
const principal = { tokenId: 'vault', scope: 'vault' as const };
const url = 'https://example.invalid/read';
const path = 'Reading/Note.md';
const list = () => handleReadingRoute(new Request('https://test/reading/items?section=inbox'), env, principal);
const index = async (current = policy) => (await ensureReadingIndex(env, current, file => readStoredNote(env, file))).state;
const capture = () => handleReadingRoute(new Request('https://test/reading/capture', { method: 'POST', body: JSON.stringify({
	url, fetchArticle: false, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)),
}) }), env, principal);
/** As a restore leaves the index: no rows, so a rebuild reads every note again. */
const forgetIndex = () => env.DB.batch(['reading_items', 'note_terms', 'highlight_index', 'reading_tags'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
async function seed(target = path) {
	const id = crypto.randomUUID();
	const note = createReadingNote({ id, url, savedAt: new Date().toISOString() });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, target, note, null);
	return { id, note, file: (await getStoredFileRow(env.DB, target))! };
}
beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,0,'Reading','g','r')").run();
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
});
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await reset(); });

it('schedules rebuild recovery with a delay and stops once the index is complete', async () => {
	vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
	await seed(); await forgetIndex();
	const setAlarm = vi.fn();
	const state = { storage: { setAlarm } } as unknown as DurableObjectState;
	const read = vi.spyOn(env.BUCKET, 'get').mockRejectedValue(new Error('temporary R2 outage'));
	await runNotificationCoordinator(state, env);
	expect(setAlarm).toHaveBeenCalledExactlyOnceWith(Date.now() + 30_000);
	read.mockRestore(); setAlarm.mockClear();
	await runNotificationCoordinator(state, env);
	expect(setAlarm).not.toHaveBeenCalled();
});

it('keeps a transient R2 failure retryable and blocks duplicate capture until recovery', async () => {
	const { id, file } = await seed(); await forgetIndex();
	const read = vi.spyOn(env.BUCKET, 'get').mockRejectedValue(new Error('temporary R2 outage'));
	expect((await list()).status).toBe(503);
	expect((await capture()).status).toBe(503);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toMatchObject({ n: 1 });
	expect(await env.DB.prepare('SELECT * FROM reading_items').first()).toBeNull();
	expect(await env.DB.prepare("SELECT * FROM operations WHERE kind = 'reading'").first()).toBeNull();
	read.mockRestore();
	const response = await list();
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
	expect(await (await capture()).json()).toMatchObject({ alreadySaved: true, id });
	expect((await getStoredFileRow(env.DB, path))?.storageKey).toBe(file.storageKey);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toMatchObject({ n: 1 });
});

it.each(['missing', 'wrong size', 'wrong hash'])('recovers from %s source bytes without editing the file revision', async failure => {
	const { id, note, file } = await seed(); await forgetIndex();
	if (failure === 'missing') await env.BUCKET.delete(file.storageKey);
	else await env.BUCKET.put(file.storageKey, failure === 'wrong size' ? 'bad' : 'x'.repeat(new TextEncoder().encode(note).byteLength));
	expect(await index()).toBe('unavailable');
	expect(await env.DB.prepare('SELECT * FROM reading_items').first()).toBeNull();
	await env.BUCKET.put(file.storageKey, note);
	expect(await index()).toBe('complete');
	expect(await (await list()).json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
	expect((await getStoredFileRow(env.DB, path))?.storageKey).toBe(file.storageKey);
});

it('indexes edits, new notes, moves and deletions in their commits without reading R2', async () => {
	const { id, note, file } = await seed('Reading/A.md');
	expect(await index()).toBe('complete');
	const read = vi.spyOn(env.BUCKET, 'get');
	const edited = updateReadingNote(note, id, { favorite: true });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/A.md', edited, file.hash);
	const added = await seed('Reading/B.md');
	expect(await index()).toBe('complete');
	const listed = await (await list()).json() as { items: Array<{ crate_reading_id: string; favorite: boolean; path: string }> };
	expect(listed.items.map(item => [item.path, item.favorite]).sort()).toEqual([['Reading/A.md', true], ['Reading/B.md', false]]);
	await writeCommittedMarkdownMove(env.BUCKET, env.DB, { source: { path: 'Reading/B.md', expectedHash: added.file.hash, expectedRevision: added.file.storageKey },
		destination: { path: 'Archive/B.md', content: added.note } });
	const current = (await getStoredFileRow(env.DB, 'Reading/A.md'))!;
	await commitFileDelete(env.DB, { path: 'Reading/A.md', previousFile: current, expectedHash: current.hash, expectedRevision: current.storageKey });
	expect(await (await list()).json()).toMatchObject({ items: [], issues: [] });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_items').first()).toMatchObject({ n: 0 });
	expect(read).not.toHaveBeenCalled();
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Archive/B.md'))?.content).toBe(added.note);
});

it('flags duplicate Reading IDs when the second copy commits and clears them when one is removed', async () => {
	const { note } = await seed('Reading/A.md');
	expect(await index()).toBe('complete');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/B.md', note, null);
	const flagged = await (await list()).json() as { items: unknown[]; issues: Array<{ path: string }> };
	expect(flagged.items).toEqual([]);
	expect(flagged.issues.map(issue => issue.path).sort()).toEqual(['Reading/A.md', 'Reading/B.md']);
	const copy = (await getStoredFileRow(env.DB, 'Reading/B.md'))!;
	await commitFileDelete(env.DB, { path: 'Reading/B.md', previousFile: copy, expectedHash: copy.hash, expectedRevision: copy.storageKey });
	expect(await (await list()).json()).toMatchObject({ items: [{ path: 'Reading/A.md' }], issues: [] });
});

it('quarantines a verified invalid note once and retries when the source is repaired', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, '---\ncrate_reading_version: 1\n---\nInvalid properties.', null);
	expect(await index()).toBe('complete');
	const response = await list();
	const body = await response.json() as { items: unknown[]; issues: Array<{ path: string; message: string }> };
	expect(body.items).toEqual([]);
	expect(body.issues[0]?.path).toBe(path);
	expect(body.issues[0]?.message).toContain('invalid properties');
	const read = vi.spyOn(env.BUCKET, 'get');
	expect(await index()).toBe('complete');
	expect(read).not.toHaveBeenCalled(); read.mockRestore();
	const id = crypto.randomUUID();
	const note = createReadingNote({ id, url, savedAt: new Date().toISOString() });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, note, (await getStoredFileRow(env.DB, path))!.hash);
	expect(await (await list()).json()).toMatchObject({ items: [{ crate_reading_id: id }], issues: [] });
});

it.each([
	['invalid UTF-8', (note: string) => new Uint8Array([...new TextEncoder().encode(note), 0xff]), 1],
	['a byte order mark', (note: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(note)]), 0],
])('keeps the library available when a note is saved with %s', async (_name, encode, expectedIssues) => {
	const { id, note, file } = await seed();
	const bytes = encode(note);
	await env.BUCKET.put(file.storageKey, bytes);
	await env.DB.prepare('UPDATE files SET hash = ?, size = ? WHERE path = ?').bind(await sha256Hex(bytes), bytes.byteLength, path).run(); await forgetIndex();
	expect(await index()).toBe('complete');
	const response = await list();
	expect(response.status).toBe(200);
	const body = await response.json() as { items: Array<{ crate_reading_id: string }>; issues: unknown[] };
	expect(body.issues).toHaveLength(expectedIssues);
	expect(body.items.map(item => item.crate_reading_id)).toEqual(expectedIssues ? [] : [id]);
});

it('keeps a byte order mark when the Worker updates the note', async () => {
	const { id, note, file } = await seed();
	const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(note)]);
	await env.BUCKET.put(file.storageKey, bytes);
	await env.DB.prepare('UPDATE files SET hash = ?, size = ? WHERE path = ?').bind(await sha256Hex(bytes), bytes.byteLength, path).run(); await forgetIndex();
	expect(await index()).toBe('complete');
	const response = await handleReadingRoute(new Request('https://test/reading/update', { method: 'POST', body: JSON.stringify({
		id, changes: { favorite: true }, before: { favorite: false }, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)),
	}) }), env, principal);
	expect(response.status, await response.clone().text()).toBe(200);
	const saved = (await getStoredFileRow(env.DB, path))!;
	const stored = new Uint8Array(await (await env.BUCKET.get(saved.storageKey))!.arrayBuffer());
	expect([...stored.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(stored)).toBe(`\uFEFF${updateReadingNote(note, id, { favorite: true })}`);
});


it('starts a new policy for an empty folder with a complete index that commits keep current', async () => {
	await env.DB.prepare('DELETE FROM reading_policy').run();
	await updatePolicy(env.DB, { enabled: false, folderPath: 'Reading', revision: null });
	await seed('Reading/A.md'); await seed('Reading/B.md');
	const read = vi.spyOn(env.BUCKET, 'get');
	const response = await list();
	expect(response.status).toBe(200);
	expect((await response.json() as { items: unknown[] }).items).toHaveLength(2);
	expect(read).not.toHaveBeenCalled();
});

it('rebuilds an encrypted vault\'s index in notification passes, not in web app reads', async () => {
	for (let n = 0; n < 30; n++) await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Reading/${n}.md`, `CRATE-E2EE/1\n{"n":${n}}`, null);
	const { state: encryption } = await createEncryptionFixture('active');
	await env.DB.prepare('INSERT OR REPLACE INTO server_state(id, encryption) VALUES (1, ?)').bind(JSON.stringify(encryption)).run();
	await env.DB.prepare('UPDATE reading_policy SET index_scope = NULL, index_cursor = NULL').run();
	const setAlarm = vi.fn();
	const state = { storage: { setAlarm, get: vi.fn(), put: vi.fn(), delete: vi.fn() } } as unknown as DurableObjectState;
	for (let pass = 0; pass < 3; pass++) await runNotificationCoordinator(state, env);
	// Complete: the web app's next read is answered instead of a 503 for each step.
	expect(await env.DB.prepare('SELECT index_scope IS NOT NULL AS scoped, index_cursor AS cursor FROM reading_policy').first()).toEqual({ scoped: 1, cursor: null });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_items').first()).toEqual({ n: 30 });
});

it('rebuilds the index in steps of notes, skipping saved images', async () => {
	for (let note = 0; note < 3; note++) await seed(`Reading/Note ${note}.md`);
	// Sixty images sort before the notes, as `attachments/` does.
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 60)
		INSERT INTO files(path, portable_path, storage_key, hash, size) SELECT 'Reading/attachments/' || x || '.png', 'reading/attachments/' || x || '.png', 'image-' || x, '', 1 FROM n`).run();
	expect(await index()).toBe('complete');
	expect((await (await list()).json() as { items: unknown[] }).items).toHaveLength(3);
});

it('rebuilds an unchanged library without reading R2 or rewriting its rows', async () => {
	for (let n = 0; n < 30; n++) await seed(`Reading/${n}.md`);
	// A commit whose bytes the writer could not see asks for a rebuild.
	await env.DB.prepare('UPDATE reading_policy SET index_scope = NULL, index_cursor = NULL').run();
	const get = vi.spyOn(env.BUCKET, 'get');
	const meter = meterD1Usage(env.DB);
	expect((await ensureReadingIndex({ ...env, DB: meter.db }, policy, file => readStoredNote(env, file))).state).toBe('complete');
	expect(get).not.toHaveBeenCalled();
	// Only the index row's position and budget; before, every note's rows were deleted and written again.
	expect(meter.usage.rowsWritten).toBeLessThanOrEqual(2);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_items').first()).toEqual({ n: 30 });
});

it('reads each file once while rebuilding an unchanged library, however far the walk has gone', { timeout: 60_000 }, async () => {
	const notes = 3000;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
		INSERT INTO files(path, portable_path, storage_key, hash, size) SELECT 'Reading/' || x || '.md', 'reading/' || x || '.md', 'key-' || x, '', 1 FROM n`).bind(notes).run();
	await env.DB.prepare(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id)
		SELECT portable_path, path, storage_key, hash, size, printf('00000000-0000-4000-8000-%012d', rowid) FROM (SELECT *, row_number() OVER () AS rowid FROM files)`).run();
	const meter = meterD1Usage(env.DB);
	let steps = 0;
	while ((await ensureReadingIndex({ ...env, DB: meter.db }, policy, () => { throw new Error('An unchanged note is not read'); })).state !== 'complete') steps++;
	expect(steps).toBeGreaterThan(5);
	// About four rows per note: each row with its file, then each file with its row. Before, each
	// files step read every file before its cursor again: 22,540 rows here, 1.8 million at 50,000.
	expect(meter.usage.rowsRead).toBeLessThan(notes * 5);
});

it('removes rows whose file left or was deleted and indexes a changed note again', async () => {
	const kept = await seed('Reading/kept.md'), gone = await seed('Reading/gone.md'), moved = await seed('Reading/moved.md');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Archive/moved.md', moved.note, null);
	// Rows the index kept while their files changed outside its commits, as after a restore.
	await env.DB.batch([
		env.DB.prepare("DELETE FROM files WHERE path = 'Reading/gone.md'"),
		env.DB.prepare("UPDATE reading_items SET path = 'Archive/moved.md', portable_path = 'archive/moved.md' WHERE path = 'Reading/moved.md'"),
		env.DB.prepare("DELETE FROM files WHERE path = 'Reading/moved.md'"),
		env.DB.prepare("UPDATE reading_items SET storage_key = 'old revision' WHERE path = 'Reading/kept.md'"),
		env.DB.prepare('UPDATE reading_policy SET index_scope = NULL, index_cursor = NULL'),
	]);
	const get = vi.spyOn(env.BUCKET, 'get');
	expect(await index()).toBe('complete');
	expect(get).toHaveBeenCalledOnce();
	expect((await env.DB.prepare('SELECT item_id, storage_key FROM reading_items').all()).results).toEqual([{ item_id: kept.id, storage_key: kept.file.storageKey }]);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM note_terms WHERE item NOT IN (SELECT id FROM reading_items)').first()).toEqual({ n: 0 });
	expect(gone.id).not.toBe(kept.id);
});

it('stops a rebuild for the day once it has written its daily rows, and continues the next day', async () => {
	await seed(); await forgetIndex();
	const day = Math.floor(Date.UTC(2026, 9, 1) / 86_400_000);
	await env.DB.prepare('UPDATE reading_policy SET index_day = ?, index_rows = ? WHERE id = 1').bind(day, READING_REBUILD_DAILY_ROWS).run();
	const read = (file: Parameters<typeof readStoredNote>[1]) => readStoredNote(env, file);
	expect(await ensureReadingIndex(env, policy, read, undefined, false, day * 86_400_000 + 3_600_000)).toEqual({ state: 'waiting', retryAt: (day + 1) * 86_400_000 });
	expect(await env.DB.prepare('SELECT count(*) AS n FROM reading_items').first()).toEqual({ n: 0 });
	expect((await ensureReadingIndex(env, policy, read, undefined, false, (day + 1) * 86_400_000)).state).toBe('complete');
	const spent = await env.DB.prepare('SELECT index_day AS day, index_rows AS rows FROM reading_policy').first<{ day: number; rows: number }>();
	expect(spent!.day).toBe(day + 1);
	expect(spent!.rows).toBeGreaterThan(0);
	expect(spent!.rows).toBeLessThan(40);
});
