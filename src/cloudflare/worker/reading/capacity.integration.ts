/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { parseD1Usage, D1_USAGE_HEADER } from '@/protocol/d1-usage';
import { createReadingNote, parseReadingNote } from '@/reading/core/notes';
import { sha256Hex } from '@/platform/sha256';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { readingIndexScope } from './library-index';
import { READING_LIST_PAGE } from './queries';

// A repeatable local workerd/D1 measurement of what the web app asks the server for.
// Rows read come from D1's own billing metadata, as Cloudflare would count them.
const policy = { enabled: 1, folder_path: 'Reading', generation: 'g', revision: 'r' };

async function request(path: string, headers: Record<string, string> = {}) {
	const start = performance.now();
	const response = await worker.fetch(new Request(`https://crate.test/reading/${path}`, {
		headers: { Authorization: 'Bearer vault-credential', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), ...headers },
	}), env);
	const body = await response.text();
	const usage = parseD1Usage(response.headers.get(D1_USAGE_HEADER));
	expect(usage?.complete).toBe(true);
	return { response, body, ms: performance.now() - start, bytes: new TextEncoder().encode(body).byteLength, rowsRead: usage!.rowsRead };
}

/** An indexed library as its commits left it, newest saved last. */
async function seedLibrary(notes: number) {
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('vault', ?, 'vault')").bind(await sha256Hex('vault-credential')).run();
	await env.DB.prepare('INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, ?, ?, ?, ?)')
		.bind(policy.enabled, policy.folder_path, policy.generation, policy.revision).run();
	await env.DB.prepare("INSERT INTO reading_index(id, scope, revision) VALUES (1, ?, 'seeded')").bind(readingIndexScope(policy)).run();
	const template = parseReadingNote(createReadingNote({ id: crypto.randomUUID(), url: 'https://example.invalid/template', title: 'Template', savedAt: new Date().toISOString() }))!;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO files(path, portable_path, storage_key, hash, size) SELECT 'Reading/' || x || '.md', 'reading/' || x || '.md', 'reading-key-' || x, '', 0 FROM n`).bind(notes).run();
	await env.DB.prepare(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id, url_identity, metadata_json, saved_at)
    SELECT portable_path, path, storage_key, hash, size, id, 'https://example.invalid/' || n,
      json_set(?, '$.crate_reading_id', id, '$.source_url', 'https://example.invalid/' || n, '$.title', 'Article ' || n, '$.saved_at', saved), saved
    FROM (SELECT *, printf('00000000-0000-4000-8000-%012d', n) AS id, strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || n || ' minutes') AS saved
      FROM (SELECT *, CAST(substr(path, 9, length(path) - 11) AS INTEGER) AS n FROM files WHERE path >= 'Reading/' AND path < 'Reading0'))`)
		.bind(JSON.stringify(template)).run();
}

beforeEach(async () => { await applySchema(env.DB); });
afterEach(reset);

it.for([10_000, 50_000])('lists a %i-note Reading library for the web app', { timeout: 300_000 }, async (notes, context) => {
	await seedLibrary(notes);
	// Today the web app reads every page before it has a complete copy.
	const first = await request('list');
	expect(first.response.status).toBe(200);
	const pages = [first];
	for (let cursor = (JSON.parse(first.body) as { cursor: string | null }).cursor; cursor;) {
		const page = await request(`list?cursor=${encodeURIComponent(cursor)}`);
		expect(page.response.status).toBe(200);
		pages.push(page);
		cursor = (JSON.parse(page.body) as { cursor: string | null }).cursor;
	}
	const listed = pages.reduce((sum, page) => sum + (JSON.parse(page.body) as { items: unknown[] }).items.length, 0);
	expect(listed).toBe(notes);
	// A full last page still returns a cursor, so a whole number of pages costs one empty request more.
	expect(pages).toHaveLength(Math.floor(notes / READING_LIST_PAGE) + 1);
	const unchanged = await request('list', { 'If-None-Match': first.response.headers.get('ETag')! });
	expect(unchanged.response.status).toBe(304);
	const total = (key: 'ms' | 'bytes' | 'rowsRead') => Math.round(pages.reduce((sum, page) => sum + page[key], 0));
	await context.annotate(JSON.stringify({
		scenario: 'web-app-reading-list', localOnly: true, notes,
		firstPage: { ms: Math.round(first.ms), bytes: first.bytes, rowsRead: first.rowsRead },
		fullLibrary: { requests: pages.length, ms: total('ms'), bytes: total('bytes'), rowsRead: total('rowsRead') },
		unchanged: { ms: Math.round(unchanged.ms), rowsRead: unchanged.rowsRead },
	}), 'capacity');
});
