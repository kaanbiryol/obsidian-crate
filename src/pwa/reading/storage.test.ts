import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { drainReading } from './api';
import { exportReadingData, pendingReading, readReadingCache, readReadingDraft, readingSession, READING_SESSION_KEY, type ReadingSession } from './storage';
import { isPendingReading, isReadingCache, isReadingSession } from './storage-validation';

const values = vi.hoisted(() => new Map<string, unknown>());
const download = vi.hoisted(() => vi.fn());
vi.mock('../download', () => ({ downloadJson: download }));
vi.mock('idb', () => ({ openDB: async () => ({
  get: async (_store: string, key: string) => values.get(key),
  getAllKeys: async () => [...values.keys()],
  transaction: () => ({ store: { getAllKeys: async () => [...values.keys()], get: async (key: string) => values.get(key) } }),
}) }));
const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const intent = { id: 'article', changes: { highlights: [] }, before: { highlights: undefined } };
const command = () => ({ id: 'queued', sessionId: session.id, action: 'update', intent: structuredClone(intent),
  body: JSON.stringify({ ...intent, operationId: createReminderOperationId(20_000) }, null, 2), queuedAt: '2026-09-20T10:00:00Z' });
beforeEach(() => {
  values.clear(); download.mockClear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(session) : null });
  vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_name: string, action: () => Promise<unknown>) => action() } });
  vi.stubGlobal('location', { origin: 'https://crate.example' });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

it('retains the exact dispatched bytes and unknown metadata during validation', async () => {
  const saved = { ...command(), futureMetadata: { label: '保留' } };
  values.set(`pending:${session.id}`, [saved]);
  const [loaded] = await pendingReading(session);
  expect(loaded).toBe(saved);
  expect(loaded?.body).toBe(saved.body);
  expect(isPendingReading({ ...saved, body: undefined }, session.id)).toBe(true);
});

it.each([
  null,
  { ...command(), intent: [] },
  { ...command(), intent: { ...intent, changes: { favorite: 'yes' } } },
  { ...command(), attempts: -1 },
  { ...command(), retryAt: 'soon' },
  { ...command(), review: 'false' },
  { ...command(), body: '{broken' },
  { ...command(), body: JSON.stringify({ ...intent, id: 'another', operationId: createReminderOperationId(20_000) }) },
  { ...command(), body: JSON.stringify({ ...intent, operationId: 'broken' }) },
  { ...command(), sessionId: 'other' },
])('preserves damaged commands for export and never dispatches them (%j)', async damaged => {
  const original = [damaged];
  values.set(`pending:${session.id}`, original);
  await expect(drainReading(session)).rejects.toThrow('Pending Reading changes could not be read');
  expect(fetch).not.toHaveBeenCalled();
  expect(values.get(`pending:${session.id}`)).toBe(original);
  await exportReadingData();
  expect(download).toHaveBeenCalledWith('crate-reading-recovery.json', { format: 1, origin: 'https://crate.example', data: { [`pending:${session.id}`]: original } });
});

it('rejects duplicate identities and null queues without interpreting them as empty', async () => {
  for (const invalid of [null, [command(), command()]]) {
    values.set(`pending:${session.id}`, invalid);
    await expect(pendingReading(session)).rejects.toThrow('Pending Reading changes');
    expect(values.get(`pending:${session.id}`)).toBe(invalid);
  }
});

it('validates session fields without removing an unreadable sign-in', () => {
  expect(isReadingSession(session)).toBe(true);
  for (const token of [1, {}, null]) expect(isReadingSession({ ...session, token })).toBe(false);
  vi.stubGlobal('localStorage', { getItem: () => 'null' });
  expect(readingSession).toThrow('Reading sign-in could not be read');
});

it('rejects malformed cache envelopes and drafts without overwriting either', async () => {
  const cache = { items: [], issues: [{ path: 'Reading/x.md', message: 123 }], savedAt: 1 };
  values.set(`list:${session.id}`, cache);
  values.set(`draft:${session.id}`, { url: { private: 'saved text' } });
  await expect(readReadingCache(session)).rejects.toThrow('saved Reading library');
  await expect(readReadingDraft(`draft:${session.id}`)).rejects.toThrow('saved Reading draft');
  expect(values.get(`list:${session.id}`)).toBe(cache);
  expect(values.get(`draft:${session.id}`)).toEqual({ url: { private: 'saved text' } });
  expect(isReadingCache({ items: [], issues: [], savedAt: 1 }, 'Reading')).toBe(true);
});
