/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleReadingRoute } from '../test-support/reading-route-test-harness';
import { publishCapture, type PendingCapture } from './captures';
import { stageArticleImages } from './extraction/images';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { readCommittedMarkdownFileVersion } from '../sync/markdown-files';
import { getStoredFileRow } from '../sync/storage';
import { parseReadingNote } from '@/reading/core/notes';
import { readReadingFrontmatter } from '@/reading/core/frontmatter';
import { sha256Hex } from '@/platform/sha256';
import { featurePolicy } from '../server/feature-policy';
import { handleFeaturePolicy } from '../server/feature-policy-handler';

const principal = { tokenId: 'vault', scope: 'vault' as const };
const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
const command = (action: string, body: Record<string, unknown>) => handleReadingRoute(new Request(`https://test/reading/${action}`, { method: 'POST', body: JSON.stringify(body) }), env, principal);
const get = (path: string) => handleReadingRoute(new Request(`https://test${path}`), env, principal);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

beforeEach(async () => {
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash) VALUES ('vault','hash')").run();
	expect((await command('policy', { enabled: true, folderPath: 'Reading', revision: null })).status).toBe(200);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function savedCapture() {
	expect((await command('capture', { url: 'https://example.com/article', operationId: operation() })).status).toBe(200);
	return (await env.DB.prepare('SELECT * FROM reading_captures').first<PendingCapture>())!;
}
const article = { title: 'Pictures', markdown: 'An article with pictures.\n\n![A chart](https://cdn.example/chart.png)\n\n![Logo](https://cdn.example/logo.svg)\n\n![Gone](https://cdn.example/missing.png)\n' };
const fetchPublic = vi.fn(async (request: Request) => {
	const bodies: Record<string, Uint8Array> = { 'https://cdn.example/chart.png': png, 'https://cdn.example/logo.svg': svg };
	const body = bodies[request.url];
	return body ? new Response(body.slice().buffer, { headers: { 'Content-Type': 'image/png' } }) : new Response('Not found', { status: 404 });
});

it('saves a capture\'s images beside its note, serves them to the reader and deletes them with the note', async () => {
	const row = await savedCapture();
	const images = await stageArticleImages(env, article, 'Reading', row.id, fetchPublic);
	expect(images.map(image => image.path)).toEqual([`Reading/attachments/${row.id}/1.png`]);
	// Staged only: nothing is published before the note.
	expect(await getStoredFileRow(env.DB, images[0]!.path)).toBeNull();
	await publishCapture(env, row.id, row.generation, article, undefined, images);
	const path = `Reading/Pictures - example.com - ${row.id.slice(0, 8)}.md`;
	const note = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!.content;
	expect(note).toContain(`![A chart](attachments/${row.id}/1.png)`);
	// An image that is not a raster image or failed keeps its web link.
	expect(note).toContain('![Logo](https://cdn.example/logo.svg)');
	expect(note).toContain('![Gone](https://cdn.example/missing.png)');
	expect(await getStoredFileRow(env.DB, images[0]!.path)).toMatchObject({ hash: await sha256Hex(png.slice().buffer) });
	// A repeated delivery neither duplicates the image nor recreates the note.
	await publishCapture(env, row.id, row.generation, article, undefined, images);
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toMatchObject({ n: 2 });

	const served = await get(`/reading/file?path=${encodeURIComponent(images[0]!.path)}`);
	expect(served.status).toBe(200);
	expect(served.headers.get('Content-Type')).toBe('image/png');
	expect(served.headers.get('X-Content-Type-Options')).toBe('nosniff');
	expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);
	for (const refused of [path, 'Other/image.png', 'Reading/../Other/image.png']) expect((await get(`/reading/file?path=${encodeURIComponent(refused)}`)).status).toBe(400);
	expect((await get(`/reading/file?path=${encodeURIComponent('Reading/attachments/none.png')}`)).status).toBe(404);

	const item = parseReadingNote(note)!;
	const deleted = await command('delete', { id: item.crate_reading_id, before: { reading_status: item.reading_status, favorite: item.favorite, tags: item.tags },
		markdownHash: await sha256Hex(readReadingFrontmatter(note)!.body), operationId: operation() });
	expect(deleted.status, await deleted.clone().text()).toBe(200);
	expect(await getStoredFileRow(env.DB, path)).toBeNull();
	expect(await getStoredFileRow(env.DB, images[0]!.path)).toBeNull();
	// The deleted image stays recoverable from file history, like the note.
	expect(await env.DB.prepare("SELECT 1 FROM file_versions WHERE path = ? AND reason = 'deleted'").bind(images[0]!.path).first()).not.toBeNull();
});

it('stores the choice to load images from the website and then keeps web links', async () => {
	const current = await featurePolicy(env.DB);
	expect(current).not.toHaveProperty('readingImages');
	expect((await handleFeaturePolicy(new Request('https://test/features', { method: 'POST', body: JSON.stringify({ readingImages: 'remote', revision: current.revision }) }), env)).status).toBe(200);
	expect(await featurePolicy(env.DB)).toMatchObject({ reading: true, reminders: true, readingImages: 'remote' });
	expect(await (await handleFeaturePolicy(new Request('https://test/features'), env)).json()).toMatchObject({ readingImages: 'remote' });
	// A feature switch keeps the image choice, and choosing save again stores nothing.
	const remote = await featurePolicy(env.DB);
	expect((await handleFeaturePolicy(new Request('https://test/features', { method: 'POST', body: JSON.stringify({ feature: 'reminders', enabled: false, revision: remote.revision }) }), env)).status).toBe(200);
	const toggled = await featurePolicy(env.DB);
	expect(toggled).toMatchObject({ reminders: false, readingImages: 'remote' });
	expect((await handleFeaturePolicy(new Request('https://test/features', { method: 'POST', body: JSON.stringify({ readingImages: 'save', revision: toggled.revision }) }), env)).status).toBe(200);
	expect(await featurePolicy(env.DB)).not.toHaveProperty('readingImages');
	expect((await handleFeaturePolicy(new Request('https://test/features', { method: 'POST', body: JSON.stringify({ readingImages: 'other', revision: (await featurePolicy(env.DB)).revision }) }), env)).status).toBe(400);

	const row = await savedCapture();
	await publishCapture(env, row.id, row.generation, article);
	const note = (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, `Reading/Pictures - example.com - ${row.id.slice(0, 8)}.md`))!.content;
	expect(note).toContain('![A chart](https://cdn.example/chart.png)');
	expect(await env.DB.prepare('SELECT count(*) AS n FROM files').first()).toMatchObject({ n: 1 });
});

it('cleans up staged images whose folder changed before publication', async () => {
	const row = await savedCapture();
	const images = await stageArticleImages(env, article, 'Elsewhere', row.id, fetchPublic);
	await publishCapture(env, row.id, row.generation, article, undefined, images);
	expect(await getStoredFileRow(env.DB, images[0]!.path)).toBeNull();
	expect(await env.DB.prepare('SELECT 1 FROM object_cleanup_queue WHERE storage_key = ?').bind(images[0]!.objectKey).first()).not.toBeNull();
});
