/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { parseD1Usage, D1_USAGE_HEADER } from '@/protocol/d1-usage';
import { createReadingNote } from '@/reading/core/notes';
import { sha256Hex } from '@/platform/sha256';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { READING_INDEX_SHARDS, type ReadingIndexManifest } from '@/protocol/reading-index';
import { READING_INDEX_MANIFEST_KEY, readingIndexShardKey } from '@/protocol/storage-keys';
import { readingIndexScope } from './library-index';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';

const policy = { enabled: 1, folder_path: 'Reading', generation: 'g', revision: 'r' };

async function call(path: string, init: RequestInit = {}) {
	const response = await worker.fetch(new Request(`https://crate.test/reading/${path}`, { ...init,
		headers: { Authorization: 'Bearer vault-credential', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), ...init.headers as Record<string, string> } }), env);
	const body = await response.text();
	return { response, body, json: () => JSON.parse(body) as Record<string, unknown>, rowsRead: parseD1Usage(response.headers.get(D1_USAGE_HEADER))?.rowsRead ?? 0 };
}
const shard = async (text: string) => {
	const bytes = new TextEncoder().encode(text), hash = await sha256Hex(bytes);
	const put = await call(`index/shard?hash=${hash}`, { method: 'PUT', body: bytes, headers: { 'Content-Length': String(bytes.byteLength) } });
	expect(put.response.status, put.body).toBe(204);
	return hash;
};
const manifest = (shards: Record<number, string>, basis = 0): ReadingIndexManifest => ({ format: 1, generation: policy.generation, basis,
	shards: Array.from({ length: READING_INDEX_SHARDS }, (_, index) => shards[index] ?? '') });
const publish = (value: ReadingIndexManifest, expected: string | null) => call('index', { method: 'PUT', body: JSON.stringify({ manifest: value, expected }) });
const note = (n: number) => createReadingNote({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, url: `https://example.invalid/${n}`, title: `Article ${n}`, savedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString() });

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('vault', ?, 'vault')").bind(await sha256Hex('vault-credential')).run();
	await env.DB.prepare('INSERT INTO reading_policy(id, enabled, folder_path, generation, revision) VALUES (1, ?, ?, ?, ?)').bind(policy.enabled, policy.folder_path, policy.generation, policy.revision).run();
	await env.DB.prepare("INSERT INTO reading_index(id, scope, revision) VALUES (1, ?, 'seeded')").bind(readingIndexScope(policy)).run();
});
afterEach(reset);

it('publishes a manifest only over the version read, after its shards, and serves both', async () => {
	expect((await call('index')).response.status).toBe(404);
	const bytes = new TextEncoder().encode('{"cards":[]}');
	const wrong = await call(`index/shard?hash=${'0'.repeat(64)}`, { method: 'PUT', body: bytes, headers: { 'Content-Length': String(bytes.byteLength) } });
	expect(wrong.response.status).toBe(400);
	// A manifest cannot name a shard the server does not have.
	expect((await publish(manifest({ 3: 'a'.repeat(64) }), null)).json()).toMatchObject({ code: 'reading_index_shard_missing' });
	const first = await shard('{"cards":["first"]}');
	const published = await publish(manifest({ 3: first }), null);
	expect(published.response.status, published.body).toBe(200);
	const etag = published.json().etag as string;
	const read = await call('index');
	expect(read.json()).toMatchObject({ manifest: { basis: 0, shards: expect.arrayContaining([first]) as unknown }, etag });
	// Polling an unchanged index is one conditional R2 read.
	expect((await call('index', { headers: { 'If-None-Match': read.response.headers.get('ETag')! } })).response.status).toBe(304);
	const served = await call(`index/shard?hash=${first}`);
	expect(served.body).toBe('{"cards":["first"]}');
	expect(served.response.headers.get('Cache-Control')).toContain('immutable');
	// Another device's stale view, or another folder setup, is refused.
	expect((await publish(manifest({ 3: first }), null)).json()).toMatchObject({ code: 'reading_index_conflict', etag });
	expect((await publish({ ...manifest({ 3: first }), generation: 'other' }, etag)).json()).toMatchObject({ code: 'reading_index_stale' });
	expect((await publish(manifest({ 3: first }, 99), etag)).json()).toMatchObject({ code: 'reading_index_stale' });
});

it('keeps a replaced shard for a day, then deletes it with a later publish', async () => {
	const old = await shard('{"cards":["old"]}');
	let etag = (await publish(manifest({ 1: old }), null)).json().etag as string;
	const next = await shard('{"cards":["next"]}');
	etag = (await publish(manifest({ 1: next }), etag)).json().etag as string;
	// A web app that read the first manifest can still download the old shard.
	expect(await env.BUCKET.head(readingIndexShardKey(old))).not.toBeNull();
	// The day passes.
	const stored = JSON.parse(await (await env.BUCKET.get(READING_INDEX_MANIFEST_KEY))!.text()) as { retired: Array<{ at: number }> };
	stored.retired = stored.retired.map(entry => ({ ...entry, at: 0 }));
	etag = (await env.BUCKET.put(READING_INDEX_MANIFEST_KEY, JSON.stringify(stored)))!.etag;
	expect((await publish(manifest({ 1: next, 2: await shard('{"cards":["more"]}') }), etag)).response.status).toBe(200);
	expect(await env.BUCKET.head(readingIndexShardKey(old))).toBeNull();
	expect(await env.BUCKET.head(readingIndexShardKey(next))).not.toBeNull();
});

it('answers the tail with the notes changed since the basis, reading rows for those changes only', { timeout: 120_000 }, async () => {
	// A large library already indexed, without changelog rows of its own.
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10000)
    INSERT INTO files(path, portable_path, storage_key, hash, size) SELECT 'Reading/old-' || x || '.md', 'reading/old-' || x || '.md', 'old-' || x, '', 0 FROM n`).run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/One.md', note(1), null);
	const basis = (await env.DB.prepare("SELECT MAX(seq) AS seq FROM changelog").first<{ seq: number }>())!.seq;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Two.md', note(2), null);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Outside/Three.md', note(3), null);
	const tail = await call(`index/changes?after=${basis}`);
	expect(tail.response.status, tail.body).toBe(200);
	const answer = tail.json() as { notes: Array<{ title: string; path: string }>; removed: string[]; changedPaths: string[]; lastSeq: number; deltaBase: string; revision: string };
	expect(answer.notes.map(item => item.path)).toEqual(['Reading/Two.md']);
	expect(answer.removed).toEqual([]);
	expect(answer.lastSeq).toBeGreaterThan(basis);
	expect(answer.deltaBase).toMatch(/^\d+\.[a-f0-9]{32}$/);
	// Before: a first load read a row per note, 10,000 here.
	expect(parseD1Usage(tail.response.headers.get(D1_USAGE_HEADER))?.complete).toBe(true);
	expect(tail.rowsRead).toBeGreaterThan(0);
	expect(tail.rowsRead).toBeLessThan(40);
	// A position the changelog cannot replay asks for a full list.
	expect((await call('index/changes?after=999999')).json()).toMatchObject({ expired: true });
	expect((await call('index/file?path=Reading/One.md')).response.status).toBe(409);
});
