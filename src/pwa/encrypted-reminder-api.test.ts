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
