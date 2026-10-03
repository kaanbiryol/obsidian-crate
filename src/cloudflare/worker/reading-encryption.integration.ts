import { WorkerApiHttpClient } from '@/sync/worker-api/http';
import { convertEncryptedVault } from '@/sync/encryption-conversion';
import { handleEncryptionRoute } from './routes/encryption';
/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, moveEncryptionScopes, sealRecoveryBundle } from '@/encryption/key-bundle';
import { recoverCaptureReceipt, type CaptureRecoveryReceipt } from '@/reading/capture-recovery-receipt';
import type { CaptureRecord } from '@/reading/data/capture-outbox';
import { createEncryptionState } from '@/encryption/server-state';
import { FileKeyAuthority } from '@/encryption/file-authority';
import { EncryptedReadingApi } from '@/reading/encrypted-api';
import { createReadingNote } from '@/reading/core/notes';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { openFile, sealFile } from '@/encryption/file-codec';
import { handleEncryptionConversion } from './encryption-conversion';
import { publishCapture } from './reading/captures';
import { handleReadingRoute } from './reading/routes';
import { encryptJson } from '@/encryption/envelope';
import type { CapturedArticle } from '@/reading/extraction/types';
import type { ReadingItem } from '@/reading/core/model';

beforeEach(async () => { for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run(); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
const operation = () => createReminderOperationId(Math.floor(Date.now() / 86400_000));
async function setup(mode: 'active' | 'converting' = 'active', readingScope = true) {
  const base = addReminderScope(createVaultKeyBundle(), 'Reminders');
  const bundle = readingScope ? addReminderScope(base, 'Reading', 'reading') : base;
  const keys = await FileKeyAuthority.fromVault(bundle);
  const recovery = await generateRecoveryCode();
  const state = { ...createEncryptionState(bundle, await sealRecoveryBundle(bundle, recovery)), mode };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO maintenance_state(key,value) VALUES (?,?)').bind('e2ee:state', JSON.stringify(state)),
    env.DB.prepare("INSERT INTO reading_policy(id,enabled,folder_path,generation,revision) VALUES (1,1,'Reading','policy','revision')"),
    env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope,folder_path,reading_generation) VALUES ('reader',?,'reading','Reading','policy')").bind(await sha256Hex('reader-token')),
  ]);
  const headers = { Authorization: 'Bearer reader-token', 'X-Crate-Protocol': '2', 'X-Crate-Encryption-Vault': state.vaultId, 'X-Crate-Encryption-Generation': String(state.generation) };
  const request = (path: string, body?: string) => worker.fetch(new Request('https://test' + path, { method: body ? 'POST' : 'GET', headers, body }), env);
  const attempts = new Map<string, unknown>(), requests: string[] = [];
  let loseReply = false;
  const api = (captureArticle?: (url: string) => Promise<CapturedArticle>) => new EncryptedReadingApi({ captureArticle, folderPath: 'Reading', generation: bundle.generation, authority: keys.forPath('Reading/receipt.md'),
    request: async (path, body) => { if (body) requests.push(body); const response = await request(path, body); if (loseReply && path.endsWith('encrypted-commit') && response.ok) { loseReply = false; throw new Error('Lost reply'); } return response; },
    readAttempt: id => Promise.resolve(attempts.get(id)), writeAttempt: (id, value) => { attempts.set(id, value); return Promise.resolve(); },
    error: (message, status) => new Error(`${status}: ${message}`),
  });
  return { bundle, recovery, keys, state, headers, request, api, attempts, requests, loseNextReply: () => { loseReply = true; } };
}
it('authenticates exact capture receipts before and after folder conversion using vault-only reads', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const h = await setup(), id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,scope) VALUES ('owner',?,'vault')").bind(await sha256Hex('owner-token')).run();
  const body = { captureId: id, operationId: operation(), url: 'https://private.example/queued', fetchArticle: true as const, destinationFolder: 'Reading' };
  const record: CaptureRecord = { version: 1, authority: 'local', folder: 'Reading', body, note: createReadingNote({ id, url: body.url, savedAt: new Date().toISOString() }) };
  h.loseNextReply(); await expect(h.api().request('/reading/capture', JSON.stringify(body))).rejects.toThrow('Lost reply');
  const path = `/encryption/capture-recovery?operationId=${body.operationId}`;
  expect((await h.request(path)).status).toBe(403);
  const http = new WorkerApiHttpClient('https://test', 'owner-token', async input => {
    const response = await worker.fetch(new Request(input.url, { method: input.method, body: input.body, headers: { ...input.headers, ...(input.contentType ? { 'Content-Type': input.contentType } : {}) } }), env);
    const bytes = await response.arrayBuffer(); return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: bytes, text: new TextDecoder().decode(bytes) };
  });
  const attempt = h.attempts.get(body.operationId) as { requestHash: string; body: string };
  const before = await http.requestJson<CaptureRecoveryReceipt>(path);
  expect(await recoverCaptureReceipt(record, before, h.bundle, attempt)).toBe(id);
  const moved = moveEncryptionScopes(h.bundle, 'Reading', 'Articles');
  await convertEncryptedVault(http, moved, h.recovery, () => {});
  const after = await http.requestJson<CaptureRecoveryReceipt>(path);
  expect(after.receipts[0]?.envelope).toBeTruthy();
  expect(await recoverCaptureReceipt(record, after, moved, attempt)).toBe(id);
  expect(await recoverCaptureReceipt(record, after, moved)).toBe(id);
  await expect(recoverCaptureReceipt({ ...record, body: { ...body, url: 'https://other.example' } }, after, moved, attempt)).rejects.toThrow('does not match');
  await expect(recoverCaptureReceipt(record, after, moved, { ...attempt, body: attempt.body.replace('Reading', 'Articles') })).rejects.toThrow('does not match');
  const expired = await http.requestJson<CaptureRecoveryReceipt>(`/encryption/capture-recovery?operationId=${createReminderOperationId(1)}`);
  expect(expired).toEqual({ receipts: [], retryValid: false });
  await expect(recoverCaptureReceipt(record, expired, moved)).rejects.toThrow('too old');
  expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_operations').first<{ count: number }>())?.count).toBe(1);
});
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
  const file = await env.DB.prepare('SELECT path,storage_key FROM files').first<{ path: string; storage_key: string }>();
  const bytes = new Uint8Array(await (await env.BUCKET.get(file!.storage_key))!.arrayBuffer());
  expect(new TextDecoder().decode(bytes)).not.toContain('confidential-article');
  expect(new TextDecoder().decode((await openFile(bytes, file!.path, h.keys.forPath(file!.path))).content)).toContain('favorite: true');
  expect((await env.DB.prepare('SELECT * FROM reading_sources').all()).results).toHaveLength(0);
  expect((await env.DB.prepare('SELECT * FROM reading_jobs').all()).results).toHaveLength(0);
});
it('allows scoped encryption discovery but rejects plaintext saves and sibling-folder access', async () => {
  const h = await setup();
  const response = await worker.fetch(new Request('https://test/reading/encryption', { headers: { Authorization: 'Bearer reader-token', 'X-Crate-Protocol': '2' } }), env);
  expect(response.status).toBe(200); const metadata = await response.text(); expect(metadata).not.toContain(h.bundle.vault.id); expect(metadata).not.toContain(h.bundle.vault.secret);
  expect(JSON.parse(metadata)).toMatchObject({ encryption: { recovery: h.state.recovery } });
  expect((await h.request('/sync/manifest')).status).toBe(403);
  expect((await h.request('/settings')).status).toBe(403);
  expect((await h.request('/reading/capture', JSON.stringify({ operationId: operation(), url: 'https://private.example' }))).status).toBe(428);
  expect((await h.request('/reading/encrypted-files?folderPath=Reminders')).status).toBe(403);
  expect((await h.request('/reminders/encrypted-files?folderPath=Reminders')).status).toBe(403);
  const manifest = await worker.fetch(new Request('https://test/notifications/manifest.json'), env);
  expect(await manifest.text()).not.toContain('share_target');
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

it.each(['active', 'converting'] as const)('blocks legacy and versioned Shortcut preparation before parsing private content while %s', async mode => {
  await setup(mode);
  for (const path of ['/reading/prepare', '/reading/shortcut/v1/prepare']) {
    const request = new Request('https://test' + path, {
      method: 'POST', headers: { 'X-Crate-Shortcut-Revision': '2' }, body: 'unparsed private content',
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
  const scope = h.bundle.scopes.find(scope => scope.purpose === 'reading')!;
  const context = { vaultId: h.bundle.vaultId, scopeId: scope.id, objectId: id, purpose: 'reminder' as const };
  const value = { requestHash, response };
  const converted = await handleEncryptionConversion(new Request('https://test/encryption/conversion/receipt', { method: 'PUT', headers: h.headers,
    body: JSON.stringify({ kind: 'reading', operationId: id, vault: await encryptJson(value, h.keys.forVaultMetadata().key, { ...context, scopeId: 'vault' }),
      scopes: [{ id: scope.id, envelope: await encryptJson(value, h.keys.forPath('Reading/receipt.md').key, context) }] }) }), env, '/encryption/conversion/receipt');
  expect(converted?.status, await converted?.clone().text()).toBe(200);
  await env.DB.prepare("UPDATE maintenance_state SET value=? WHERE key='e2ee:state'").bind(JSON.stringify({ ...h.state, mode: 'active' })).run();
  expect(await h.api().request('/reading/capture', JSON.stringify(body))).toEqual(response);
  expect(h.requests).toHaveLength(0);
  expect(await env.DB.prepare('SELECT 1 FROM files').first()).toBeNull();
  expect(JSON.stringify((await env.DB.prepare('SELECT * FROM reading_operations').all()).results)).not.toContain(requestHash);
});

it('adds a Reading scope to an already encrypted vault and resumes a lost conversion response', async () => {
  vi.stubGlobal('window', globalThis);
  const h = await setup('active', false), path = 'Reading/Article.md';
  const content = new TextEncoder().encode(createReadingNote({ id: crypto.randomUUID(), url: 'https://private.example/upgraded', savedAt: new Date().toISOString() }));
  const old = await sealFile({ path, content, contentType: 'text/markdown', publicData: null }, h.keys.forPath(path));
  await env.BUCKET.put('__crate__/files/old-reading', old.bytes, { httpMetadata: { contentType: 'application/vnd.crate.encrypted-file' }, customMetadata: { hash: old.hash } });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO files(path,portable_path,hash,size,storage_key) VALUES (?,?,?,?,?)').bind(path, path.toLowerCase(), old.hash, old.bytes.length, '__crate__/files/old-reading'),
    env.DB.prepare('INSERT INTO maintenance_state(key,value) VALUES (?,?)').bind('e2ee:file:__crate__/files/old-reading', JSON.stringify(old.descriptor)),
  ]);
  const bundle = addReminderScope(h.bundle, 'Reading', 'reading'), recovery = await generateRecoveryCode();
  let lose = true;
  const http = new WorkerApiHttpClient('https://test', 'root', async input => {
    const request = new Request(input.url, { method: input.method, body: input.body, headers: { ...input.headers, 'Content-Type': input.contentType ?? 'application/json' } });
    const path = new URL(input.url).pathname;
    const response = path === '/.well-known/crate' ? await worker.fetch(request, env) : path === '/encryption' ? await handleEncryptionRoute(request, env.DB, path, { tokenId: 'root', scope: 'vault' }) : await handleEncryptionConversion(request, env, path);
    if (!response) throw new Error(`Unexpected conversion route: ${path}`);
    const bytes = await response.arrayBuffer();
    if (lose && path === '/encryption/conversion/file' && input.method === 'PUT') { lose = false; throw new Error('Lost conversion reply'); }
    return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: bytes, text: new TextDecoder().decode(bytes) };
  });
  await expect(convertEncryptedVault(http, bundle, recovery, () => {})).rejects.toThrow('Lost conversion reply');
  await convertEncryptedVault(http, bundle, recovery, () => {});
  const converted = new Uint8Array(await (await env.BUCKET.get('__crate__/files/old-reading'))!.arrayBuffer());
  const keys = await FileKeyAuthority.fromVault(bundle);
  expect((await openFile(converted, path, keys.forPath(path))).content).toEqual(content);
  await expect(openFile(converted, path, h.keys.forPath(path))).rejects.toThrow();
  expect(await env.DB.prepare("SELECT 1 FROM maintenance_state WHERE key LIKE 'e2ee:prior-file:%'").first()).toBeNull();
});
