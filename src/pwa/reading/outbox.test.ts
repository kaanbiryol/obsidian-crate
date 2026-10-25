import type { PendingReading } from './outbox';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReadingSession } from './session/session';
import { drainReading, queueReading, removeReviewedReading } from './outbox';
import { pendingReading, savePendingReading } from './storage/storage';

const storage = vi.hoisted(() => ({ values: new Map<string, unknown>(), current: true }));
vi.mock('./session/encryption-session', () => ({ prepareReadingEncryption: vi.fn(async () => null), readingKeys: () => null, resetReadingEncryption: vi.fn(), readingEncryptionHeaders: () => ({}), onReadingEncryptionReset: vi.fn() }));
vi.mock('./session/session', () => ({
	READING_SESSION_KEY: 'reading-session',
	assertReadingSession: () => { if (!storage.current) throw new Error('Reading sign-in changed.'); },
}));
vi.mock('./storage/storage', () => ({
  pruneReadingAttempts: vi.fn(async () => {}),
	readingLock: async <T>(action: () => Promise<T>) => action(),
	readingDrainLock: async <T>(action: () => Promise<T>) => action(),
	pendingReading: async (session: ReadingSession) => structuredClone(storage.values.get(`pending:${session.id}`) ?? []) as PendingReading[],
	savePendingReading: vi.fn(async (session: ReadingSession, value: PendingReading[]) => { storage.values.set(`pending:${session.id}`, structuredClone(value)); }),
	commitReadingCache: async (_session: ReadingSession, cache: import('./storage/cache').ReadingCache) => cache,
}));
const session: ReadingSession = { id: 'session', token: 'token', generation: 'generation', folderPath: 'Reading', expiresAt: 1 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const network = vi.fn<typeof fetch>();
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
beforeEach(() => {
	storage.values.clear(); storage.current = true;
	vi.mocked(savePendingReading).mockClear();
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('fetch', network);
	network.mockReset().mockImplementation(async path => {
		if (path === '/reading/session') return response({ day: 20_000, generation: session.generation });
		if (path === '/reading/list') return response({ items: [], issues: [], cursor: null });
		return response({ saved: true });
	});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('persists and returns local changes without making a network request', async () => {
	const work = await queueReading(session, { action: 'capture', intent: { url: 'https://example.com/article', title: 'Article' } });
	expect(work[0]?.action).toBe('capture');
	expect(typeof work[0]?.queuedAt).toBe('string');
	expect(await pendingReading(session)).toEqual(work);
	expect(network).not.toHaveBeenCalled();
});

it('keeps dispatched bytes immutable and sends subsequent edits in order', async () => {
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } });
	const started = deferred<void>(), release = deferred<Response>();
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(() => { started.resolve(); return release.promise; });
	const draining = drainReading(session);
	await started.promise;
	const [original] = await pendingReading(session);
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: false }, before: { favorite: true } } });
	const work = await queueReading(session, { action: 'update', intent: { id: 'article', changes: { tags: ['essays'] }, before: { tags: [] } } });
	expect(work).toHaveLength(2);
	expect(work[0]?.body).toBe(original?.body);
	expect(work[1]?.intent).toEqual({ id: 'article', changes: { favorite: false, tags: ['essays'] }, before: { favorite: true, tags: [] } });
	release.resolve(response({ saved: true })); await draining;
	expect(await pendingReading(session)).toHaveLength(1);
	await drainReading(session);
	const requests = network.mock.calls.filter(([path]) => path === '/reading/update').map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);
	expect(requests).toHaveLength(2);
	expect(requests[0]?.changes).toEqual({ favorite: true });
	expect(requests[1]?.before).toEqual({ favorite: true, tags: [] });
	expect(requests[1]?.operationId).not.toBe(requests[0]?.operationId);
	expect(await pendingReading(session)).toEqual([]);
});

it('retries uncertain bytes before dispatching dependent edits', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } });
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(async () => response({ error: 'Reply lost' }, 503));
	await drainReading(session);
	const [original] = await pendingReading(session);
	expect(original).toMatchObject({ error: 'Reply lost', review: false, attempts: 1 });
	expect(original!.retryAt).toBeGreaterThan(Date.now());
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: false }, before: { favorite: true } } });
	await drainReading(session, 'manual');
	const bodies = network.mock.calls.filter(([path]) => path === '/reading/update').map(([, init]) => init?.body);
	expect(bodies).toHaveLength(3);
	expect(bodies[0]).toBe(original?.body);
	expect(bodies[1]).toBe(original?.body);
	expect(bodies[2]).not.toBe(original?.body);
});

it('removes a reviewed rejected edit and its dependents only while the export still matches', async () => {
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } });
	const started = deferred<void>(), release = deferred<Response>();
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(() => { started.resolve(); return release.promise; });
	const draining = drainReading(session); await started.promise;
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { tags: ['essays'] }, before: { tags: [] } } });
	await queueReading(session, { action: 'update', intent: { id: 'other', changes: { favorite: true }, before: { favorite: false } } });
	release.resolve(response({ error: 'Changed on another device' }, 409)); await draining;
	const [rejected] = await pendingReading(session);
	expect(await removeReviewedReading(session, rejected!.id, JSON.stringify({ ...rejected, error: 'stale' }))).toBeNull();
	expect(await pendingReading(session)).toHaveLength(3);
	const remaining = await removeReviewedReading(session, rejected!.id, JSON.stringify(rejected));
	expect(remaining?.map(op => op.action !== 'capture' && op.intent.id)).toEqual(['other']);
	expect(await pendingReading(session)).toEqual(remaining);
});

it('retains rejected edits and their dependents for review without sending dependents', async () => {
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } });
	await queueReading(session, { action: 'update', intent: { id: 'other', changes: { favorite: true }, before: { favorite: false } } });
	const started = deferred<void>(), release = deferred<Response>();
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(() => { started.resolve(); return release.promise; });
	const draining = drainReading(session); await started.promise;
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { tags: ['essays'] }, before: { tags: [] } } });
	release.resolve(response({ error: 'Changed on another device' }, 409)); await draining;
	const sent = () => network.mock.calls.filter(([path]) => path === '/reading/update').map(([, init]) => (JSON.parse(init!.body as string) as { id: string }).id);
	// The rejection does not hold back an independent article.
	expect(sent()).toEqual(['article', 'other']);
	const work = await pendingReading(session);
	expect(work.map(op => op.action !== 'capture' && [op.intent.id, op.review])).toEqual([['article', true], ['article', true]]);
	expect(work[0]?.retryAt).toBeUndefined();
	await expect(queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: false }, before: { favorite: true } } })).rejects.toThrow('Review');
	await drainReading(session);
	expect(sent()).toEqual(['article', 'other']);
	expect(await pendingReading(session)).toHaveLength(2);
});

it('stops sending after a failure that may affect every change', async () => {
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } });
	await queueReading(session, { action: 'update', intent: { id: 'other', changes: { favorite: true }, before: { favorite: false } } });
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(async () => response({ error: 'Unavailable' }, 503));
	await drainReading(session);
	expect(network.mock.calls.filter(([path]) => path === '/reading/update')).toHaveLength(1);
	expect((await pendingReading(session)).map(op => op.review)).toEqual([false, undefined]);
});

it('rejects stale peer edits and failed persistence before accepting work', async () => {
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } });
	await expect(queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } })).rejects.toThrow('another tab');
	vi.mocked(savePendingReading).mockRejectedValueOnce(new Error('Storage full'));
	await expect(queueReading(session, { action: 'capture', intent: { url: 'https://example.com/article' } })).rejects.toThrow('Storage full');
	expect(await pendingReading(session)).toHaveLength(1);
	expect(network).not.toHaveBeenCalled();
	storage.current = false;
	await expect(queueReading(session, { action: 'capture', intent: { url: 'https://example.com/other' } })).rejects.toThrow('sign-in changed');
});

it('honors retry deadlines and the durable attempt limit until an explicit retry', async () => {
	vi.useFakeTimers();
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } });
	network.mockImplementation(async path => path === '/reading/session'
		? response({ day: 20_000, generation: session.generation }) : response({ error: 'Unavailable' }, 503));
	await drainReading(session);
	const original = (await pendingReading(session))[0]!.body;
	for (const delay of [2_000, 4_000]) {
		const count = network.mock.calls.length;
		await drainReading(session);
		expect(network.mock.calls).toHaveLength(count);
		vi.advanceTimersByTime(delay);
		await drainReading(session);
	}
	expect((await pendingReading(session))[0]?.attempts).toBe(3);
	const count = network.mock.calls.length;
	vi.advanceTimersByTime(60_000);
	await drainReading(session);
	await drainReading(session);
	expect(network.mock.calls).toHaveLength(count);
	await drainReading(session, 'manual');
	const sent = network.mock.calls.filter(([path]) => path === '/reading/update');
	expect(sent).toHaveLength(4);
	expect(sent.every(([, init]) => init?.body === original)).toBe(true);
});

it('keeps paused predecessors ahead of dependent edits while sending independent work', async () => {
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } });
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(async () => response({ error: 'Reply lost' }, 503));
	await drainReading(session);
	const original = (await pendingReading(session))[0]!.body;
	await queueReading(session, { action: 'update', intent: { id: 'article', changes: { favorite: false }, before: { favorite: true } } });
	await queueReading(session, { action: 'update', intent: { id: 'other', changes: { favorite: true }, before: { favorite: false } } });
	await drainReading(session);
	const sent = () => network.mock.calls.filter(([path]) => path === '/reading/update').map(([, init]) => JSON.parse(init!.body as string) as { id: string });
	expect(sent().map(body => body.id)).toEqual(['article', 'other']);
	expect(await pendingReading(session)).toHaveLength(2);
	await drainReading(session, 'manual');
	expect(sent().map(body => body.id)).toEqual(['article', 'other', 'article', 'article']);
	expect(network.mock.calls.filter(([path]) => path === '/reading/update')[2]![1]?.body).toBe(original);
	expect(await pendingReading(session)).toEqual([]);
});

it('does not automatically retry permanent authorization failures or manually resend rejected changes', async () => {
	for (const status of [401, 403, 409]) {
		storage.values.clear(); network.mockClear();
		await queueReading(session, { action: 'capture', intent: { url: 'https://example.com/article' } });
		network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
			.mockImplementationOnce(async () => response({ error: 'Denied' }, status));
		await drainReading(session);
		const count = network.mock.calls.length;
		await drainReading(session);
		expect(network.mock.calls).toHaveLength(count);
		if (status === 409) {
			await drainReading(session, 'manual');
			expect(network.mock.calls).toHaveLength(count);
		}
	}
});

it('settles an in-flight receipt after pause without sending the remaining commands', async () => {
	await queueReading(session, { action: 'capture', intent: { url: 'https://example.com/first' } });
	await queueReading(session, { action: 'capture', intent: { url: 'https://example.com/second' } });
	const started = deferred<void>(), release = deferred<Response>();
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(() => { started.resolve(); return release.promise; });
	let enabled = true;
	const draining = drainReading(session, 'automatic', () => enabled);
	await started.promise; enabled = false;
	release.resolve(response({ saved: true })); await draining;
	expect(network.mock.calls.filter(([path]) => path === '/reading/capture')).toHaveLength(1);
	expect(await pendingReading(session)).toMatchObject([{ intent: { url: 'https://example.com/second' } }]);
});
