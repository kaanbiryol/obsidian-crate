import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addReminderScope, createVaultKeyBundle } from '@/encryption/key-bundle';
import { importEncryptionSecret } from '@/encryption/envelope';
import { importNotificationFingerprintKey } from '@/encryption/reminder-projection';
import { EncryptedReminderApi } from './encrypted-reminder-api';
import { invalidatePwaSession } from './session-generation';
import type { StoredReminderKeys } from './encryption-keys';
import { openFile, sealFile } from '@/encryption/file-codec';
import type { ReminderRecord } from './types';

const attempts = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./encrypted-reminder-attempts', () => ({
  loadEncryptedReminderAttempt: async (id: string) => attempts.get(id),
  saveEncryptedReminderAttempt: async (id: string, value: unknown) => { attempts.set(id, value); },
}));

let keys: StoredReminderKeys;
beforeEach(async () => {
  attempts.clear();
  vi.stubGlobal('localStorage', { getItem: () => 'session-token' });
  vi.stubGlobal('navigator', {});
  const bundle = addReminderScope(createVaultKeyBundle(), 'Reminders'), scope = bundle.scopes[0]!;
  keys = { version: 1, vaultId: bundle.vaultId, scopeId: scope.id, folderPath: scope.folderPath,
    generation: bundle.generation, data: await importEncryptionSecret(scope.data),
    notifications: await importEncryptionSecret(scope.notifications),
    notificationFingerprint: await importNotificationFingerprintKey(bundle.vaultId, scope), localState: 'unused' };
});
afterEach(() => vi.unstubAllGlobals());
const etag = (sequence: number) => `"e2ee-${keys.vaultId}-${keys.scopeId}-${keys.generation}-${sequence}"`;
const page = (sequence: number, nextCursor: string | null = null) => ({ files: [], sequence, generation: keys.generation, nextCursor });

it('checks only the first inventory page when a complete cached snapshot is unchanged', async () => {
  const fetch = vi.fn(async () => Response.json(page(7, 'Reminders/next.md')));
  const api = new EncryptedReminderApi(keys, fetch);
  const response = await api.handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(7) } });
  expect(response?.status).toBe(304);
  expect(response?.headers.get('ETag')).toBe(etag(7));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('still paginates and confirms the sequence when the cached snapshot is older', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json(page(8, 'Reminders/next.md')))
    .mockResolvedValueOnce(Response.json(page(8)))
    .mockResolvedValueOnce(Response.json(page(8)));
  const response = await new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(7) } });
  expect(response?.status).toBe(200);
  expect(response?.headers.get('ETag')).toBe(etag(8));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls[1]?.[0]).toContain('after=Reminders%2Fnext.md');
});

it('does not acknowledge an unchanged snapshot after the session changes', async () => {
  const fetch = vi.fn(async () => { invalidatePwaSession(); return Response.json(page(7)); });
  await expect(new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(7) } })).rejects.toThrow('Session changed');
});

it('validates encryption generation before using the unchanged-snapshot shortcut', async () => {
  const fetch = vi.fn(async () => Response.json({ ...page(7), generation: keys.generation + 1 }));
  await expect(new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(7) } })).rejects.toThrow('Invalid encrypted file inventory');
});

it('bounds empty advancing encrypted pages independently of the file budget', async () => {
  const fetch = vi.fn(async () => Response.json(page(7, `cursor-${String(fetch.mock.calls.length).padStart(5, '0')}`)));
  await expect(new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('limit');
  expect(fetch).toHaveBeenCalledTimes(1000);
});

it.each([['A', 'A'], ['A', 'B', 'A']])('rejects an encrypted cursor cycle: %j', async (...cursors) => {
  const fetch = vi.fn();
  for (const cursor of cursors) fetch.mockResolvedValueOnce(Response.json(page(7, cursor)));
  await expect(new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('did not advance');
  expect(fetch).toHaveBeenCalledTimes(cursors.length);
});

it('rejects a malformed later page before downloading any files', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(page(7, 'A')))
    .mockResolvedValueOnce(Response.json({ ...page(7), files: [null] }));
  await expect(new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('Invalid encrypted file');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects duplicate paths before downloading or projecting files', async () => {
  const file = { path: 'Reminders/Inbox.md', hash: 'a'.repeat(64), revision: 'first', size: 12 };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...page(7, 'A'), files: [file] }))
    .mockResolvedValueOnce(Response.json({ ...page(7), files: [file] }));
  await expect(new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('repeated a file');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects repeated paths before acknowledging an unchanged inventory', async () => {
  const file = { path: 'Reminders/Inbox.md', hash: 'a'.repeat(64), revision: 'first', size: 12 };
  const fetch = vi.fn(async () => Response.json({ ...page(7), files: [file, file] }));
  await expect(new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders', { headers: { 'If-None-Match': etag(7) } })).rejects.toThrow('repeated a file');
  expect(fetch).toHaveBeenCalledOnce();
});

it('retains bounded retries when a sequence changes between pages', async () => {
  const fetch = vi.fn();
  for (let attempt = 0; attempt < 3; attempt++) fetch.mockResolvedValueOnce(Response.json(page(7, 'A'))).mockResolvedValueOnce(Response.json(page(8)));
  await expect(new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('changed while loading');
  expect(fetch).toHaveBeenCalledTimes(6);
});

it('publishes decrypted cache entries only after the complete inventory is confirmed', async () => {
  const path = 'Reminders/Inbox.md', authority = { vaultId: keys.vaultId, scopeId: keys.scopeId, key: keys.data };
  const seal = (text: string) => sealFile({ path, content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: { version: 1, reminders: [] } }, authority);
  const original = await seal('- [ ] Original <!-- crate-id:task -->\n'), changed = await seal('- [ ] Changed <!-- crate-id:task -->\n');
  const inventory = (sealed: typeof original) => ({ ...page(7), files: [{ path, hash: sealed.hash, size: sealed.bytes.length, revision: sealed.hash }] });
  const fetch = vi.fn(async (route: string) => route.startsWith('/reminders/encrypted-file?') ? new Response(original.bytes) : Response.json(inventory(original)));
  const api = new EncryptedReminderApi(keys, fetch);
  await api.handle('/reminders/list?folderPath=Reminders');
  fetch.mockResolvedValueOnce(Response.json(inventory(changed))).mockResolvedValueOnce(new Response(changed.bytes))
    .mockResolvedValueOnce(Response.json({ ...page(7), nextCursor: {} }));
  await expect(api.handle('/reminders/list?folderPath=Reminders')).rejects.toThrow('Invalid encrypted file inventory');
  fetch.mockClear();
  const restored = await api.handle('/reminders/list?folderPath=Reminders');
  expect(await restored!.json()).toMatchObject({ reminders: [{ content: 'Original' }] });
  expect(fetch.mock.calls.every(([route]) => route.startsWith('/reminders/encrypted-files?'))).toBe(true);
  fetch.mockClear();
  fetch.mockImplementation(async route => route.startsWith('/reminders/encrypted-file?') ? new Response(changed.bytes) : Response.json(inventory(changed)));
  const refreshed = await api.handle('/reminders/list?folderPath=Reminders');
  expect(await refreshed!.json()).toMatchObject({ reminders: [{ content: 'Changed' }] });
  expect(fetch.mock.calls.filter(([route]) => route.startsWith('/reminders/encrypted-file?'))).toHaveLength(1);
});

it('preserves queued semantic revisions across a folder rename while committing to the new path', async () => {
  const text = '- [ ] Queued task <!-- crate-id:task -->\n';
  const authority = { vaultId: keys.vaultId, scopeId: keys.scopeId, key: keys.data };
  let livePath = 'Reminders/Inbox.md';
  let sealed = await sealFile({ path: livePath, content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: { version: 1, reminders: [] } }, authority);
  let generation = keys.generation;
  const commits: Array<{ files: Array<{ path: string; content: string }> }> = [];
  const fetch = async (path: string, init?: RequestInit) => {
    if (path.startsWith('/reminders/encrypted-files?')) return Response.json({ files: [{ path: livePath, hash: sealed.hash, size: sealed.bytes.length, revision: 'live' }], sequence: 1, generation, nextCursor: null });
    if (path.startsWith('/reminders/encrypted-file?')) return new Response(sealed.bytes);
    if (path.startsWith('/reminders/encrypted-receipt?')) return Response.json({ envelope: null });
    const body = JSON.parse(init!.body as string) as { acknowledgment: string; files: Array<{ path: string; content: string }> }; commits.push(body);
    return Response.json({ encrypted: body.acknowledgment });
  };
  const original = await (await new EncryptedReminderApi(keys, fetch).handle('/reminders/list?folderPath=Reminders'))!.json() as { reminders: ReminderRecord[] };
  const reminder = original.reminders[0]!;
  expect(reminder).toBeDefined();
  livePath = 'Work/Tasks/Inbox.md'; generation++;
  sealed = await sealFile({ path: livePath, content: new TextEncoder().encode(text), contentType: 'text/markdown', publicData: { version: 1, reminders: [] } }, authority);
  const moved = new EncryptedReminderApi({ ...keys, generation, folderPath: 'Work/Tasks', localFolderPath: 'Reminders' }, fetch);
  const listed = await (await moved.handle('/reminders/list?folderPath=Reminders'))!.json() as { reminders: ReminderRecord[] };
  expect(listed.reminders[0]!.revision).toBe(reminder.revision);
  const response = await moved.handle('/reminders/set-completed', { method: 'POST', body: JSON.stringify({
    operationId: crypto.randomUUID(), folderPath: 'Reminders', id: reminder.id, filePath: reminder.filePath,
    expectedRevision: reminder.revision, completed: true,
  }) });
  expect(response!.status).toBe(200);
  expect((await response!.json() as { reminder: ReminderRecord }).reminder.filePath).toBe('Reminders/Inbox.md');
  expect(commits).toHaveLength(1);
  expect(commits[0]!.files[0]!.path).toBe(livePath);
  const opened = await openFile(new TextEncoder().encode(commits[0]!.files[0]!.content), livePath, authority);
  expect(new TextDecoder().decode(opened.content)).toContain('- [x] Queued task');
});
