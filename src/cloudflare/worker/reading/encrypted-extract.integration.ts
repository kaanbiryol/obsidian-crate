/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';
import { sha256Hex } from '@/platform/sha256';

const link = 'https://private.example/confidential-article';
const article = '<!doctype html><html><head><title>Confidential title</title></head><body><article><h1>Confidential title</h1><p>Enough original prose for the extractor to keep this paragraph as the article body.</p><p>A second paragraph keeps the article long enough to count as readable content.</p></article></body></html>';
beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function setup(encrypted = true, scope = 'reading') {
  const { state } = await createEncryptionFixture('active');
  await env.DB.batch([
    ...(encrypted ? [env.DB.prepare('INSERT INTO server_state(id,encryption) VALUES (1,?)').bind(JSON.stringify(state))] : []),
    env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','policy','revision')"),
    env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path,reading_generation) VALUES ('reader',?,?,'Reading','policy')").bind(await sha256Hex('reader-token'), scope),
  ]);
  const fetch = vi.fn(async (request: Request) => request.url === link
    ? new Response(article, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response('Missing', { status: 404 }));
  const extract = (url: string) => worker.fetch(new Request('https://test/reading/encrypted-extract', { method: 'POST', body: JSON.stringify({ url }),
    headers: { Authorization: 'Bearer reader-token', 'X-Crate-Protocol': '1', ...(encrypted ? { 'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) } : {}) } }),
  { ...env, READING_FETCH: { fetch } });
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

it('stays closed to unencrypted folders, capture-only credentials and invalid links', async () => {
  expect((await (await setup(false)).extract(link)).status).toBe(409);
  await reset(); await applySchema(env.DB);
  expect((await (await setup(true, 'reading_capture')).extract(link)).status).toBe(403);
  await reset(); await applySchema(env.DB);
  const { fetch, extract } = await setup();
  expect((await extract('http://user:secret@private.example/')).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
