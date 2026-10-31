/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleReadingRoute } from './routes';
import { ensureReadingIndex, queueReadingArticles } from './library-index';
import { publishExtraction, runReadingExtraction } from './extraction/jobs';
import type { Publication } from './extraction/jobs';
import type { Env } from '../types';
import { policy, readStoredNote } from './common';
import { READING_LIST_PAGE } from './queries';
import { meterD1Usage } from '../d1-usage';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { adoptReadingClip, createReadingNote, parseReadingNote, updateReadingNote } from '@/reading/core/notes';
import { commitFileDelete } from '../sync/mutations';
import { getStoredFileRow } from '../sync/storage';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';
import { readingDocument } from '@/reading/core/markdown';
import { writeMarkdownHighlights } from '@/reading/core/markdown-highlights';
import type { ReadingItem } from '@/reading/core/model';

const principal = { tokenId: 'vault', scope: 'vault' as const };
const command = (path: string, body: Record<string, unknown>) => handleReadingRoute(new Request(`https://test/reading/${path}`, { method: 'POST', body: JSON.stringify(body) }), env, principal);
const id = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','test-hash')").run();
	expect((await command('policy', { enabled: true, folderPath: 'Reading', revision: null })).status).toBe(200);
});
afterEach(reset);
async function buildIndex() {
	const current = (await policy(env.DB))!;
	while ((await ensureReadingIndex(env, current, file => readStoredNote(env, file))).state !== 'complete');
}
it('paginates current sources, queues only the first page, and reports duplicate IDs across pages', async () => {
	let last = '';
	const name = (index: number) => `Reading/${String(index).padStart(4, '0')}.md`;
	for (let index = 0; index < READING_LIST_PAGE; index++) {
		const path = name(index);
		last = await adoptReadingClip(`Note ${index}.`, path, '2026-09-26T00:00:00Z');
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, last, null);
	}
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, name(READING_LIST_PAGE), last, null);
	await buildIndex();
	const saved = await command('capture', { url: 'https://example.com/queued', operationId: id() });
	expect(saved.status).toBe(200);
	const queued = await saved.json() as { id: string };
	const get = (suffix: string) => handleReadingRoute(new Request(`https://test/reading/${suffix}`), env, principal);
	const first = await (await get('list')).json() as { items: ReadingItem[]; cursor: string; issues: Array<{ path: string }> };
	expect(first.items).toHaveLength(READING_LIST_PAGE);
	expect(first.items[0]).toMatchObject({ path: '', crate_reading_id: queued.id });
	expect(first.cursor).toBe(name(READING_LIST_PAGE - 1).toLowerCase());
	expect(first.issues).toMatchObject([{ path: name(READING_LIST_PAGE - 1) }]);
	expect(await (await get(`list?cursor=${encodeURIComponent(first.cursor)}`)).json()).toMatchObject({ items: [], cursor: null, issues: [{ path: name(READING_LIST_PAGE) }] });
	expect(await (await get(`item?id=${queued.id}`)).json()).toMatchObject({ item: { path: '', crate_reading_id: queued.id }, markdown: '' });
	expect(await (await get(`item?id=${first.items[1]!.crate_reading_id}`)).json()).toMatchObject({ item: { path: name(0) }, markdown: 'Note 0.' });
	expect((await get(`item?id=${parseReadingNote(last)!.crate_reading_id}`)).status).toBe(409);
	expect((await get(`list?cursor=${'x'.repeat(4097)}`)).status).toBe(400);
}, 180_000);

it('preserves source bytes and HTTP error distinctions for rejected edits and retries', async () => {
	const path = 'Reading/Guarded.md', content = await adoptReadingClip('Original user text.', path, '2026-09-26T00:00:00Z');
	const item = parseReadingNote(content)!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	for (const [changes, before, status] of [
		[{ favorite: true }, { favorite: true }, 409],
		[{ source_url: 'https://other.example' }, {}, 400],
	] as const) {
		expect((await command('update', { id: item.crate_reading_id, changes, before, operationId: id() })).status).toBe(status);
	}
	expect((await command('retry', { id: item.crate_reading_id, operationId: id() })).status).toBe(400);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!.content).toBe(content);
});

it('projects folder imports without extraction and syncs their reading metadata', async () => {
	for (const [path, original] of [
		['Reading/Clip.md', '---\nsource: https://example.com/article\n---\nClipped text.'],
		['Reading/Note.md', 'My own text.'],
	]) {
		const content = await adoptReadingClip(original!, path!, '2026-09-26T00:00:00Z');
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, path!, content, null);
	}
	await buildIndex();
	const { results } = await env.DB.prepare('SELECT item_id, url_identity, metadata_json FROM reading_items ORDER BY portable_path').all<{ item_id: string; url_identity: string | null; metadata_json: string }>();
	expect(results).toHaveLength(2);
	expect(results[0]!.url_identity).toBe('https://example.com/article');
	expect(results[1]!.url_identity).toBeNull();
	expect(JSON.parse(results[1]!.metadata_json)).toMatchObject({ source_url: '', title: 'Note', favorite: false });
	const response = await command('update', { id: results[1]!.item_id, before: { favorite: false, reading_status: 'inbox', tags: [] }, changes: { favorite: true, reading_status: 'archived', tags: ['design', 'later'] }, operationId: id() });
	expect(response.status, await response.clone().text()).toBe(200);
	const changed = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Reading/Note.md'))!;
	expect(parseReadingNote(changed.content)).toMatchObject({ favorite: true, reading_status: 'archived', tags: ['design', 'later'] });
	expect(changed.content.endsWith('My own text.')).toBe(true);
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).toBeNull();
});
async function capture() {
	// Legacy files and explicit retries retain their original path during extraction.
	const note = createReadingNote({ id: crypto.randomUUID(), url: 'https://example.com/article', savedAt: new Date().toISOString() });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Existing.md', note, null);
	await buildIndex();
	return (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
}
it('publishes extracted text through immutable file versions and ordinary sync changelog', async () => {
	const job = await capture();
	await publishExtraction(env, { job, result: { markdown: '# Article\n\nUseful saved article text.', title: 'An article', author: 'Author', faviconUrl: 'https://cdn.example.com/icon.png' }, resolvedUrl: job.url });
	const saved = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path);
	expect(saved?.content).toContain('Useful saved article text.');
	expect(parseReadingNote(saved!.content)).toMatchObject({ extraction_status: 'ready', title: 'An article', author: 'Author', favicon_url: 'https://cdn.example.com/icon.png' });
	expect((await env.DB.prepare('SELECT count(*) AS n FROM changelog WHERE path=?').bind(job.path).first())?.n).toBe(2);
	expect((await env.DB.prepare('SELECT count(*) AS n FROM file_versions').first())?.n).toBe(1);
});
it('renames a note still named after its link once extraction finds the title, and keeps user renames', async () => {
	const itemId = 'a1b2c3d4-5678-4abc-9def-123456789abc';
	const note = createReadingNote({ id: itemId, url: 'https://www.example.com/article', savedAt: new Date().toISOString() });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/example.com - a1b2c3d4.md', note, null);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/An article - example.com - a1b2c3d4.md', 'Occupied', null);
	await buildIndex();
	const job = (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
	await publishExtraction(env, { job, result: { markdown: 'Useful saved article text.', title: 'An article', author: undefined } });
	const renamed = 'Reading/An article - example.com - a1b2c3d45678.md';
	expect(await getStoredFileRow(env.DB, job.path)).toBeNull();
	expect(parseReadingNote((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, renamed))!.content)).toMatchObject({ title: 'An article', extraction_status: 'ready' });
	expect((await env.DB.prepare('SELECT path, action FROM changelog ORDER BY seq DESC LIMIT 2').all()).results).toEqual([
		{ path: job.path, action: 'delete' }, { path: renamed, action: 'put' }]);
	expect(await env.DB.prepare('SELECT 1 FROM file_deletion_receipts WHERE path=?').bind(job.path).first()).not.toBeNull();
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).toBeNull();
	// A name the user chose is never replaced.
	const other = createReadingNote({ id: crypto.randomUUID(), url: 'https://example.com/kept', savedAt: new Date().toISOString() });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/My pick.md', other, null);
	await buildIndex();
	const kept = (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
	await publishExtraction(env, { job: kept, result: { markdown: 'Text.', title: 'Another title', author: undefined } });
	expect(parseReadingNote((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Reading/My pick.md'))!.content)?.title).toBe('Another title');
});
it('cannot resurrect a deleted source or overwrite text changed during extraction', async () => {
	const job = await capture(), source = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!;
	const changed = source.content + '\nMy personal note.\n';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, job.path, changed, source.hash);
	await publishExtraction(env, { job, result: { markdown: 'Stale extraction must not overwrite a changed source.', title: undefined, author: undefined } });
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))?.content).toBe(changed);
	const file = (await getStoredFileRow(env.DB, job.path))!;
	await commitFileDelete(env.DB, { path: job.path, previousFile: file, expectedHash: file.hash, expectedRevision: file.storageKey });
	await publishExtraction(env, { job, result: null });
	expect(await getStoredFileRow(env.DB, job.path)).toBeNull();
});
it('preserves user notes and metadata already present when extraction starts', async () => {
	const original = await capture(), source = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, original.path))!;
	const edited = updateReadingNote(source.content, original.item_id, { favorite: true, tags: ['kept'] }) + '\nPersonal thoughts.\n';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, original.path, edited, source.hash);
	await env.DB.prepare('DELETE FROM reading_jobs').run(); await env.DB.prepare('DELETE FROM reading_index').run();
	await buildIndex();
	const job = (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
	await publishExtraction(env, { job, result: { markdown: 'Saved article content, separate from the personal note.', title: undefined, author: undefined } });
	const saved = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!;
	expect(saved.content).toContain('Personal thoughts.'); expect(parseReadingNote(saved.content)).toMatchObject({ favorite: true, tags: ['kept'], extraction_status: 'ready' });
});
it('keeps a failed publication leased so the article queue cannot restart its fetch attempts', async () => {
	const original = await capture(), source = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, original.path))!;
	// Personal text plus a near-limit article cannot fit one Reading note.
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, original.path, `${source.content}\n${'Personal text. '.repeat(5000)}\n`, source.hash);
	await env.DB.prepare('DELETE FROM reading_jobs').run(); await env.DB.prepare('DELETE FROM reading_index').run();
	await buildIndex();
	const job = (await env.DB.prepare('SELECT * FROM reading_jobs').first<Publication['job']>())!;
	await env.DB.prepare('UPDATE reading_jobs SET attempts = 1').run();
	await expect(publishExtraction(env, { job, result: { markdown: 'x'.repeat(980_000), title: undefined, author: undefined } })).rejects.toThrow();
	await queueReadingArticles(env.DB).run();
	expect(await env.DB.prepare('SELECT path, source_revision, attempts FROM reading_jobs').all()).toMatchObject({ results: [{ path: job.path, source_revision: job.source_revision, attempts: 1 }] });
	// Once its fetches are spent, the job keeps the bookmark without an article.
	await publishExtraction(env, { job, result: null });
	expect(parseReadingNote((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!.content)?.extraction_status).toBe('unavailable');
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).toBeNull();
});
it('queues a fresh extraction job when an unavailable bookmark is retried', async () => {
	const job = await capture(); await publishExtraction(env, { job, result: null });
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).toBeNull();
	expect((await command('retry', { id: job.item_id, operationId: id() })).status).toBe(200);
	const file = (await getStoredFileRow(env.DB, job.path))!;
	expect(await env.DB.prepare('SELECT path, source_revision, attempts FROM reading_jobs').first()).toEqual({ path: job.path, source_revision: file.storageKey, attempts: 0 });
});
it('keeps failed extractions as useful bookmarks and never extracts clipper notes', async () => {
	const job = await capture(); await publishExtraction(env, { job, result: null });
	const saved = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!;
	expect(parseReadingNote(saved.content)).toMatchObject({ source_url: job.url, extraction_status: 'unavailable' });
	const clipped = saved.content.replace('"url"', '"web-clipper"').replace('"unavailable"', '"pending"');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, job.path, clipped, saved.hash);
	await buildIndex();
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).toBeNull();
});
function extractionAlarm(runtime: Partial<Env> = {}) {
	const setAlarm = vi.fn(async (_at: number) => {});
	const fetch = vi.fn(async () => Response.json({}));
	const state = { storage: { setAlarm } } as unknown as DurableObjectState;
	return { setAlarm, fetch, run: () => runReadingExtraction(state, { ...env, READING_FETCH: { fetch }, ...runtime }) };
}
it('publishes due article jobs without waking notification processing', async () => {
	for (const name of ['A', 'B', 'C']) {
		await writeCommittedMarkdownFile(env.BUCKET, env.DB, `Reading/${name}.md`,
			createReadingNote({ id: crypto.randomUUID(), url: `https://example.com/${name}`, savedAt: new Date().toISOString() }), null);
	}
	await buildIndex();
	// Jobs whose fetches are spent publish their bookmark without fetching the page.
	await env.DB.prepare('UPDATE reading_jobs SET attempts = 3, available_at = 0').run();
	const alarm = extractionAlarm();
	for (let run = 0; run < 3; run++) await alarm.run();
	expect(alarm.fetch).not.toHaveBeenCalled();
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).toBeNull();
	for (const name of ['A', 'B', 'C']) {
		expect(parseReadingNote((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, `Reading/${name}.md`))!.content)?.extraction_status).toBe('unavailable');
	}
	const coordinator = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
	// A coordinator wake would have recorded a notification run with a fresh retry budget.
	expect(await runInDurableObject(coordinator, (_instance, state) => state.storage.get('notificationRun'))).toBeUndefined();
});
it('retries an exhausted article job hourly until its link publishes', async () => {
	const job = await capture();
	await env.DB.prepare('UPDATE reading_jobs SET attempts = 7, available_at = 0').run();
	// The coordinator cannot publish, so the eighth attempt fails too.
	const unavailable = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) } as unknown as Env['REMINDER_ALARMS'];
	const failing = extractionAlarm({ REMINDER_ALARMS: unavailable });
	const before = Date.now();
	await failing.run();
	const row = (await env.DB.prepare('SELECT attempts, available_at FROM reading_jobs').first<{ attempts: number; available_at: number }>())!;
	expect(row.attempts).toBe(8);
	expect(row.available_at).toBeGreaterThanOrEqual(before + 60 * 60_000);
	expect(failing.setAlarm).toHaveBeenLastCalledWith(row.available_at);
	// The row still keeps the article queue from restarting its fetches.
	await queueReadingArticles(env.DB).run();
	expect((await env.DB.prepare('SELECT count(*) AS n FROM reading_jobs').first<{ n: number }>())?.n).toBe(1);
	// Once due again, it publishes the link without fetching the page.
	await env.DB.prepare('UPDATE reading_jobs SET available_at = 0').run();
	const alarm = extractionAlarm();
	await alarm.run();
	expect(alarm.fetch).not.toHaveBeenCalled();
	expect(parseReadingNote((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!.content)?.extraction_status).toBe('unavailable');
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).toBeNull();
});
it('lets only exhausted article jobs give way to a Reading folder change', async () => {
	await capture();
	const current = (await policy(env.DB))!;
	expect((await command('policy', { enabled: false, folderPath: 'Reading', revision: current.revision })).status).toBe(200);
	const off = (await policy(env.DB))!;
	await env.DB.prepare('UPDATE reading_jobs SET attempts = 2').run();
	expect((await command('policy', { enabled: false, folderPath: 'Articles', revision: off.revision })).status).toBe(409);
	await env.DB.prepare('UPDATE reading_jobs SET attempts = 8').run();
	expect((await command('policy', { enabled: false, folderPath: 'Articles', revision: off.revision })).status).toBe(200);
});
it('requeues a capture still pending after its job found a stale source', async () => {
	const job = await capture();
	// A full queue kept a later commit from replacing this job, so it names an earlier revision.
	await env.DB.prepare("UPDATE reading_jobs SET source_revision = 'earlier', attempts = 2, available_at = 0").run();
	const alarm = extractionAlarm();
	await alarm.run();
	expect(alarm.fetch).not.toHaveBeenCalled();
	const file = (await getStoredFileRow(env.DB, job.path))!;
	expect((await env.DB.prepare('SELECT path, source_revision, attempts FROM reading_jobs').all()).results).toEqual([{ path: job.path, source_revision: file.storageKey, attempts: 0 }]);
	expect(alarm.setAlarm).toHaveBeenCalled();
});
it('queues a pending capture that a full queue held back once a slot frees', async () => {
	await buildIndex();
	const current = (await policy(env.DB))!;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 1000)
    INSERT INTO reading_jobs(path, item_id, generation, source_revision, block_hash, url, available_at)
    SELECT 'Reading/queued-'||x||'.md', 'item-'||x, ?, 'revision', 'hash', 'https://example.com/queued', ? FROM n`).bind(current.generation, Date.now() + 3600_000).run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Held.md',
		createReadingNote({ id: crypto.randomUUID(), url: 'https://example.com/held', savedAt: new Date().toISOString() }), null);
	const held = () => env.DB.prepare("SELECT attempts FROM reading_jobs WHERE path = 'Reading/Held.md'").first();
	expect(await held()).toBeNull();
	await env.DB.prepare("DELETE FROM reading_jobs WHERE path = 'Reading/queued-1.md'").run();
	await extractionAlarm().run();
	expect(await held()).toEqual({ attempts: 0 });
});
it('waits to retry an exhausted article job until it is due or its source changes', async () => {
	const job = await capture();
	await env.DB.prepare('UPDATE reading_jobs SET attempts = 8, available_at = ?').bind(Date.now() + 60 * 60_000).run();
	const alarm = extractionAlarm();
	await alarm.run();
	const row = () => env.DB.prepare('SELECT attempts, available_at FROM reading_jobs WHERE path = ?').bind(job.path).first();
	expect(alarm.fetch).not.toHaveBeenCalled();
	expect(await row()).toMatchObject({ attempts: 8 });
	const source = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, job.path))!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, job.path, updateReadingNote(source.content, job.item_id, { favorite: true }), source.hash);
	expect(await row()).toMatchObject({ attempts: 0 });
});
it('replays a lost receipt even after deletion and rejects expired operation identities', async () => {
	const body = { url: 'https://example.com/retry', fetchArticle: false, operationId: id() };
	const first = await command('capture', body); const payload: unknown = await first.json();
	const file = (await env.DB.prepare('SELECT path FROM files').first<{ path: string }>())!, stored = (await getStoredFileRow(env.DB, file.path))!;
	await commitFileDelete(env.DB, { path: file.path, previousFile: stored, expectedHash: stored.hash, expectedRevision: stored.storageKey });
	expect(await (await command('capture', body)).json()).toEqual(payload); expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
	expect((await command('capture', { url: body.url, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000) - 180) })).status).toBe(410);
});

it('deletes an unchanged note once, replays its receipt and refuses a stale delete', async () => {
	const path = 'Reading/Delete.md', content = await adoptReadingClip('Kept until deleted.', path, '2026-09-26T00:00:00Z');
	const item = parseReadingNote(content)!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await buildIndex();
	const before = { reading_status: item.reading_status, favorite: item.favorite, tags: item.tags };
	// A delete based on stale metadata leaves the note untouched.
	expect((await command('delete', { id: item.crate_reading_id, before: { ...before, favorite: !item.favorite }, operationId: id() })).status).toBe(409);
	expect((await command('delete', { id: item.crate_reading_id, before: {}, operationId: id() })).status).toBe(400);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!.content).toBe(content);

	const body = { id: item.crate_reading_id, before, operationId: id() };
	const first = await command('delete', body);
	expect(first.status).toBe(200);
	const payload = await first.json() as { deleted: boolean; library: { before: string; after: string } };
	expect(payload).toMatchObject({ deleted: true, id: item.crate_reading_id });
	expect(payload.library.before).not.toBe(payload.library.after);
	expect(await getStoredFileRow(env.DB, path)).toBeNull();
	expect(await env.DB.prepare('SELECT 1 FROM reading_items WHERE item_id = ?').bind(item.crate_reading_id).first()).toBeNull();
	// The deleted revision stays recoverable, and sync observes an ordinary delete.
	expect(await env.DB.prepare("SELECT 1 FROM file_versions WHERE path = ? AND reason = 'deleted'").bind(path).first()).not.toBeNull();
	expect(await env.DB.prepare("SELECT 1 FROM changelog WHERE path = ? AND action = 'delete'").bind(path).first()).not.toBeNull();
	// A lost response replays the receipt, without library revisions; a new operation finds nothing to delete.
	expect(await (await command('delete', body)).json()).toEqual({ deleted: true, id: item.crate_reading_id });
	expect((await command('delete', { ...body, operationId: id() })).status).toBe(409);
});

it('refuses to delete a note edited after the client saw it', async () => {
	const path = 'Reading/Edited.md', content = await adoptReadingClip('Original.', path, '2026-09-26T00:00:00Z');
	const item = parseReadingNote(content)!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await buildIndex();
	const edited = updateReadingNote(content, item.crate_reading_id, { tags: ['kept'] });
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, edited, (await getStoredFileRow(env.DB, path))!.hash);
	const response = await command('delete', { id: item.crate_reading_id, before: { reading_status: item.reading_status, favorite: item.favorite, tags: item.tags }, operationId: id() });
	expect(response.status).toBe(409);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!.content).toBe(edited);
});

it('persists highlights with replay receipts and rejects concurrent highlight replacement', async () => {
	const content = await adoptReadingClip('Hello **world**!', 'Reading/Highlights.md', '2026-09-26T00:00:00Z');
	const item = parseReadingNote(content)!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Highlights.md', content, null);
	const highlights = [{ start: 0, end: 5, text: 'Hello' }];
	const body = { id: item.crate_reading_id, before: {}, changes: { highlights }, operationId: id() };
	expect((await command('update', body)).status).toBe(200);
	expect((await command('update', body)).status).toBe(200);
	const saved = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Reading/Highlights.md'))!;
	const confirmedHighlights = parseReadingNote(saved.content)!.highlights;
	expect(confirmedHighlights?.[0]).toMatchObject(highlights[0]!);
	expect(saved.content.endsWith('==Hello== **world**!')).toBe(true);
	expect((await command('update', { ...body, operationId: id(), changes: { highlights: [] } })).status).toBe(409);
	expect((await command('update', { ...body, operationId: id(), before: { highlights: confirmedHighlights }, changes: { highlights: [] } })).status).toBe(200);
	const removed = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, 'Reading/Highlights.md'))!;
	expect(removed.content.endsWith('Hello **world**!')).toBe(true);
});

it('commits code annotations with replay receipts while preserving literal source', async () => {
	const path = 'Reading/Code.md', markdown = 'Use `DSButton`.\n\n```swift\nlet kind = "primary"\n```\n';
	const content = await adoptReadingClip(markdown, path, '2026-09-26T00:00:00Z'), item = parseReadingNote(content)!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	const start = readingDocument(markdown).text.indexOf('kind');
	const highlights = writeMarkdownHighlights(markdown, [{ start, end: start + 4, text: 'kind', note: 'Use this API' }]).highlights;
	const body = { id: item.crate_reading_id, before: {}, changes: { highlights }, operationId: id() };
	expect((await command('update', body)).status).toBe(200);
	const saved = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!;
	expect((await command('update', body)).status).toBe(200);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!.hash).toBe(saved.hash);
	expect(readReadingFrontmatter(saved.content)!.body).toBe(markdown);
	expect(parseReadingNote(saved.content)!.highlights).toEqual(highlights);
	const list = await handleReadingRoute(new Request('https://test/reading/list'), env, principal);
	expect(await list.json()).toMatchObject({ items: [{ highlights }] });
	expect((await command('update', { ...body, operationId: id(), before: { highlights }, changes: { highlights: [] } })).status).toBe(200);
	const removed = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!;
	expect(readReadingFrontmatter(removed.content)!.body).toBe(markdown);
	expect(parseReadingNote(removed.content)!.highlights).toEqual([]);
});

it('rebuilds the index from native markers and observes subsequent vault edits', async () => {
	const path = 'Reading/Native.md';
	const content = await adoptReadingClip('Read ==this passage==.', path, '2026-09-26T00:00:00Z');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	await buildIndex();
	await env.DB.prepare("UPDATE reading_items SET metadata_json=json_remove(metadata_json, '$.highlights') WHERE path=?").bind(path).run();
	// Rows from an older format were recorded under a different index scope.
	await env.DB.prepare('DELETE FROM reading_index').run();
	const list = () => handleReadingRoute(new Request('https://test/reading/list'), env, principal);
	const projected = await (await list()).json() as { items: { highlights: { text: string }[] }[] };
	expect(projected.items[0]?.highlights.map(highlight => highlight.text)).toEqual(['this passage']);
	const source = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!;
	const updated = content.replace('==this passage==', '==a new passage==');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, updated, source.hash);
	const changed = await (await list()).json() as { items: { highlights: { text: string }[] }[] };
	expect(changed.items[0]?.highlights.map(highlight => highlight.text)).toEqual(['a new passage']);
});

it('persists source-sensitive text highlights and notes through replay, projection and deletion', async () => {
	const path = 'Reading/Formatting.md', markdown = 'Visit https://example.com.\n\n<div>Embedded HTML.</div>\n\nCompare a == b.\n';
	const content = await adoptReadingClip(markdown, path, '2026-09-26T00:00:00Z'), item = parseReadingNote(content)!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	const text = readingDocument(markdown).text;
	const highlights = writeMarkdownHighlights(markdown, ['example.com', 'Embedded HTML.', 'a == b'].map(excerpt => {
		const start = text.indexOf(excerpt);
		return { start, end: start + excerpt.length, text: excerpt, note: 'Keep this source' };
	})).highlights;
	expect(highlights.every(highlight => highlight.textAnchor)).toBe(true);
	const body = { id: item.crate_reading_id, before: { highlights: item.highlights }, changes: { highlights }, operationId: id() };
	expect((await command('update', body)).status).toBe(200);
	const saved = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!;
	expect((await command('update', body)).status).toBe(200);
	expect((await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!.hash).toBe(saved.hash);
	expect(readReadingFrontmatter(saved.content)!.body).toBe(markdown);
	expect(parseReadingNote(saved.content)!.highlights).toEqual(highlights);
	const list = await handleReadingRoute(new Request('https://test/reading/list'), env, principal);
	expect(await list.json()).toMatchObject({ items: [{ highlights }] });
	expect((await command('update', { ...body, operationId: id(), before: { highlights }, changes: { highlights: [] } })).status).toBe(200);
	const removed = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!;
	expect(readReadingFrontmatter(removed.content)!.body).toBe(markdown);
	expect(parseReadingNote(removed.content)!.highlights).toEqual([]);
});

it('answers an unchanged library from its ETag, also after unrelated vault writes', async () => {
	const path = 'Reading/Kept.md';
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, await adoptReadingClip('Kept.', path, '2026-09-26T00:00:00Z'), null);
	const list = (etag?: string, db = env.DB) => handleReadingRoute(new Request('https://test/reading/list', { headers: etag ? { 'If-None-Match': etag } : {} }), { ...env, DB: db }, principal);
	const first = await list();
	const etag = first.headers.get('ETag')!;
	expect(etag).toMatch(/^"[a-f0-9]{32}"$/);
	const meter = meterD1Usage(env.DB);
	const unchanged = await list(etag, meter.db);
	expect(unchanged.status).toBe(304);
	expect(meter.usage.rowsRead).toBeLessThan(20);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Notes/Elsewhere.md', 'Unrelated', null);
	const refreshed = await list(etag);
	expect(refreshed.status).toBe(304);
	expect(refreshed.headers.get('ETag')).toBe(etag);
	const source = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, source.content.replace('Kept.', 'Changed.'), source.hash);
	expect((await list(refreshed.headers.get('ETag')!)).status).toBe(200);
});
