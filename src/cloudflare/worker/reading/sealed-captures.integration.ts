/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { createEncryptionFixture, storeEncryptionState } from '../test-support/encryption-test-harness';
import worker from '../index';
import { FileKeyAuthority } from '@/encryption/file-authority';
import { openFile } from '@/encryption/file-codec';
import { parseEncryptedFile } from '@/encryption/file-format';
import { parseReadingNote } from '@/reading/core/notes';
import { READING_SHORTCUT_CONTRACT as contract } from '@/reading/shortcut';
import { sha256Hex } from '@/platform/sha256';
import { resolveEncryptedPath } from '@/encryption/path-binding';

const link = 'https://private.example/shortcut-article';
const article = '<!doctype html><html><head><title>Shortcut title</title></head><body><article><h1>Shortcut title</h1><p>Enough original prose for the extractor to keep this paragraph as the article body.</p><p>A second paragraph keeps the article long enough to count as readable content.</p></article></body></html>';
beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function setup() {
  const fixture = await createEncryptionFixture('active');
  await storeEncryptionState(env.DB, fixture.state);
  const reading = { plain: 'Reading', wire: await fixture.paths.wire('Reading') };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,?,'policy','revision')").bind(reading.wire),
    env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path,reading_generation) VALUES ('capture',?,'reading_capture',?,'policy')").bind(await sha256Hex('capture-token'), reading.wire),
  ]);
  /** Open a stored note the way a device does, from its server path. */
  const open = async (file: { path: string; storage_key: string }) => {
    const bytes = new Uint8Array(await (await env.BUCKET.get(file.storage_key))!.arrayBuffer());
    const keys = await FileKeyAuthority.fromBundle(fixture.bundle);
    return openFile(bytes, (metadataPath, sealed) => resolveEncryptedPath(fixture.paths, file.path, metadataPath, sealed, reading), keys.forPath(file.path));
  };
  const fetch = vi.fn(async (request: Request) => request.url === link
    ? new Response(article, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response('Missing', { status: 404 }));
  const prepare = (url: string, title?: string) => worker.fetch(new Request(`https://test${contract.preparePath}`, {
    method: 'POST', body: JSON.stringify({ url, ...(title ? { title } : {}) }),
    headers: { Authorization: 'Bearer capture-token', 'Content-Type': 'application/json', [contract.revisionHeader]: String(contract.revision) },
  }), { ...env, READING_FETCH: { fetch } });
  return { ...fixture, fetch, prepare, reading, open };
}

async function storedText(): Promise<string> {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ name: string }>();
  const rows = await Promise.all(results.map(({ name }) => env.DB.prepare(`SELECT * FROM "${name}"`).all()));
  const objects = await Promise.all((await env.BUCKET.list()).objects.map(async object => (await env.BUCKET.get(object.key))!.text()));
  return JSON.stringify(rows.map(row => row.results)) + JSON.stringify(objects);
}

it('saves a sealed note from the shortcut that the vault opens and the server cannot read', async () => {
  const h = await setup();
  const response = await h.prepare(link, 'Shared title');
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json() as { saved: boolean; id: string; launchUrl: string };
  expect(body.saved).toBe(true);
  expect(new URL(body.launchUrl).pathname).toBe('/notifications/save-reading');
  expect(new URL(body.launchUrl).hash).toBe(`#saved=${body.id}`);
  const file = (await env.DB.prepare('SELECT path, storage_key FROM files').first<{ path: string; storage_key: string }>())!;
  // Without the path key the server picks a random name inside the tagged Reading folder.
  expect(file.path).toMatch(new RegExp(`^${h.reading.wire}/[a-z2-7]{26}\\.md$`));
  const bytes = new Uint8Array(await (await env.BUCKET.get(file.storage_key))!.arrayBuffer());
  expect(parseEncryptedFile(bytes).descriptor).toMatchObject({ keyId: h.state.seal.keyId, seal: { epk: expect.any(String) as string } });
  const opened = await h.open(file);
  // The sealed name follows the note's title, like a note saved on a device.
  expect(opened.metadata.path).toBe(`Reading/Shared title - private.example - ${body.id.slice(0, 8)}.md`);
  const note = parseReadingNote(new TextDecoder().decode(opened.content));
  expect(note).toMatchObject({ crate_reading_id: body.id, source_url: link, title: 'Shared title', extraction_status: 'ready' });
  const stored = await storedText();
  expect(stored).not.toContain('shortcut-article');
  expect(stored).not.toContain('Enough original prose');
  expect(stored).not.toContain('Shared title');
  expect(stored).not.toContain('private.example - ');
});

it('still saves a bookmark when the server cannot download the page', async () => {
  const h = await setup();
  const response = await h.prepare('https://private.example/blocked');
  expect(response.status, await response.clone().text()).toBe(200);
  const file = (await env.DB.prepare('SELECT path, storage_key FROM files').first<{ path: string; storage_key: string }>())!;
  expect(parseReadingNote(new TextDecoder().decode((await h.open(file)).content)))
    .toMatchObject({ source_url: 'https://private.example/blocked', extraction_status: 'unavailable' });
  expect(await storedText()).not.toContain('private.example/blocked');
});

it('refuses while an encryption reset is in progress and for links with credentials', async () => {
  const h = await setup();
  await env.DB.prepare('UPDATE server_state SET encryption=? WHERE id=1').bind(JSON.stringify({ ...h.state, mode: 'resetting' })).run();
  expect((await h.prepare(link)).status).toBe(423);
  await env.DB.prepare('UPDATE server_state SET encryption=? WHERE id=1').bind(JSON.stringify(h.state)).run();
  const invalid = await h.prepare('http://user:secret@private.example/');
  expect(invalid.status).toBe(400);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
});
