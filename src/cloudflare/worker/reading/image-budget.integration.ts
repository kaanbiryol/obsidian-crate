/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleReadingRoute } from '../test-support/reading-route-test-harness';
import { publishCapture, type PendingCapture } from './captures';
import { runReadingExtraction } from './extraction/jobs';
import { stageArticleImages, stageReadingImageBatch, WORKER_IMAGE_LIMITS, type ReadingImageBatch } from './extraction/images';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../sync/markdown-files';
import { getStoredFileRow } from '../sync/storage';
import { createReadingNote } from '@/reading/core/notes';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import type { Env } from '../types';

// The Workers Free plan allows 50 subrequests per invocation: fetches and R2 and D1 calls all count.
const FREE_PLAN_SUBREQUESTS = 50;
const principal = { tokenId: 'vault', scope: 'vault' as const };
const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
const command = (action: string, body: Record<string, unknown>) => handleReadingRoute(new Request(`https://test/reading/${action}`, { method: 'POST', body: JSON.stringify(body) }), env, principal);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const images = Array.from({ length: WORKER_IMAGE_LIMITS.count! + 5 }, (_, i) => i + 1);
const page = `<!doctype html><html><head><title>Pictures</title></head><body><article><h1>Pictures</h1>${
	images.map(i => `<p>Paragraph ${i} of an article that has a picture after every paragraph, long enough to read as prose.</p><img src="https://cdn.example/${i}.png" alt="Picture ${i}">`).join('')}</article></body></html>`;

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
	expect((await command('policy', { enabled: true, folderPath: 'Reading', revision: null })).status).toBe(200);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

/** Counts each call one invocation makes to D1, R2 and the network. */
function metered(fetch: (request: Request) => Promise<Response>) {
	let count = 0;
	const statement = (inner: D1PreparedStatement): D1PreparedStatement => new Proxy(inner, { get(target, key) {
		const value = Reflect.get(target, key) as unknown;
		if (typeof value !== 'function') return value;
		if (key === 'bind') return (...args: unknown[]) => statement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
		return (...args: unknown[]) => { if (['run', 'first', 'all', 'raw'].includes(key as string)) count++; return (value as (...a: unknown[]) => unknown).apply(target, args); };
	} });
	const DB = new Proxy(env.DB, { get(target, key) {
		if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
		if (key === 'batch') return (statements: D1PreparedStatement[]) => { count++; return target.batch(statements); };
		const value = Reflect.get(target, key) as unknown;
		return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
	} });
	const BUCKET = new Proxy(env.BUCKET, { get(target, key) {
		const value = Reflect.get(target, key) as unknown;
		return typeof value === 'function' ? (...args: unknown[]) => { count++; return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
	} });
	const READING_FETCH = { fetch: async (request: Request) => { count++; return fetch(request); } };
	return { env: { ...env, DB, BUCKET, READING_FETCH } as Env, count: () => count };
}
// Every image redirects once, the most an image download follows.
async function publicWeb(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (url.href === 'https://example.com/article') return new Response(page, { headers: { 'Content-Type': 'text/html' } });
	if (url.hostname === 'cdn.example') return new Response(null, { status: 302, headers: { Location: `https://images.example${url.pathname}` } });
	if (url.hostname === 'images.example') return new Response(png.slice().buffer, { headers: { 'Content-Type': 'image/png' } });
	return new Response('Not found', { status: 404 });
}

it('saves an article\'s images within the free plan\'s subrequests in each invocation', async () => {
	expect((await command('capture', { url: 'https://example.com/article', operationId: operation() })).status).toBe(200);
	// A due extraction job waits for the next run rather than sharing this one.
	const other = crypto.randomUUID();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reading/Other.md', createReadingNote({ id: other, url: 'https://example.com/other', savedAt: new Date().toISOString() }), null);
	const generation = (await env.DB.prepare('SELECT generation FROM reading_policy').first<{ generation: string }>())!.generation;
	await env.DB.prepare("INSERT OR REPLACE INTO reading_jobs(path, item_id, generation, source_revision, block_hash, url, attempts, available_at) VALUES ('Reading/Other.md', ?, ?, ?, 'b', 'https://example.com/other', 0, 0)")
		.bind(other, generation, (await getStoredFileRow(env.DB, 'Reading/Other.md'))!.storageKey).run();
	const fetched = vi.fn(publicWeb);
	const alarm = metered(fetched);
	// Each batch is its own Durable Object request: one subrequest here, and its own invocation.
	const batches: number[] = [];
	const stageBatch = async (batch: ReadingImageBatch) => {
		const invocation = metered(fetched);
		const staged = await stageReadingImageBatch(invocation.env, batch, request => invocation.env.READING_FETCH!.fetch(request));
		batches.push(invocation.count());
		return staged;
	};
	await runReadingExtraction({ storage: { setAlarm: async () => {} } } as unknown as DurableObjectState, alarm.env, stageBatch);
	// The run also sends one Durable Object request per batch and one to publish the article.
	const run = alarm.count() + batches.length + 1;
	expect(run).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
	expect(batches).toHaveLength(WORKER_IMAGE_LIMITS.count! / 10);
	for (const batch of batches) expect(batch).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
	expect(fetched.mock.calls.map(([request]) => request.url)).not.toContain('https://example.com/other');
	expect(await env.DB.prepare('SELECT 1 FROM reading_jobs').first()).not.toBeNull();
	const note = (await env.DB.prepare("SELECT path FROM files WHERE path LIKE 'Reading/Pictures%.md'").first<{ path: string }>())!;
	const content = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, note.path))!.content;
	expect(content.match(/\]\(attachments\//g)).toHaveLength(WORKER_IMAGE_LIMITS.count!);

	// Publication runs in the coordinator, its own invocation: measured here on its own.
	await reset(); await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
	expect((await command('policy', { enabled: true, folderPath: 'Reading', revision: null })).status).toBe(200);
	expect((await command('capture', { url: 'https://example.com/article', operationId: operation() })).status).toBe(200);
	const row = (await env.DB.prepare('SELECT * FROM reading_captures').first<PendingCapture>())!;
	const article = { title: 'Pictures', markdown: images.map(i => `![Picture ${i}](https://cdn.example/${i}.png)`).join('\n\n') };
	const staged = await stageArticleImages(article, 'Reading', row.id, batch => stageReadingImageBatch(env, batch, publicWeb));
	expect(staged).toHaveLength(WORKER_IMAGE_LIMITS.count!);
	const publish = metered(publicWeb);
	await publishCapture(publish.env, row.id, row.generation, article, undefined, staged);
	expect(publish.count()).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
	console.warn(`subrequests: run ${run}, batches ${Math.max(...batches)}, publish ${publish.count()}`);
}, 60_000);
