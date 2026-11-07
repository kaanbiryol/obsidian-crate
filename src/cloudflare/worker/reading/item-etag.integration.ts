/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { handleReadingRoute } from '../test-support/reading-route-test-harness';
import { ensureReadingIndex } from './library-index';
import { policy, readStoredNote } from './common';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { getStoredFileRow } from '../sync/storage';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { adoptReadingClip, parseReadingNote } from '@/reading/core/notes';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { sha256Hex } from '@/platform/sha256';
import type { Env } from '../types';

const principal = { tokenId: 'vault', scope: 'vault' as const };
const operationId = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
const route = (path: string, init: RequestInit = {}) => handleReadingRoute(new Request(`https://test/reading/${path}`, init), env, principal);
const command = (path: string, body: Record<string, unknown>) => route(path, { method: 'POST', body: JSON.stringify(body) });

beforeEach(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope) VALUES ('vault', ?, 'vault')").bind(await sha256Hex('vault-credential')).run();
	expect((await command('policy', { enabled: true, folderPath: 'Reading', revision: null })).status).toBe(200);
});
afterEach(reset);

async function savedNote(path = 'Reading/Article.md') {
	const content = await adoptReadingClip('Article text.', path, '2026-09-26T00:00:00Z');
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, path, content, null);
	return parseReadingNote(content)!;
}

it('answers an unchanged item with 304 before reading R2 and returns the committed item from updates', async () => {
	const note = await savedNote();
	const current = (await policy(env.DB))!;
	while ((await ensureReadingIndex(env, current, file => readStoredNote(env, file))).state !== 'complete');
	const first = await route(`item?id=${note.crate_reading_id}`);
	const etag = first.headers.get('ETag')!;
	expect(first.status).toBe(200);
	expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
	const { markdown } = await first.json() as { markdown: string };

	// The revision is unchanged, so its bytes are never read: a missing object still answers 304.
	const stored = (await getStoredFileRow(env.DB, 'Reading/Article.md'))!;
	const object = await env.BUCKET.get(stored.storageKey);
	await env.BUCKET.delete(stored.storageKey);
	const unchanged = await route(`item?id=${note.crate_reading_id}`, { headers: { 'If-None-Match': etag } });
	expect(unchanged.status).toBe(304);
	expect(unchanged.headers.get('ETag')).toBe(etag);
	await env.BUCKET.put(stored.storageKey, await object!.arrayBuffer(), { customMetadata: object!.customMetadata });
	expect((await route(`item?id=${note.crate_reading_id}`, { headers: { 'If-None-Match': '"other"' } })).status).toBe(200);

	const update = await command('update', { id: note.crate_reading_id, before: { favorite: false }, changes: { favorite: true }, operationId: operationId() });
	const saved = await update.json() as { saved: boolean; article: { item: { favorite: boolean; path: string }; etag: string; markdownHash: string } };
	expect(saved).toMatchObject({ saved: true, article: { item: { favorite: true, path: 'Reading/Article.md' }, markdownHash: await sha256Hex(markdown) } });
	expect(saved.article.etag).not.toBe(etag);
	// The returned ETag is the item's own: a client holding it reads 304.
	expect((await route(`item?id=${note.crate_reading_id}`, { headers: { 'If-None-Match': etag } })).status).toBe(200);
	const after = await route(`item?id=${note.crate_reading_id}`, { headers: { 'If-None-Match': saved.article.etag } });
	expect(after.status).toBe(304);

	// A queued capture has no file revision, so it carries no ETag.
	const queued = await (await command('capture', { url: 'https://example.com/queued', operationId: operationId() })).json() as { id: string };
	const capture = await route(`item?id=${queued.id}`);
	expect(capture.status).toBe(200);
	expect(capture.headers.get('ETag')).toBeNull();
	expect((await route('item?id=missing')).status).toBe(409);
});

it('serves unchanged libraries and items at the edge and lists or rebuilds under the coordinator', async () => {
	const note = await savedNote();
	let forwarded = 0;
	const namespace = env.REMINDER_ALARMS;
	const counted: Env = { ...env, REMINDER_ALARMS: { ...namespace, idFromName: (name: string) => namespace.idFromName(name),
		get: (id: DurableObjectId) => {
			const stub = namespace.get(id);
			return { fetch: (input: RequestInfo | URL, init?: RequestInit) => { forwarded++; return stub.fetch(input, init); } };
		} } };
	const read = async (path: string, headers: Record<string, string> = {}) => {
		const before = forwarded;
		const response = await worker.fetch(new Request(`https://crate.test/reading/${path}`, {
			headers: { Authorization: 'Bearer vault-credential', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), ...headers } }), counted);
		return { response, forwarded: forwarded - before };
	};
	// No index yet: building it writes, so the coordinator builds it.
	const built = await read('list');
	expect(built).toMatchObject({ response: { status: 200 }, forwarded: 1 });
	const etag = built.response.headers.get('ETag')!;
	expect(await built.response.json()).toMatchObject({ items: [{ crate_reading_id: note.crate_reading_id }] });
	expect(await read('list', { 'If-None-Match': etag })).toMatchObject({ response: { status: 304 }, forwarded: 0 });
	const item = await read(`item?id=${note.crate_reading_id}`);
	expect(item).toMatchObject({ response: { status: 200 }, forwarded: 0 });
	expect(await item.response.json()).toMatchObject({ item: { crate_reading_id: note.crate_reading_id }, markdown: 'Article text.' });
	expect(await read(`item?id=${note.crate_reading_id}`, { 'If-None-Match': item.response.headers.get('ETag')! })).toMatchObject({ response: { status: 304 }, forwarded: 0 });
	// A changed library's page is parsed by the coordinator.
	expect(await read('list')).toMatchObject({ response: { status: 200 }, forwarded: 1 });
	// A new Reading folder generation rebuilds the index under the coordinator again.
	await env.DB.prepare("UPDATE reading_policy SET generation = 'next' WHERE id = 1").run();
	expect(await read(`item?id=${note.crate_reading_id}`)).toMatchObject({ response: { status: 200 }, forwarded: 1 });
});
