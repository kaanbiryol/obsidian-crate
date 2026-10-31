import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { drainReading } from '../outbox';
import { adoptEarlierReadingCaptures, earlierReadingChanges, exportReadingData, newestReadingShare, pendingReading, removeEarlierReadingChanges, readReadingCache, readReadingDraft, saveReadingDraft, savePendingReading, readReadingAttempt, writeReadingAttempt, removeReadingShare, readEncryptedReadingIndex, writeEncryptedReadingIndex } from './storage';
import { assertReadingSession, readingSession, READING_SESSION_KEY, type ReadingSession } from '../session/session';
import { createReadingNote, parseReadingNote } from '@/reading/core/notes';
import { isPendingReading, isReadingCache, isReadingSession } from './storage-validation';

const values = vi.hoisted(() => new Map<string, unknown>());
const download = vi.hoisted(() => vi.fn());
vi.mock('../../storage/download', () => ({ downloadJson: download }));
vi.mock('../../encryption/encryption-keys', () => ({ exportWrappedLocalKeys: async () => [] }));
vi.mock('../../storage/single-store-database', () => ({ openSingleStoreDatabase: async () => ({
	get: async (_store: string, key: string) => values.get(key),
	put: async (_store: string, value: unknown, key: string) => { values.set(key, value); },
	delete: async (_store: string, key: string) => { values.delete(key); },
	getAllKeys: async () => [...values.keys()],
	transaction: () => ({ store: { getAllKeys: async () => [...values.keys()], get: async (key: string) => values.get(key), delete: async (key: string) => { values.delete(key); },
		put: async (value: unknown, key: string) => { values.set(key, value); } }, done: Promise.resolve() }),
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

it('rejects stale folder authority even when the saved credential and generation are unchanged', () => {
	expect(() => assertReadingSession(session)).not.toThrow();
	vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify({ ...session, folderPath: 'Other reading' }) : null });
	expect(() => assertReadingSession(session)).toThrow('Reading sign-in changed');
});

it('retains the exact dispatched bytes and unknown metadata during validation', async () => {
	const saved = { ...command(), futureMetadata: { label: '保留' } };
	values.set(`pending:${session.id}`, [saved]);
	const [loaded] = await pendingReading(session);
	expect(loaded).toBe(saved);
	expect(loaded?.body).toBe(saved.body);
	expect(isPendingReading({ ...saved, body: undefined }, session.id)).toBe(true);
});

it('preserves durable draft, pending, and encrypted-attempt formats through typed writes', async () => {
	const pending = { ...command(), action: 'update' as const, futureMetadata: { label: '保留' } };
	const attempt = { requestHash: 'request-hash', body: '{\n  "ciphertext": "exact bytes"\n}', generation: 3 };
	await saveReadingDraft(session, { url: 'An unfinished draft' });
	await savePendingReading(session, [pending]);
	await writeReadingAttempt(session, 'operation', attempt);
	expect(values.get(`draft:${session.id}`)).toEqual({ url: 'An unfinished draft' });
	expect(values.get(`pending:${session.id}`)).toEqual([pending]);
	expect(values.get(`attempt:${session.id}:operation`)).toEqual(attempt);
	expect((await pendingReading(session))[0]?.body).toBe(pending.body);
	await expect(readReadingAttempt(session, 'operation')).resolves.toEqual(attempt);
});

it('rejects every typed write after the session changes without overwriting retained work', async () => {
	values.set(`draft:${session.id}`, { url: 'Saved draft' });
	values.set(`pending:${session.id}`, [command()]);
	values.set(`attempt:${session.id}:operation`, { body: 'Saved ciphertext' });
	values.set('share:shared', { url: 'Shared link' });
	const before = structuredClone(values);
	vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ ...session, generation: 'replacement' }) });
	for (const write of [
		() => saveReadingDraft(session, { url: 'Changed' }),
		() => savePendingReading(session, []),
		() => writeReadingAttempt(session, 'operation', { requestHash: 'changed', body: 'Changed' }),
		() => removeReadingShare(session, 'shared'),
	]) await expect(write()).rejects.toThrow('Reading sign-in changed');
	expect(values).toEqual(before);
});

it.each([
	null,
	{ ...command(), intent: [] },
	{ ...command(), intent: { ...intent, changes: { favorite: 'yes' } } },
	{ ...command(), intent: { ...intent, changes: { favorite: 'yes', tags: [42], reading_status: 'deleted' } } },
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
	expect(download).toHaveBeenCalledWith('crate-reading-recovery.json', { format: 1, origin: 'https://crate.example', data: { [`pending:${session.id}`]: original }, wrappedKeys: [], unreadable: [] });
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
	await expect(readReadingDraft(session)).rejects.toThrow('saved Reading draft');
	expect(values.get(`list:${session.id}`)).toBe(cache);
	expect(values.get(`draft:${session.id}`)).toEqual({ url: { private: 'saved text' } });
	expect(isReadingCache({ items: [], issues: [], savedAt: 1 }, 'Reading')).toBe(true);
});

it('reuses the encrypted Reading index only for the same encryption identity and valid entries', async () => {
	const item = parseReadingNote(createReadingNote({ id: '00000000-0000-4000-8000-000000000001', url: 'https://example.com/a', title: 'A', savedAt: '2026-10-01T12:00:00Z' }))!;
	// The plaintext hash lets a sealed note at a known server path be compared with the held one.
	const entry = { file: { path: 'Reading/A.md', hash: 'hash', size: 10, revision: 'r1' }, item: { ...item, path: 'Reading/A.md' }, hash: 'a'.repeat(64) };
	await writeEncryptedReadingIndex(session, 'identity-a', [entry]);
	await expect(readEncryptedReadingIndex(session, 'identity-a', 'Reading')).resolves.toEqual([entry]);
	await expect(readEncryptedReadingIndex(session, 'identity-b', 'Reading')).resolves.toBeUndefined();
	for (const hash of ['hash', undefined]) {
		await writeEncryptedReadingIndex(session, 'identity-a', [{ ...entry, hash } as never]);
		await expect(readEncryptedReadingIndex(session, 'identity-a', 'Reading')).resolves.toBeUndefined();
	}
	// Entries list server paths, but every note must belong to the plaintext Reading folder.
	await writeEncryptedReadingIndex(session, 'identity-a', [{ ...entry, item: { ...entry.item, path: 'Elsewhere/Other.md' } }]);
	await expect(readEncryptedReadingIndex(session, 'identity-a', 'Reading')).resolves.toBeUndefined();
	// No index can outgrow the library it describes.
	await writeEncryptedReadingIndex(session, 'identity-a', Array.from({ length: 10_001 }, () => entry));
	await expect(readEncryptedReadingIndex(session, 'identity-a', 'Reading')).resolves.toBeUndefined();
});

it('removes queues from earlier sign-ins only while they match the reviewed export', async () => {
	values.set('pending:earlier', [{ ...command(), sessionId: 'earlier' }]);
	values.set('attempt:earlier:operation', { requestHash: 'hash', body: '{}' });
	values.set(`pending:${session.id}`, [command()]);
	values.set(`attempt:${session.id}:operation`, { requestHash: 'hash', body: '{}' });
	const exported = JSON.stringify(await earlierReadingChanges(session.id));
	values.set('pending:older', []);
	expect(await removeEarlierReadingChanges(session.id, exported)).toBe(false);
	expect(values.has('pending:earlier')).toBe(true);
	expect(values.has('attempt:earlier:operation')).toBe(true);
	expect(await removeEarlierReadingChanges(session.id, JSON.stringify(await earlierReadingChanges(session.id)))).toBe(true);
	expect([...values.keys()]).toEqual([`pending:${session.id}`, `attempt:${session.id}:operation`]);
});

it('moves unsent captures of an earlier sign-in to the same folder into the current queue', async () => {
	const current: ReadingSession = { ...session, id: 'reminders:new-token:generation', source: 'reminders' };
	vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(current) : key === 'crate-reminders-auth-token' ? current.token : null });
	const earlier = 'reminders:old-token:generation';
	const unsent = { id: 'unsent', sessionId: earlier, action: 'capture', intent: { url: 'https://example.com/unsent' }, queuedAt: '2026-10-01T12:00:00Z' };
	const capture = { url: 'https://example.com/sent' };
	const sent = { id: 'sent', sessionId: earlier, action: 'capture', intent: capture, body: JSON.stringify({ ...capture, operationId: createReminderOperationId(20_000) }) };
	const edit = { ...command(), sessionId: earlier, body: undefined };
	values.set(`pending:${earlier}`, [unsent, sent, edit]);
	// Another folder generation and an only-unsent queue that empties.
	values.set('pending:reminders:old-token:other-generation', [{ ...unsent, sessionId: 'reminders:old-token:other-generation' }]);
	values.set('pending:reminders:older-token:generation', [{ ...unsent, id: 'unsent-2', sessionId: 'reminders:older-token:generation' }]);
	values.set(`pending:${current.id}`, [{ ...command(), sessionId: current.id }]);
	await adoptEarlierReadingCaptures(current);
	expect((await pendingReading(current)).map(op => op.id)).toEqual(['queued', 'unsent', 'unsent-2']);
	expect(values.get(`pending:${earlier}`)).toEqual([sent, edit]);
	expect(values.has('pending:reminders:older-token:generation')).toBe(false);
	expect(values.get('pending:reminders:old-token:other-generation')).toHaveLength(1);
});

it('finds the newest staged share for a page that lost its share parameter', async () => {
	values.set('share:older', { url: 'https://example.com/older', savedAt: 1 });
	values.set('share:newest', { url: 'https://example.com/newest', savedAt: 3 });
	values.set('share:damaged', { savedAt: 9 });
	values.set('share:middle', { url: 'https://example.com/middle', savedAt: 2 });
	await expect(newestReadingShare()).resolves.toEqual({ id: 'newest', url: 'https://example.com/newest' });
	await removeReadingShare(session, 'newest');
	await expect(newestReadingShare()).resolves.toEqual({ id: 'middle', url: 'https://example.com/middle' });
});

it('accepts delete commands only with the library fields they were based on', () => {
	const pending = (intent: unknown) => ({ id: 'operation', sessionId: session.id, action: 'delete', intent });
	expect(isPendingReading(pending({ id: 'article', before: { reading_status: 'inbox', favorite: false, tags: [] } }), session.id)).toBe(true);
	expect(isPendingReading(pending({ id: 'article', before: {} }), session.id)).toBe(false);
	expect(isPendingReading(pending({ id: 'article', before: { title: 'Other' } }), session.id)).toBe(false);
	expect(isPendingReading(pending({ id: 'article' }), session.id)).toBe(false);
});
