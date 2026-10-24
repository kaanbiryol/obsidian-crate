/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import worker from '../index';
import { createEncryptionFixture } from '../test-support/encryption-test-harness';
import { EncryptedReadingApi } from '@/pwa/reading/encrypted-api';
import { createReadingNote } from '@/reading/core/notes';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { openFile, sealFile } from '@/encryption/file-codec';
import { handleEncryptionConversion } from '../encryption/conversion';
import { publishCapture } from './captures';
import { handleReadingRoute } from './routes';
import { encryptJson } from '@/encryption/envelope';
import type { CapturedArticle } from '@/reading/extraction/types';
import type { ReadingItem } from '@/reading/core/model';
import { sha256Hex } from '@/platform/sha256';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
async function setup(mode: 'active' | 'converting' = 'active') {
  const { bundle, recovery, keys, state } = await createEncryptionFixture(mode);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO maintenance_state(key,value) VALUES (?,?)').bind('e2ee:state', JSON.stringify(state)),
    env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','policy','revision')"),
    env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path,reading_generation) VALUES ('reader',?,'reading','Reading','policy')").bind(await sha256Hex('reader-token')),
  ]);
  const headers = { Authorization: 'Bearer reader-token', 'X-Crate-Protocol': '1', 'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) };
  const request = (path: string, body?: string) => worker.fetch(new Request('https://test' + path, { method: body ? 'POST' : 'GET', headers, body }), env);
  const attempts = new Map<string, unknown>(), requests: string[] = [];
  let loseReply = false, beforeCommit: (() => Promise<unknown>) | undefined;
  const api = (captureArticle?: (url: string) => Promise<CapturedArticle>) => new EncryptedReadingApi({ captureArticle, folderPath: 'Reading', generation: bundle.generation, authority: keys.forPath('Reading/receipt.md'),
    request: async (path, body) => {
      if (beforeCommit && path.endsWith('encrypted-commit')) { const run = beforeCommit; beforeCommit = undefined; await run(); }
      if (body) requests.push(body); const response = await request(path, body); if (loseReply && path.endsWith('encrypted-commit') && response.ok) { loseReply = false; throw new Error('Lost reply'); } return response;
    },
    readAttempt: id => Promise.resolve(attempts.get(id)), writeAttempt: (id, value) => { attempts.set(id, value); return Promise.resolve(); },
    error: (message, status) => new Error(`${status}: ${message}`),
  });
  return { bundle, recovery, keys, state, headers, request, api, attempts, requests, loseNextReply: () => { loseReply = true; },
    /** Run another client's change after the next attempt is built but before it commits. */
    beforeNextCommit: (run: () => Promise<unknown>) => { beforeCommit = run; } };
}
it('keeps Reading captures, content, edits and replay receipts encrypted across a lost response', async () => {
  const h = await setup(), body = JSON.stringify({ operationId: operation(), url: 'https://private.example/confidential-article', title: 'Private Reading title' });
  h.loseNextReply(); await expect(h.api().request('/reading/capture', body)).rejects.toThrow('Lost reply');
  const receipt = await h.api().request('/reading/capture', body) as { saved: boolean; id: string };
  expect(receipt.saved).toBe(true); expect(h.requests[0]).toBe(h.requests[1]);
  expect(h.requests.join()).not.toContain('confidential-article'); expect(h.requests.join()).not.toContain('Private Reading title');
  const library = await h.api().request('/reading/list') as { items: Array<{ crate_reading_id: string; favorite: boolean }> };
  expect(library.items).toHaveLength(1); expect(library.items[0]!.crate_reading_id).toBe(receipt.id);
  await h.api().request('/reading/update', JSON.stringify({ operationId: operation(), id: receipt.id, changes: { favorite: true }, before: { favorite: false } }));
  await expect(h.api().request('/reading/update', JSON.stringify({ operationId: operation(), id: receipt.id, changes: { favorite: false }, before: { favorite: false } }))).rejects.toThrow('changed on another device');
  await expect(h.api().request('/reading/update', JSON.stringify({ operationId: operation(), id: receipt.id, changes: { source_url: 'https://other.example' }, before: {} }))).rejects.toThrow('409:');
  const file = await env.DB.prepare('SELECT path,storage_key FROM files').first<{ path: string; storage_key: string }>();
  const bytes = new Uint8Array(await (await env.BUCKET.get(file!.storage_key))!.arrayBuffer());
  expect(new TextDecoder().decode(bytes)).not.toContain('confidential-article');
  expect(new TextDecoder().decode((await openFile(bytes, file!.path, h.keys.forPath(file!.path))).content)).toContain('favorite: true');
  expect((await env.DB.prepare('SELECT * FROM reading_sources').all()).results).toHaveLength(0);
  expect((await env.DB.prepare('SELECT * FROM reading_jobs').all()).results).toHaveLength(0);
});
async function concurrentEdit() {
  const h = await setup();
  const saved = await h.api().request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example/concurrent' })) as { id: string };
  const { items: [item] } = await h.api().request('/reading/list') as { items: ReadingItem[] };
  const otherDevice = (changes: object, before: object) => () => h.api().request('/reading/update', JSON.stringify({ operationId: operation(), id: saved.id, changes, before }));
  const id = operation(), favorite = JSON.stringify({ operationId: id, id: saved.id, changes: { favorite: true }, before: { favorite: item!.favorite } });
  const sent = () => h.requests.filter(body => (JSON.parse(body) as { operationId: string }).operationId === id);
  const opened = async () => (await h.api().request(`/reading/item?id=${saved.id}`) as { item: ReadingItem }).item;
  return { h, item: item!, id, favorite, sent, opened, otherDevice };
}
it('rebuilds an encrypted Reading edit once against a note another device changed', async () => {
  const { h, item, id, favorite, sent, opened, otherDevice } = await concurrentEdit();
  h.beforeNextCommit(otherDevice({ tags: ['other-device'] }, { tags: item.tags }));
  expect(await h.api().request('/reading/update', favorite)).toMatchObject({ saved: true, id: item.crate_reading_id });
  const [rejected, rebuilt] = sent();
  expect(sent()).toHaveLength(2); expect(rebuilt).not.toBe(rejected);
  expect((h.attempts.get(id) as { rejected?: true }).rejected).toBeUndefined();
  expect(await opened()).toMatchObject({ favorite: true, tags: ['other-device'] });
  // A retried delivery resends the rebuilt ciphertext and replays its receipt.
  expect(await h.api().request('/reading/update', favorite)).toMatchObject({ saved: true });
  expect(sent()).toHaveLength(3); expect(sent()[2]).toBe(rebuilt);
});
it('sends an encrypted Reading edit to review when its rebuild conflicts again', async () => {
  const first = await concurrentEdit();
  first.h.beforeNextCommit(async () => {
    await first.otherDevice({ tags: ['other-device'] }, { tags: first.item.tags })();
    first.h.beforeNextCommit(first.otherDevice({ reading_status: 'archived' }, { reading_status: first.item.reading_status }));
  });
  await expect(first.h.api().request('/reading/update', first.favorite)).rejects.toThrow('409: A note changed');
  expect(first.sent()).toHaveLength(2);
  expect((first.h.attempts.get(first.id) as { rejected?: true }).rejected).toBe(true);
  expect(await first.opened()).toMatchObject({ favorite: false, tags: ['other-device'], reading_status: 'archived' });
});
it('sends an encrypted Reading edit to review when another device changed the same field', async () => {
  const same = await concurrentEdit();
  same.h.beforeNextCommit(same.otherDevice({ favorite: true }, { favorite: same.item.favorite }));
  await expect(same.h.api().request('/reading/update', same.favorite)).rejects.toThrow('changed on another device');
  expect(same.sent()).toHaveLength(1);
  expect((same.h.attempts.get(same.id) as { rejected?: true }).rejected).toBe(true);
});
it('allows encryption discovery but rejects plaintext saves and sibling-folder access', async () => {
  const h = await setup();
  const response = await worker.fetch(new Request('https://test/reading/encryption', { headers: { Authorization: 'Bearer reader-token', 'X-Crate-Protocol': '1' } }), env);
  expect(response.status).toBe(200); const metadata = await response.text();
  for (const secret of [h.recovery, h.bundle.vault.secret, h.bundle.notifications.secret, h.bundle.seal.privateKey]) expect(metadata).not.toContain(secret);
  // Reading sessions receive the same public configuration as every other session.
  expect(JSON.parse(metadata)).toEqual({ encryption: h.state });
  expect((await h.request('/sync/manifest')).status).toBe(403);
  expect((await h.request('/settings')).status).toBe(403);
  expect((await h.request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example' }))).status).toBe(428);
  const sibling = await h.request('/reading/encrypted-files?folderPath=Reminders');
  expect(sibling.status).toBe(403);
  expect(await sibling.json()).toMatchObject({ error: 'Unknown encrypted Reading folder' });
  expect((await h.request('/reminders/encrypted-files?folderPath=Reminders')).status).toBe(403);
  const manifest = await worker.fetch(new Request('https://test/notifications/manifest.json'), env);
  // Android shares stay on the device; the server only echoes a first-install form back.
  expect(await manifest.text()).toContain('share_target');
});

it('keeps article highlights, annotations, tags and archive changes encrypted and readable by another client', async () => {
  const h = await setup(), quote = 'Private highlighted passage';
  const api = h.api(async () => ({ markdown: quote, title: 'Private article' }));
  const saved = await api.request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example/highlights' })) as { id: string };
  const { items: [item] } = await api.request('/reading/list') as { items: ReadingItem[] };
  const highlight = { start: 0, end: quote.length, text: quote, id: crypto.randomUUID(), note: 'Private annotation' };
  const update = JSON.stringify({ operationId: operation(), id: saved.id,
    changes: { highlights: [highlight], tags: ['private-tag'], reading_status: 'archived' },
    before: { highlights: item!.highlights, tags: item!.tags, reading_status: item!.reading_status } });
  h.loseNextReply(); await expect(api.request('/reading/update', update)).rejects.toThrow('Lost reply');
  await api.request('/reading/update', update);
  expect(h.requests.at(-1)).toBe(h.requests.at(-2));
  const opened = await h.api().request(`/reading/item?id=${saved.id}`) as { item: ReadingItem; markdown: string };
  expect(opened.item.highlights?.[0]).toMatchObject({ text: quote, note: highlight.note });
  expect(opened.item.tags).toEqual(['private-tag']);
  expect(opened.item.reading_status).toBe('archived');
  expect(opened.markdown).toContain(`==${quote}==`);
  const file = await env.DB.prepare('SELECT storage_key FROM files').first<{ storage_key: string }>();
  const serverBytes = await (await env.BUCKET.get(file!.storage_key))!.text();
  const receipts = JSON.stringify((await env.DB.prepare('SELECT * FROM reminder_operations').all()).results);
  for (const secret of [quote, highlight.note, 'private-tag']) {
    expect(serverBytes).not.toContain(secret); expect(receipts).not.toContain(secret); expect(h.requests.join()).not.toContain(secret);
  }
});
it('preserves queued captures during conversion and prevents late plaintext publication or handoffs', async () => {
  const h = await setup('converting'), id = crypto.randomUUID();
  const note = createReadingNote({ id, url: 'https://private.example/queued', savedAt: new Date().toISOString() });
  await env.DB.prepare('INSERT INTO reading_captures(id,generation,url_identity,note,available_at) VALUES (?,?,?,?,0)').bind(id, 'policy', 'private', note).run();
  await publishCapture(env, id, 'policy', null);
  expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
  const control = (path: string, method = 'POST', body = '{}') => handleEncryptionConversion(new Request('https://test' + path, { method, headers: h.headers, body }), env, path);
  expect((await control('/encryption/conversion/finish'))?.status).toBe(409);
  const path = `Reading/Article ${id}.md`, sealed = await sealFile({ path, content: new TextEncoder().encode(note), contentType: 'text/markdown', publicData: null }, h.keys.forPath(path));
  const converted = await control('/encryption/conversion/reading-capture', 'PUT', JSON.stringify({ id, content: new TextDecoder().decode(sealed.bytes) }));
  expect(converted?.status, await converted?.clone().text()).toBe(200);
  expect((await control('/encryption/conversion/reading-capture', 'PUT', JSON.stringify({ id, content: new TextDecoder().decode(sealed.bytes) })))?.status).toBe(200);
  expect(await env.DB.prepare('SELECT 1 FROM reading_captures').first()).toBeNull();
  const handoff = await handleReadingRoute(new Request('https://test/reading/handoff', { method: 'POST', body: '{}' }), env);
  expect(handoff.status).toBe(428);
});

it.each(['active', 'converting'] as const)('blocks Shortcut preparation before parsing private content while %s', async mode => {
  await setup(mode);
  for (const path of ['/reading/shortcut/v1/prepare']) {
    const request = new Request('https://test' + path, {
      method: 'POST', headers: { 'X-Crate-Shortcut-Revision': '1' }, body: 'unparsed private content',
    });
    const response = await handleReadingRoute(request, env);
    expect(response.status).toBe(428);
    expect(request.bodyUsed).toBe(false);
  }
  expect(await env.DB.prepare('SELECT 1 FROM reading_handoffs').first()).toBeNull();
});

it('replays a converted Reading receipt without resending the private capture', async () => {
  const h = await setup('converting'), id = operation();
  const body = { operationId: id, url: 'https://private.example/legacy', title: 'Old private capture' };
  const response = { saved: true, id: crypto.randomUUID() };
  const requestHash = await sha256Hex(JSON.stringify({ action: 'capture', body }));
  await env.DB.prepare('INSERT INTO reading_operations VALUES (?,?,?,?,?,?)').bind(id, 'reader', 'policy', requestHash, JSON.stringify(response), Math.floor(Date.now() / 86400_000)).run();
  const context = { vaultId: h.bundle.vaultId, scopeId: 'vault', objectId: id, purpose: 'reminder' as const };
  const value = { requestHash, response };
  const converted = await handleEncryptionConversion(new Request('https://test/encryption/conversion/receipt', { method: 'PUT', headers: h.headers,
    body: JSON.stringify({ kind: 'reading', operationId: id, vault: await encryptJson(value, h.keys.forVaultMetadata().key, context) }) }), env, '/encryption/conversion/receipt');
  expect(converted?.status, await converted?.clone().text()).toBe(200);
  await env.DB.prepare("UPDATE maintenance_state SET value=? WHERE key='e2ee:state'").bind(JSON.stringify({ ...h.state, mode: 'active' })).run();
  expect(await h.api().request('/reading/capture', JSON.stringify(body))).toEqual(response);
  expect(h.requests).toHaveLength(0);
  expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
  expect(JSON.stringify((await env.DB.prepare('SELECT * FROM reading_operations').all()).results)).not.toContain(requestHash);
});

async function convertReceipts(h: Awaited<ReturnType<typeof setup>>, kind: 'reminder' | 'reading', receipts: Array<{ id: string; vault: string }>) {
  for (const { id, vault } of receipts) {
    const converted = await handleEncryptionConversion(new Request('https://test/encryption/conversion/receipt', { method: 'PUT', headers: h.headers,
      body: JSON.stringify({ kind, operationId: id, vault }) }), env, '/encryption/conversion/receipt');
    expect(converted?.status, await converted?.clone().text()).toBe(200);
  }
  await env.DB.prepare("UPDATE maintenance_state SET value=? WHERE key='e2ee:state'").bind(JSON.stringify({ ...h.state, mode: 'active' })).run();
}
async function receiptEnvelope(h: Awaited<ReturnType<typeof setup>>, query: string) {
  const response = await h.request(`/reading/encrypted-receipt?${query}`);
  expect(response.status).toBe(200);
  return (await response.json() as { envelope: string | null }).envelope;
}

it('recovers a lost encrypted wire attempt from the reminder operation ledger', async () => {
  const h = await setup('converting'), id = operation();
  await env.DB.prepare('INSERT INTO reminder_operations(operation_id, request_hash, response_json) VALUES (?, ?, ?)').bind(id, 'old-hash', '{"encrypted":"old"}').run();
  await convertReceipts(h, 'reminder', [{ id, vault: 'wire.key.iv.cipher.tag' }]);
  expect(await receiptEnvelope(h, `operationId=${id}&wire=1`)).toBe('wire.key.iv.cipher.tag');
  // Without `wire=1` the route reads only Reading semantic receipts.
  expect(await receiptEnvelope(h, `operationId=${id}`)).toBeNull();
  expect(await receiptEnvelope(h, `operationId=${operation()}&wire=1`)).toBeNull();
});

it('returns a converted Reading receipt only for the current Reading policy generation', async () => {
  const h = await setup('converting'), current = operation(), previous = operation();
  const day = Math.floor(Date.now() / 86400_000);
  await env.DB.batch([current, previous].map(id => env.DB.prepare('INSERT INTO reading_operations VALUES (?,?,?,?,?,?)')
    .bind(id, 'reader', id === current ? 'policy' : 'previous-policy', 'hash', JSON.stringify({ saved: true }), day)));
  await convertReceipts(h, 'reading', [current, previous].map(id => ({ id, vault: `${id}.key.iv.cipher.tag` })));
  expect(await receiptEnvelope(h, `operationId=${current}`)).toBe(`${current}.key.iv.cipher.tag`);
  expect(await receiptEnvelope(h, `operationId=${previous}`)).toBeNull();
  // Reading semantic receipts are not in the shared wire ledger.
  expect(await receiptEnvelope(h, `operationId=${current}&wire=1`)).toBeNull();
});
