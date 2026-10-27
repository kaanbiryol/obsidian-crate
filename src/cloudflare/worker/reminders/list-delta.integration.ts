/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleListReminders } from './routes/list';
import { revalidateReminderSources } from './source-migration';
import { commitFileDelete } from '../sync/mutations';
import { getStoredFileRow } from '../sync/storage';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';
import { readReminderListBody } from '@/pwa/reminders/reminder-api';
import { DELTA_BASE_HEADER } from '@/protocol/http-headers';
import type { ReminderRecord } from '@/pwa/reminders/types';

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
});
afterEach(async () => { await reset(); });

const task = (id: string, title = id) => `- [ ] ${title} <!-- crate-id:${id} -->`;
async function write(name: string, ...lines: string[]) {
	const path = `Reminders/${name}`;
	const current = await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, `${lines.join('\n')}\n`, current?.hash ?? null);
}

/** Lists like the web app, recording whether the whole folder cache was read. */
async function list(headers: Record<string, string> = {}, since?: string) {
	const prepare = env.DB.prepare.bind(env.DB);
	let fullCacheRead = false;
	env.DB.prepare = (sql: string) => {
		if (sql.includes('FROM reminder_file_cache') && !sql.includes('json_each')) fullCacheRead = true;
		return prepare(sql);
	};
	try {
		const query = since ? `&since=${encodeURIComponent(since)}` : '';
		const response = await handleListReminders(new Request(`https://worker.test/reminders/list?folderPath=Reminders${query}`, { headers }), env);
		return { response, body: response.status === 200 ? await response.json() as Record<string, unknown> : null, fullCacheRead };
	} finally { env.DB.prepare = prepare; }
}

it('merges deltas from changed notes into the same list as a full response', async () => {
	await write('Alpha.md', task('a1'), task('a2'));
	await write('Beta.md', task('b1'), task('b2'));
	await write('Gamma.md', task('g1'));
	while (await revalidateReminderSources(env, 4)) { /* finish the one-time source scan */ }
	const first = await list();
	let reminders = (first.body!.reminders as ReminderRecord[]);
	let etag = first.response.headers.get('ETag')!, base = first.response.headers.get(DELTA_BASE_HEADER)!;

	const changes: Array<[string, () => Promise<void>, boolean]> = [
		['edit a reminder', () => write('Alpha.md', task('a1', 'Renamed'), task('a2')), true],
		['add a note', () => write('Delta.md', task('d1')), true],
		['delete a note', async () => {
			const file = (await getStoredFileRow(env.DB, 'Reminders/Gamma.md'))!;
			await commitFileDelete(env.BUCKET, env.DB, { path: 'Reminders/Gamma.md', expectedHash: file.hash, expectedRevision: file.storageKey, previousFile: file });
		}, true],
		// A copied identity hides both copies; only the full index can report it.
		['duplicate an unchanged identity', () => write('Delta.md', task('d1'), task('b1')), false],
	];
	for (const [name, change, fast] of changes) {
		await change();
		const delta = await list({ 'If-None-Match': etag }, base);
		const full = await list();
		expect(delta.response.status, name).toBe(200);
		expect(delta.fullCacheRead, name).toBe(!fast);
		const read = readReminderListBody(delta.body, 'Reminders', reminders, base);
		expect(read.result, name).toEqual({ reminders: full.body!.reminders, projects: full.body!.projects, issues: full.body!.issues });
		if (!delta.response.headers.get('ETag')) break;
		reminders = read.result!.reminders;
		etag = delta.response.headers.get('ETag')!; base = delta.response.headers.get(DELTA_BASE_HEADER)!;
	}
});

it('lists the whole folder until its one-time source scan has finished', async () => {
	await write('Alpha.md', task('a1'));
	const first = await list();
	await write('Alpha.md', task('a1', 'Renamed'));
	const delta = await list({ 'If-None-Match': first.response.headers.get('ETag')! }, first.response.headers.get(DELTA_BASE_HEADER)!);
	expect(delta.body).toMatchObject({ delta: true, reminders: [{ id: 'a1', content: 'Renamed' }] });
	expect(delta.fullCacheRead).toBe(true);
});
