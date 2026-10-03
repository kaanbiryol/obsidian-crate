/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import worker from './index';
import { sha256Hex } from './auth';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, moveEncryptionScopes, openRecoveryBundle } from '../../encryption/key-bundle';
import { convertEncryptedVault, readServerEncryption } from '../../sync/encryption-conversion';
import { WorkerApiHttpClient, type ApiHttpTransport } from '../../sync/worker-api/http';
import { SyncApiClient } from '../../sync/api';
import { createReminderOperationId } from '../../protocol/reminder-operation';
import { FileKeyAuthority } from '../../encryption/file-authority';
import { SyncWorkerApi } from '../../sync/worker-api/sync';
import { EncryptedFiles } from '../../sync/encrypted-files';
import { arrayBufferToBase64 } from '../../sync/encoding';
import { computeHash } from '../../sync/hasher';
import type { JournalUpload } from '../../sync/upload-intent';
import type { RestoreIntent } from '../../sync/restore-intent';
import { openFile, sealFile } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { createReminderProjection } from '../../encryption/reminder-projection';
import { EncryptedReadingApi } from '../../reading/encrypted-api';
import { createReadingNote } from '../../reading/core/notes';


beforeEach(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,device_name,scope) VALUES ('owner',?,'Test','vault')").bind(await sha256Hex('owner-token')).run();
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

async function setup() {
  let lost = false;
  const transport: ApiHttpTransport = async input => {
    const response = await worker.fetch(new Request(input.url, { method: input.method, body: input.body,
      headers: { ...input.headers, ...(input.contentType ? { 'Content-Type': input.contentType } : {}) } }), env);
    const bytes = await response.arrayBuffer();
    if (lost && input.method === 'PUT' && input.url.includes('/conversion/file?') && response.ok) { lost = false; throw new Error('Lost conversion reply'); }
    return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer: bytes, text: new TextDecoder().decode(bytes) };
  };
  const http = new WorkerApiHttpClient('https://test', 'owner-token', transport);
  const keys = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Projects/Reminders'), 'Projects/Reading', 'reading');
  const recovery = await generateRecoveryCode();
  await convertEncryptedVault(http, keys, recovery, () => {});
  const api = new SyncApiClient('https://test', 'owner-token', transport); await api.configureEncryption(keys);
  const authority = await FileKeyAuthority.fromVault(keys);
  const upload = async (path: string, text: string, previous: string | null = null) => {
    const bytes = new TextEncoder().encode(text);
    const sealed = await sealFile({ path, content: bytes, contentType: 'text/markdown', publicData: await createReminderProjection(keys, path, bytes.buffer) }, authority.forPath(path));
    await api.uploadFile(path, sealed.bytes.buffer, sealed.hash, sealed.bytes.byteLength, ENCRYPTED_FILE_CONTENT_TYPE, previous, createReminderOperationId(Math.floor(Date.now() / 86400_000)));
    return sealed.hash;
  };
  return { http, api, keys, recovery, transport, upload, loseReply: () => { lost = true; } };
}

it('resumes a parent-folder scope move and preserves retained content, policies and unrelated objects', async () => {
  const h = await setup();
  const old = 'Projects/Reminders/Inbox.md', first = 'Private previous note', current = 'Private current note';
  const hash = await h.upload(old, first); await h.upload(old, current, hash);
  await h.upload('Elsewhere.md', 'Private unrelated content');
  // Content already in the destination must adopt its new folder key too.
  await h.upload('Personal/Reminders/Existing.md', 'Private destination content');
  const untouched = await h.api.getFileMetadata(['Elsewhere.md']);
  await env.DB.prepare("INSERT INTO notification_policy(id,folder_path,timezone,revision,enabled) VALUES (1,'Projects/Reminders','UTC','policy',1)").run();
  await env.DB.prepare("INSERT INTO reading_policy(id,folder_path,generation,revision,enabled) VALUES (1,'Projects/Reading','reading-generation','reading-policy',1)").run();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,device_name,scope,folder_path) VALUES ('old-web',?,'Old PWA','reminders','Projects/Reminders')").bind(await sha256Hex('old-browser')).run();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,device_name,scope,folder_path,reading_generation) VALUES ('reader',?,'Reader','reading','Projects/Reading','reading-generation')").bind(await sha256Hex('reader')).run();
  await env.DB.prepare("INSERT INTO push_subscriptions(id,owner_token_id,folder_path,endpoint,p256dh,auth) VALUES ('push','old-web','Projects/Reminders','https://push.example.test','key','auth')").run();
  const next = moveEncryptionScopes(h.keys, 'Projects', 'Personal');
  h.loseReply(); await expect(convertEncryptedVault(h.http, next, h.recovery, () => {})).rejects.toThrow('Lost conversion reply');
  const pending = await readServerEncryption(h.http); expect(pending?.mode).toBe('converting');
  expect(await openRecoveryBundle(pending!.recovery, h.recovery)).toEqual(next);
  await convertEncryptedVault(h.http, next, h.recovery, () => {});
  expect((await readServerEncryption(h.http))?.mode).toBe('active');
  await h.api.configureEncryption(next);
  expect(new TextDecoder().decode((await h.api.downloadFile(old)).content)).toBe(current);
  expect(new TextDecoder().decode((await h.api.downloadFile('Personal/Reminders/Existing.md')).content)).toBe('Private destination content');
  expect(await h.api.getFileMetadata(['Elsewhere.md'])).toEqual(untouched);
  const authority = await FileKeyAuthority.fromVault(next);
  const versions = await env.DB.prepare('SELECT storage_key FROM file_versions WHERE path=?').bind(old).all<{ storage_key: string }>();
  expect(versions.results.length).toBeGreaterThan(0);
  const history = await Promise.all(versions.results.map(async row => {
    const bytes = new Uint8Array(await (await env.BUCKET.get(row.storage_key))!.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain('Private');
    return new TextDecoder().decode((await openFile(bytes, old, authority.forPath(old))).content);
  }));
  expect(history).toContain(first);
  expect(await env.DB.prepare('SELECT folder_path FROM notification_policy').first()).toEqual({ folder_path: 'Personal/Reminders' });
  expect(await env.DB.prepare('SELECT folder_path FROM reading_policy').first()).toEqual({ folder_path: 'Personal/Reading' });
  expect(await env.DB.prepare("SELECT folder_path FROM auth_tokens WHERE id='old-web'").first()).toEqual({ folder_path: 'Personal/Reminders' });
  expect(await env.DB.prepare("SELECT folder_path,reading_generation FROM auth_tokens WHERE id='reader'").first()).toEqual({ folder_path: 'Personal/Reading', reading_generation: 'reading-generation' });
  expect(await env.DB.prepare('SELECT generation FROM reading_policy').first()).toEqual({ generation: 'reading-generation' });
  expect(await env.DB.prepare("SELECT folder_path,owner_token_id FROM push_subscriptions WHERE id='push'").first()).toEqual({ folder_path: 'Personal/Reminders', owner_token_id: 'old-web' });
  // Replaying the completed conversion does not advance the generation or wipe data.
  await convertEncryptedVault(h.http, next, h.recovery, () => {});
  expect((await h.api.getManifest()).files[old]).toBeDefined();
});

it('revokes sessions when choosing a different configured folder instead of moving it', async () => {
  const h = await setup();
  await env.DB.prepare("INSERT INTO reading_policy(id,folder_path,generation,revision,enabled) VALUES (1,'Projects/Reading','reading-generation','policy',1)").run();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,device_name,scope,folder_path,reading_generation) VALUES ('reader',?,'Reader','reading','Projects/Reading','reading-generation')").bind(await sha256Hex('reader')).run();
  const next = moveEncryptionScopes(h.keys, 'Projects/Reading', 'OtherReading', crypto.randomUUID());
  await convertEncryptedVault(h.http, next, h.recovery, () => {});
  expect(await env.DB.prepare("SELECT 1 FROM auth_tokens WHERE id='reader'").first()).toBeNull();
  expect((await env.DB.prepare('SELECT generation FROM reading_policy').first<{ generation: string }>())!.generation).not.toBe('reading-generation');
});

it('rejects stale concurrent folder changes and cannot turn a move into key rotation', async () => {
  const h = await setup();
  const first = moveEncryptionScopes(h.keys, 'Projects/Reading', 'Articles');
  await convertEncryptedVault(h.http, first, h.recovery, () => {});
  await expect(convertEncryptedVault(h.http, moveEncryptionScopes(h.keys, 'Projects/Reading', 'Another'), h.recovery, () => {})).rejects.toThrow('Recover');
  expect((await readServerEncryption(h.http))?.scopes.find(scope => scope.purpose === 'reading')?.folderPath).toBe('Articles');
  const rotated = { ...moveEncryptionScopes(first, 'Articles', 'Reading'), vault: createVaultKeyBundle().vault };
  await expect(convertEncryptedVault(h.http, rotated, h.recovery, () => {})).rejects.toThrow('Recover');
});

it('settles accepted uploads and restores from their original receipts after a folder move', async () => {
  const h = await setup();
  const oldEncryption = await EncryptedFiles.create(h.http, h.keys, (path, bytes) => createReminderProjection(h.keys, path, bytes));
  const transport = new SyncWorkerApi(h.http); transport.setEncryption(oldEncryption);
  const pending = async (path: string): Promise<JournalUpload> => {
    const bytes = new TextEncoder().encode('Private queued content').buffer;
    const file: JournalUpload = { path, content: arrayBufferToBase64(bytes), hash: await computeHash(bytes), size: bytes.byteLength,
      contentType: 'text/markdown', expectedHash: null, intent: { kind: 'local' }, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)),
      origin: { clientSession: crypto.randomUUID(), at: new Date().toISOString() } };
    file.encryptedWire = await oldEncryption.prepare(file); return file;
  };
  const accepted = await pending('Projects/Reminders/Accepted.md'), unsent = await pending('Projects/Reminders/Unsent.md');
  const wire = accepted.encryptedWire!;
  const response = await transport.uploadFile(accepted.path, Uint8Array.from(atob(wire.content), c => c.charCodeAt(0)).buffer,
    wire.hash, wire.size, wire.contentType, wire.expectedHash, accepted.operationId);
  const path = 'Projects/Reminders/History.md';
  const original = await h.upload(path, 'Private original'); await h.upload(path, 'Private replacement', original);
  const version = (await h.api.listFileVersions({ path })).versions[0]!;
  const current = (await h.api.getFileMetadata([path])).files[path]!;
  const restore: RestoreIntent = { phase: 'pending', version, request: { path, storageKey: version.storage_key,
    expectedHash: current.hash, expectedRevision: current.revision!, operationId: createReminderOperationId(Math.floor(Date.now() / 86400_000)) } };
  restore.encryptedWire = await oldEncryption.prepareRestore(restore);
  const restored = await transport.restoreFileVersion({ ...restore.request, expectedHash: restore.encryptedWire.expectedHash });
  const next = moveEncryptionScopes(h.keys, 'Projects', 'Personal');
  await convertEncryptedVault(h.http, next, h.recovery, () => {});
  transport.setEncryption(await EncryptedFiles.create(h.http, next, (path, bytes) => createReminderProjection(next, path, bytes)));
  expect(await transport.resolveLegacyUpload(accepted)).toEqual(response);
  expect(await transport.resolveLegacyUpload(unsent)).toMatchObject({ success: false, status: 409, code: 'version_conflict' });
  expect(await transport.resolveLegacyRestore(restore)).toEqual(restored);
  // Legacy journal records without generation still recover an accepted receipt.
  delete accepted.encryptedWire!.generation;
  expect(await transport.resolveLegacyUpload(accepted)).toEqual(response);
  expect(await env.DB.prepare('SELECT 1 FROM files WHERE path=?').bind(unsent.path).first()).toBeNull();
});

it.each(['before', 'after'] as const)('recovers a Reading edit interrupted %s commit across a folder move', async phase => {
  const h = await setup(), id = crypto.randomUUID(), old = 'Projects/Reading/Article.md', destination = 'Articles/Article.md';
  await env.DB.prepare("INSERT INTO reading_policy(id,folder_path,generation,revision,enabled) VALUES (1,'Projects/Reading','generation','policy',1)").run();
  await env.DB.prepare("INSERT INTO auth_tokens(id,token_hash,device_name,scope,folder_path,reading_generation) VALUES ('reader',?,'Reader','reading','Projects/Reading','generation')").bind(await sha256Hex('reader')).run();
  await h.upload(old, createReadingNote({ id, url: 'https://private.example/article', savedAt: new Date().toISOString() }));
  const attempts = new Map<string, unknown>();
  let interrupt = true, commits = 0;
  const client = async (bundle: typeof h.keys, folderPath: string) => new EncryptedReadingApi({
    folderPath, generation: bundle.generation, authority: (await FileKeyAuthority.fromVault(bundle)).forPath(folderPath + '/receipt.md'),
    request: async (path, body) => {
      const commit = path === '/reading/encrypted-commit';
      if (commit && interrupt && phase === 'before') { interrupt = false; throw new Error('Interrupted'); }
      const response = await worker.fetch(new Request('https://test' + path, { method: body ? 'POST' : 'GET', body, headers: {
        Authorization: 'Bearer reader', 'X-Crate-Protocol': '2', 'Content-Type': 'application/json',
        'X-Crate-Encryption-Vault': bundle.vaultId, 'X-Crate-Encryption-Generation': String(bundle.generation),
      } }), env);
      if (commit && response.ok) {
        commits++;
        if (interrupt) { interrupt = false; throw new Error('Interrupted'); }
      }
      return response;
    },
    readAttempt: async operation => attempts.get(operation), writeAttempt: async (operation, value) => { attempts.set(operation, value); },
    error: (message, status) => new Error(`${status}: ${message}`),
  });
  const operationId = createReminderOperationId(Math.floor(Date.now() / 86400_000));
  const body = JSON.stringify({ operationId, id, changes: { favorite: true }, before: { favorite: false } });
  await expect((await client(h.keys, 'Projects/Reading')).request('/reading/update', body)).rejects.toThrow('Interrupted');
  const next = moveEncryptionScopes(h.keys, 'Projects/Reading', 'Articles');
  await convertEncryptedVault(h.http, next, h.recovery, () => {});
  await h.api.configureEncryption(next);
  const previous = await h.api.downloadFile(old), authority = await FileKeyAuthority.fromVault(next);
  const sealed = await sealFile({ path: destination, content: new Uint8Array(previous.content), contentType: 'text/markdown', publicData: null }, authority.forPath(destination));
  await h.api.uploadFile(destination, sealed.bytes.buffer, sealed.hash, sealed.bytes.length, ENCRYPTED_FILE_CONTENT_TYPE, null, createReminderOperationId(Math.floor(Date.now() / 86400_000)));
  const metadata = (await h.api.getFileMetadata([old])).files[old]!;
  await h.api.deleteFile(old, metadata.hash, metadata.revision);
  expect(await (await client(next, 'Articles')).request('/reading/update', body)).toEqual({ saved: true, id });
  expect(commits).toBe(1);
  expect(new TextDecoder().decode((await h.api.downloadFile(destination)).content)).toContain('favorite: true');
  expect(await env.DB.prepare('SELECT count(*) AS total FROM reminder_operations WHERE operation_id=?').bind(operationId).first()).toEqual({ total: 1 });
});
