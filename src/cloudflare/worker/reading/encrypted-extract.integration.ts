/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';
import { sha256Hex } from '@/platform/sha256';
import { TRANSFER_PATHS } from '../coordinator/coordinator';
import { forwardTransferRequest } from '../sync/transfer-dispatch';
import { extractInTransfer, forwardEncryptedExtract } from './encrypted-extract';

// Pool objects run the built Worker without this test's network stub, so the
// extraction pool's handler runs here with the environment the request carried.
vi.mock('../sync/transfer-dispatch', () => ({
	forwardTransferRequest: vi.fn(async (request: Request, env: Parameters<typeof extractInTransfer>[1], path: string) => {
		const target = new URL(request.url); target.pathname = path;
		return extractInTransfer(new Request(target, request), env);
	}),
}));

const link = 'https://private.example/confidential-article';
const article = '<!doctype html><html><head><title>Confidential title</title></head><body><article><h1>Confidential title</h1><p>Enough original prose for the extractor to keep this paragraph as the article body.</p><p>A second paragraph keeps the article long enough to count as readable content.</p></article></body></html>';
beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function setup(encrypted = true, scope = 'reminders', fetching = true) {
	const { state } = await createEncryptionFixture('active');
	await env.DB.batch([
		...(encrypted ? [env.DB.prepare('INSERT INTO server_state(id,encryption) VALUES (1,?)').bind(JSON.stringify(state))] : []),
		env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,?,'Reading','policy','revision')").bind(Number(fetching)),
		env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path,reading_generation) VALUES ('reader',?,?,'Reading','policy')").bind(await sha256Hex('reader-token'), scope),
	]);
	const fetch = vi.fn(async (request: Request) => request.url === link
		? new Response(article, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response('Missing', { status: 404 }));
	const extract = (url: string, options: { images?: boolean } = {}) => worker.fetch(new Request('https://test/reading/encrypted-extract', { method: 'POST', body: JSON.stringify({ url, ...options }),
		headers: { Authorization: 'Bearer reader-token', 'X-Crate-Protocol': '1', ...(encrypted ? { 'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) } : {}) } }),
	// The edge limiter is per source address and shared; these tests check the per-credential limit.
	{ ...env, READING_FETCH: { fetch }, NOTIFICATION_REQUEST_LIMITER: { limit: async () => ({ success: true }) } });
	return { fetch, extract };
}

async function storedText(): Promise<string> {
	const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
	const rows = await Promise.all(results.map(({ name }) => env.DB.prepare(`SELECT * FROM "${name}"`).all()));
	return JSON.stringify(rows.map(row => row.results)) + JSON.stringify((await env.BUCKET.list()).objects.map(object => object.key));
}

it('returns the article for an encrypted Reading folder without storing the link or its content', async () => {
	const { fetch, extract } = await setup();
	const response = await extract(link);
	expect(response.status, await response.clone().text()).toBe(200);
	expect(response.headers.get('Cache-Control')).toBe('no-store');
	// Parsing runs in the extraction pool, beyond the public Worker's CPU budget.
	expect(vi.mocked(forwardTransferRequest).mock.calls.at(-1)?.[2]).toBe(TRANSFER_PATHS.readingExtract);
	const { article: captured } = await response.json() as { article: { title: string; markdown: string } };
	expect(captured.title).toBe('Confidential title');
	expect(captured.markdown).toContain('Enough original prose');
	expect((fetch.mock.calls[0]![0]).url).toBe(link);
	const stored = await storedText();
	expect(stored).not.toContain('confidential-article');
	expect(stored).not.toContain('Enough original prose');
});

it('reports a failed download without echoing the link, so the client keeps its bookmark', async () => {
	const { extract } = await setup();
	const response = await extract('https://private.example/missing-article');
	expect(response.status).toBe(422);
	expect(await response.text()).not.toContain('missing-article');
	expect(await storedText()).not.toContain('missing-article');
});

it('downloads links up to the longest one Reading saves', async () => {
	const { fetch, extract } = await setup();
	const long = `${link}?q=${'a'.repeat(8192 - link.length - 3)}`;
	expect(long).toHaveLength(8192);
	expect((await extract(long)).status).toBe(422);
	expect((fetch.mock.calls[0]![0]).url).toBe(long);
});

it('stays closed to unencrypted folders, capture-only credentials and invalid links', async () => {
	expect((await (await setup(false)).extract(link)).status).toBe(409);
	await reset(); await applySchema(env.DB);
	expect((await (await setup(true, 'reading_capture')).extract(link)).status).toBe(403);
	await reset(); await applySchema(env.DB);
	const { fetch, extract } = await setup();
	expect((await extract('http://user:secret@private.example/')).status).toBe(400);
	expect(fetch).not.toHaveBeenCalled();
});

it('refuses to download while article fetching is off, so the web app keeps a bookmark', async () => {
	const { fetch, extract } = await setup(true, 'reminders', false);
	const response = await extract(link);
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({ code: 'reading_fetching_off' });
	expect(fetch).not.toHaveBeenCalled();
});

it('limits downloads per credential like other Reading saves', async () => {
	const { fetch, extract } = await setup();
	for (let index = 0; index < 30; index++) expect((await extract(`https://private.example/missing-${index}`)).status).toBe(422);
	const limited = await extract(link);
	expect(limited.status).toBe(429);
	expect(limited.headers.get('Retry-After')).toBe('60');
	expect(fetch).toHaveBeenCalledTimes(30);
});

it('returns the images finished by the deadline and leaves a slow one on its link', async () => {
	const { downloadImagesForEncryptedReading } = await import('./extraction/images');
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
	const fetchPublic = vi.fn(async (request: Request) => request.url.endsWith('/fast.png')
		? new Response(png, { headers: { 'Content-Type': 'image/png' } })
		// A slow image server answers only once the request is aborted.
		: new Promise<Response>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason as Error))));
	const started = Date.now();
	const images = await downloadImagesForEncryptedReading({ markdown: '![](https://images.example/slow.png) ![](https://images.example/fast.png)' },
		fetchPublic, undefined, 1, AbortSignal.timeout(100));
	expect(Date.now() - started).toBeLessThan(2_000);
	expect(images.map(image => image.url)).toEqual(['https://images.example/fast.png']);
});

it('downloads no images for a retry, which keeps its note\'s images', async () => {
	const { fetch, extract } = await setup();
	const withImages = article.replace('</article>', '<img src="https://images.example/a.png" alt="Chart"></article>');
	fetch.mockImplementation(async (request: Request) => request.url === link
		? new Response(withImages, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response('Missing', { status: 404 }));
	expect((await extract(link)).status).toBe(200);
	expect(fetch.mock.calls.map(([request]) => request.url)).toEqual([link, 'https://images.example/a.png']);
	fetch.mockClear();
	expect((await extract(link, { images: false })).status).toBe(200);
	expect(fetch.mock.calls.map(([request]) => request.url)).toEqual([link]);
});

it('replaces any image choice the client put in the link with the server policy', async () => {
	vi.mocked(forwardTransferRequest).mockClear();
	const request = new Request('https://test/reading/encrypted-extract?images=1', { method: 'POST', body: '{}' });
	await forwardEncryptedExtract(request, env, false);
	expect(new URL(vi.mocked(forwardTransferRequest).mock.calls[0]![0].url).searchParams.has('images')).toBe(false);
	await forwardEncryptedExtract(new Request('https://test/reading/encrypted-extract', { method: 'POST', body: '{}' }), env, true);
	expect(new URL(vi.mocked(forwardTransferRequest).mock.calls[1]![0].url).searchParams.get('images')).toBe('1');
});

it('answers in the extraction pool as the public Worker would', async () => {
	const { transferStub } = await import('../coordinator/coordinator');
	// A link with credentials is refused before any download, so no network is needed.
	const response = await transferStub(env, 'reading-extract').fetch(`https://do${TRANSFER_PATHS.readingExtract}`,
		{ method: 'POST', body: JSON.stringify({ url: 'http://user:secret@private.example/' }) });
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ error: 'Enter a complete HTTP or HTTPS link without credentials.' });
});
