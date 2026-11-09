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
	await env.DB.prepare("INSERT INTO reading_index(id, scope) VALUES (1, ?)").bind(readingIndexScope(policy)).run();
	const template = parseReadingNote(createReadingNote({ id: crypto.randomUUID(), url: 'https://example.invalid/template', title: 'Template', savedAt: new Date().toISOString() }))!;
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
    INSERT INTO files(path, portable_path, storage_key, hash, size) SELECT 'Reading/' || x || '.md', 'reading/' || x || '.md', 'reading-key-' || x, '', 0 FROM n`).bind(notes).run();
	await env.DB.prepare(`INSERT INTO reading_items(portable_path, path, storage_key, hash, size, item_id, url_identity, metadata_json, saved_at, status, terms, words)
    SELECT portable_path, path, storage_key, hash, size, id, 'https://example.invalid/' || n,
      json_set(?, '$.crate_reading_id', id, '$.source_url', 'https://example.invalid/' || n, '$.title', 'Article ' || n, '$.saved_at', saved), saved, 'inbox',
      json_array('p:art', CASE WHEN length(n) >= 3 THEN 'p:' || substr(n, 1, 3) ELSE 'w:' || n END), json_array('article', CAST(n AS TEXT))
    FROM (SELECT *, printf('00000000-0000-4000-8000-%012d', n) AS id, strftime('%Y-%m-%dT%H:%M:%fZ', '2020-01-01', '+' || n || ' minutes') AS saved
      FROM (SELECT *, CAST(substr(path, 9, length(path) - 11) AS INTEGER) AS n FROM files WHERE path >= 'Reading/' AND path < 'Reading0'))`)
		.bind(JSON.stringify(template)).run();
	await env.DB.prepare(`INSERT INTO note_terms(scope, term, saved_at, portable_path) SELECT 'reading', t.value, i.saved_at, i.portable_path FROM reading_items i, json_each(i.terms) t`).run();
}

beforeEach(async () => { await applySchema(env.DB); });
afterEach(reset);

it.for([10_000, 50_000])('pages and searches a %i-note Reading library for the web app', { timeout: 300_000 }, async (notes, context) => {
	await seedLibrary(notes);
	const first = await request('items?section=inbox');
	expect(first.response.status).toBe(200);
	expect((JSON.parse(first.body) as { items: unknown[] }).items).toHaveLength(50);
	// Every note matches, so the search walks one term and stops after a page.
	const common = await request('items?section=inbox&q=article');
	expect((JSON.parse(common.body) as { items: unknown[] }).items).toHaveLength(50);
	// One note matches.
	const rare = await request(`items?section=inbox&q=${notes - 1}`);
	expect((JSON.parse(rare.body) as { items: Array<{ title: string }> }).items.map(item => item.title)).toEqual([`Article ${notes - 1}`]);
	// A rare word beside a word every note has: the search starts from the rare one.
	const mixed = await request(`items?section=inbox&q=article%20${notes - 1}`);
	expect((JSON.parse(mixed.body) as { items: unknown[] }).items).toHaveLength(1);
	// A search walks the notes sharing its rarest term's first three letters, never the library.
	// Finding that term among common ones costs a capped count of each.
	for (const page of [first, common]) expect(page.rowsRead).toBeLessThan(200);
	expect(rare.rowsRead).toBeLessThan(400);
	expect(mixed.rowsRead).toBeLessThan(3000);
	await context.annotate(JSON.stringify({
		scenario: 'web-app-reading-pages', localOnly: true, notes,
		...Object.fromEntries(Object.entries({ first, common, rare, mixed }).map(([name, page]) => [name, { ms: Math.round(page.ms), bytes: page.bytes, rowsRead: page.rowsRead }])),
	}), 'capacity');
});
