/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleListReminders } from './handlers/list';
import { revalidateReminderSources } from './source-migration';
import { meterD1Usage } from '../d1/d1-usage';
import { commitFileDelete } from '../sync/mutations';
import { getStoredFileRow } from '../sync/storage';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../sync/markdown-files';
import { readReminderListBody } from '@/pwa/reminders/reminder-api';
import { DELTA_BASE_HEADER } from '@/protocol/http-headers';
import { drainNotificationProjections } from '../notifications/projection';
import type { ReminderRecord } from '@/pwa/reminders/types';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

const task = (id: string, title = id) => `- [ ] ${title} <!-- crate-id:${id} -->`;
async function write(name: string, ...lines: string[]) {
	const path = `Reminders/${name}`;
	const current = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, `${lines.join('\n')}\n`, current?.hash ?? null);
}

/** Lists like the web app, recording whether the whole folder cache was read. */
async function list(headers: Record<string, string> = {}, since?: string) {
	const prepare = env.DB.prepare.bind(env.DB);
	let fullCacheRead = false, folderListed = false, queries = 0;
	env.DB.prepare = (sql: string) => {
		queries += 1;
		if (sql.includes('FROM reminder_file_cache') && !sql.includes('json_each')) fullCacheRead = true;
		if (sql.includes('FROM files') && sql.includes('portable_path >=')) folderListed = true;
		return prepare(sql);
	};
	try {
		const query = since ? `&since=${encodeURIComponent(since)}` : '';
		const response = await handleListReminders(new Request(`https://worker.test/reminders/list?folderPath=Reminders${query}`, { headers }), env);
		return { response, body: response.status === 200 ? await response.json() as Record<string, unknown> : null, fullCacheRead, folderListed, queries };
	} finally { env.DB.prepare = prepare; }
}

it('merges deltas from changed notes into the same list as a full response', async () => {
	await write('Alpha.md', task('a1'), task('a2'));
	await write('Beta.md', task('b1'), task('b2'));
	await write('Gamma.md', task('g1'));
	await write('Empty.md', 'No reminders here');
	while (await revalidateReminderSources(env, 4)) { /* finish the one-time source scan */ }
	const first = await list();
	let snapshot = { reminders: first.body!.reminders as ReminderRecord[], projects: first.body!.projects as string[] };
	let etag = first.response.headers.get('ETag')!, base = first.response.headers.get(DELTA_BASE_HEADER)!;
	const remove = async (path: string) => {
		const file = (await getStoredFileRow(env.DB, path))!;
		await commitFileDelete(env.DB, { path, expectedHash: file.hash, expectedRevision: file.storageKey, previousFile: file });
	};

	const changes: Array<[string, () => Promise<void>, boolean]> = [
		['edit a reminder', () => write('Alpha.md', task('a1', 'Renamed'), task('a2')), true],
		['add a note', () => write('Delta.md', task('d1')), true],
		['delete a note', () => remove('Reminders/Gamma.md'), true],
		['delete a note without reminders', () => remove('Reminders/Empty.md'), true],
		['rename a note by letter case', async () => { await remove('Reminders/Beta.md'); await write('beta.md', task('b1'), task('b2')); }, true],
		// A copied identity hides both copies; only the full index can report it.
		['duplicate an unchanged identity', () => write('Delta.md', task('d1'), task('b1')), false],
	];
	for (const [name, change, fast] of changes) {
		await change();
		const delta = await list({ 'If-None-Match': etag }, base);
		const full = await list();
		expect(delta.response.status, name).toBe(200);
		expect(delta.fullCacheRead, name).toBe(!fast);
		expect(delta.folderListed, name).toBe(!fast);
		const read = readReminderListBody(delta.body, 'Reminders', snapshot, base);
		expect(read.result, name).toEqual({ reminders: full.body!.reminders, projects: full.body!.projects, issues: full.body!.issues });
		if (!delta.response.headers.get('ETag')) break;
		snapshot = { reminders: read.result!.reminders, projects: read.result!.projects };
		etag = delta.response.headers.get('ETag')!; base = delta.response.headers.get(DELTA_BASE_HEADER)!;
	}
});

it('reads rows for the changed notes only, however large the folder', async () => {
	await write('Alpha.md', task('a1'));
	while (await revalidateReminderSources(env, 4)) { /* finish the one-time source scan */ }
	const first = await list();
	// Other notes in the folder, written without changelog entries so the delta still names one note.
	await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
		INSERT INTO files(path, portable_path, hash, size, storage_key) SELECT 'Reminders/note-' || i || '.md', 'reminders/note-' || i || '.md', 'hash', 1, 'key-' || i FROM n`).run();
	await write('Alpha.md', task('a1', 'Done'));
	const meter = meterD1Usage(env.DB);
	const response = await handleListReminders(new Request(`https://worker.test/reminders/list?folderPath=Reminders&since=${encodeURIComponent(first.response.headers.get(DELTA_BASE_HEADER)!)}`,
		{ headers: { 'If-None-Match': first.response.headers.get('ETag')! } }), { ...env, DB: meter.db });
	expect(await response.json()).toEqual(expect.objectContaining({ delta: true, changedPaths: ['Reminders/Alpha.md'], reminders: [expect.objectContaining({ id: 'a1', content: 'Done' })], changedProjects: ['Alpha'] }));
	expect(meter.usage.rowsRead).toBeLessThan(50);
});

it('lists the whole folder until its one-time source scan has finished', async () => {
	await write('Alpha.md', task('a1'));
	await write('Gamma.md', task('g1'));
	const first = await list();
	await write('Alpha.md', task('a1', 'Renamed'));
	await write('Beta.md', task('b1'));
	const gamma = (await getStoredFileRow(env.DB, 'Reminders/Gamma.md'))!;
	await commitFileDelete(env.DB, { path: 'Reminders/Gamma.md', expectedHash: gamma.hash, expectedRevision: gamma.storageKey, previousFile: gamma });
	const base = first.response.headers.get(DELTA_BASE_HEADER)!;
	const delta = await list({ 'If-None-Match': first.response.headers.get('ETag')! }, base);
	expect(delta.body).toMatchObject({ delta: true, reminders: [{ id: 'a1', content: 'Renamed' }, { id: 'b1' }], changedProjects: ['Alpha', 'Beta'] });
	expect(delta.fullCacheRead).toBe(true);
	// The full index's delta merges into the same projects as a full list.
	const snapshot = { reminders: first.body!.reminders as ReminderRecord[], projects: first.body!.projects as string[] };
	const full = await list();
	expect(readReminderListBody(delta.body, 'Reminders', snapshot, base).result)
		.toEqual({ reminders: full.body!.reminders, projects: full.body!.projects, issues: full.body!.issues });
});

it('answers a delta base with no reminder changes in two queries', async () => {
	await write('Alpha.md', task('a1'));
	const first = await list();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Notes/Other.md', 'Elsewhere\n', null);
	const unchanged = await list({ 'If-None-Match': first.response.headers.get('ETag')! }, first.response.headers.get(DELTA_BASE_HEADER)!);
	expect(unchanged.response.status).toBe(304);
	// The change state, which carries the changelog bounds, then the changed paths.
	expect(unchanged.queries).toBe(2);
});

it('lists a note the notification projection parsed without reading it from storage', async () => {
	await write('Alpha.md', task('a1'));
	await env.DB.prepare('DELETE FROM reminder_file_cache').run();
	await drainNotificationProjections(env);
	const { hash } = (await getStoredFileRow(env.DB, 'Reminders/Alpha.md'))!;
	expect(await env.DB.prepare('SELECT file_hash FROM reminder_file_cache WHERE folder_path = ? AND file_path = ?')
		.bind('Reminders', 'Reminders/Alpha.md').first()).toEqual({ file_hash: hash });
	const get = vi.spyOn(env.BUCKET, 'get');
	const listed = await list();
	expect(listed.body).toMatchObject({ reminders: [{ id: 'a1' }] });
	expect(get).not.toHaveBeenCalled();
});

it('reads each note once while scanning the folder for its sources', { timeout: 60_000 }, async () => {
	const notes = 1000;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
		INSERT INTO files(path, portable_path, storage_key, hash, size) SELECT 'Reminders/' || x || '.md', 'reminders/' || x || '.md', 'key-' || x, '', 1 FROM n`).bind(notes).run();
	// Only the folder walk is metered; parsing the (absent) note bytes is not what this measures.
	const meter = meterD1Usage(env.DB), prepare = env.DB.prepare.bind(env.DB);
	const db = { prepare: (sql: string) => sql.startsWith('SELECT path FROM files') ? meter.db.prepare(sql) : prepare(sql),
		batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements), exec: (sql: string) => env.DB.exec(sql) } as unknown as D1Database;
	const scanned = () => env.DB.prepare("SELECT value FROM maintenance_state WHERE key LIKE 'reminder_source_scan_%'").first<{ value: string }>();
	for (let pass = 0; pass < 100 && (await scanned())?.value !== ''; pass++) await revalidateReminderSources({ ...env, DB: db }, 4);
	expect((await scanned())?.value).toBe('');
	expect(await env.DB.prepare('SELECT count(*) AS n FROM reminder_source_state').first()).toEqual({ n: notes });
	// Before: each batch of 100 read every note before its cursor again, 6,500 rows here.
	expect(meter.usage.rowsRead).toBeLessThan(notes * 1.5);
});
