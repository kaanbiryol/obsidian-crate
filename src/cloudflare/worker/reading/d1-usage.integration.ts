/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { meterD1Usage } from '../d1-usage';
import { parseD1Usage, D1_USAGE_HEADER } from '@/protocol/d1-usage';
import { writeCommittedMarkdownFile } from '../storage';
import { createReadingNote, parseReadingNote } from '@/reading/core/notes';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { sha256Hex } from '@/platform/sha256';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { publishCapture, type PendingCapture } from './captures';
import { runReadingExtraction } from './extraction/jobs';
import { readingIndexScope } from './library-index';
import { READING_LIST_PAGE } from './queries';
import type { Env } from '../types';

// A full Reading library beside an equally large rest of the vault. Rows read per
// request must not grow with either: only a list page grows, with the rows it returns.
const NOTES = 10_000;
const UNRELATED_FILES = 10_000;
// Reads cost authentication, the Reading policy and index rows, and the item itself.
const MAX_READ_ROWS = 20;
// Saves add the file commit, its version, changelog and receipt rows, and the index update.
const MAX_WRITE_ROWS = 80;
const policy = { enabled: 1, folder_path: 'Reading', generation: 'g', revision: 'r' };
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));

/** Rows read by one request through the deployed pipeline, coordinator hop included. */
async function rowsRead(path: string, init: RequestInit = {}) {
	const response = await worker.fetch(new Request(`https://crate.test/reading/${path}`, {
		...init, headers: { Authorization: 'Bearer vault-credential', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers },
	}), env);
	const usage = parseD1Usage(response.headers.get(D1_USAGE_HEADER));
	expect(usage?.complete).toBe(true);
	return { response, rows: usage!.rowsRead };
}
async function metered<T>(action: (target: Env) => Promise<T>) {
	const meter = meterD1Usage(env.DB);
	await action({ ...env, DB: meter.db });
	expect(meter.usage.complete).toBe(true);
	return meter.usage.rowsRead;
}

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('vault', ?, 'vault')").bind(await sha256Hex('vault-credential')).run();
	await env.DB.prepare('INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, ?, ?, ?, ?)')
		.bind(policy.enabled, policy.folder_path, policy.generation, policy.revision).run();
	await env.DB.prepare("INSERT INTO reading_index(id, scope, revision) VALUES (1, ?, 'seeded')").bind(readingIndexScope(policy)).run();
	// Unrelated files sort on both sides of the Reading folder's primary-key range.
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO files(path, portable_path, storage_key, hash, size)
    SELECT CASE x % 3 WHEN 0 THEN 'Notes/' WHEN 1 THEN 'Reading-archive/' ELSE 'Readings/' END || x || '.md',
      CASE x % 3 WHEN 0 THEN 'notes/' WHEN 1 THEN 'reading-archive/' ELSE 'readings/' END || x || '.md', 'key-' || x, '', 0 FROM n`).bind(UNRELATED_FILES).run();
	// An indexed library, as its commits left it.
	const template = parseReadingNote(createReadingNote({ id: crypto.randomUUID(), url: 'https://example.invalid/template', savedAt: new Date().toISOString() }))!;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO files(path, portable_path, storage_key, hash, size) SELECT 'Reading/' || x || '.md', 'reading/' || x || '.md', 'reading-key-' || x, '', 0 FROM n`).bind(NOTES).run();
	await env.DB.prepare(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id, url_identity, metadata_json)
    SELECT portable_path, path, storage_key, hash, size, printf('00000000-0000-4000-8000-%012d', n), 'https://example.invalid/' || n,
      json_set(?, '$.crate_reading_id', printf('00000000-0000-4000-8000-%012d', n), '$.source_url', 'https://example.invalid/' || n)
    FROM (SELECT *, CAST(substr(path, 9, length(path) - 11) AS INTEGER) AS n FROM files WHERE path >= 'Reading/' AND path < 'Reading0')`)
		.bind(JSON.stringify(template)).run();
});
afterEach(reset);

it('keeps Reading reads and saves independent of library and vault size', async () => {
	const id = crypto.randomUUID();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Target.md', createReadingNote({ id, url: 'https://example.invalid/target', savedAt: new Date().toISOString() }), null);

	const item = await rowsRead(`item?id=${id}`);
	expect(item.response.status).toBe(200);
	const list = await rowsRead('list');
	expect(list.response.status).toBe(200);
	const page = await list.response.json() as { items: unknown[]; cursor: string };
	expect(page.items).toHaveLength(READING_LIST_PAGE);
	const etag = list.response.headers.get('ETag')!;
	const unchanged = await rowsRead('list', { headers: { 'If-None-Match': etag } });
	expect(unchanged.response.status).toBe(304);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Notes/Elsewhere.md', 'Unrelated edit', null);
	const unrelated = await rowsRead('list', { headers: { 'If-None-Match': etag } });
	expect(unrelated.response.status).toBe(304);
	const next = await rowsRead(`list?cursor=${encodeURIComponent(page.cursor)}`);
	expect(next.response.status).toBe(200);
	const update = await rowsRead('update', { method: 'POST', body: JSON.stringify({ id, before: { favorite: false }, changes: { favorite: true }, operationId: operationId() }) });
	expect(update.response.status).toBe(200);
	const afterUpdate = await rowsRead(`item?id=${id}`);
	expect(await afterUpdate.response.json()).toMatchObject({ item: { favorite: true } });
	const changed = await rowsRead('list', { headers: { 'If-None-Match': etag } });
	expect(changed.response.status).toBe(200);
	const bookmark = await rowsRead('capture', { method: 'POST', body: JSON.stringify({ url: 'https://example.invalid/bookmark', fetchArticle: false, operationId: operationId() }) });
	expect(await bookmark.response.json()).toMatchObject({ saved: true, alreadySaved: false });
	const duplicate = await rowsRead('capture', { method: 'POST', body: JSON.stringify({ url: 'https://example.invalid/target', operationId: operationId() }) });
	expect(await duplicate.response.json()).toMatchObject({ alreadySaved: true, id });

	for (const [step, measured] of Object.entries({ item, unchanged, unrelated, afterUpdate, duplicate })) expect(measured.rows, step).toBeLessThan(MAX_READ_ROWS);
	for (const [step, measured] of Object.entries({ update, bookmark })) expect(measured.rows, step).toBeLessThan(MAX_WRITE_ROWS);
	// A page reads the rows it returns, plus the same small fixed cost.
	for (const [step, measured] of Object.entries({ list, next, changed })) expect(measured.rows, step).toBeLessThan(READING_LIST_PAGE + MAX_READ_ROWS);
}, 60_000);

it('keeps capture publication and extraction independent of library size', async () => {
	expect((await rowsRead('capture', { method: 'POST', body: JSON.stringify({ url: 'https://example.invalid/queued', operationId: operationId() }) })).response.status).toBe(200);
	const queued = (await env.DB.prepare('SELECT * FROM reading_captures').first<PendingCapture>())!;
	const publish = await metered(target => publishCapture(target, queued.id, queued.generation, null));
	expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).toBeNull();
	const state = { storage: { setAlarm: async () => {} } } as unknown as DurableObjectState;
	const alarms = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null) }) } as unknown as Env['REMINDER_ALARMS'];
	const extraction = await metered(target => runReadingExtraction(state, { ...target, REMINDER_ALARMS: alarms }));
	for (const [step, rows] of Object.entries({ publish, extraction })) expect(rows, step).toBeLessThan(MAX_WRITE_ROWS);
}, 60_000);
