import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PendingReading, ReadingSession } from './storage';
import { drainReading, queueReading } from './api';
import { pendingReading, writeValue } from './storage';

const storage = vi.hoisted(() => ({ values: new Map<string, unknown>(), current: true }));
vi.mock('./storage', () => ({
	READING_SESSION_KEY: 'reading-session',
	assertReadingSession: () => { if (!storage.current) throw new Error('Reading sign-in changed.'); },
	readingLock: async <T>(action: () => Promise<T>) => action(),
	readingDrainLock: async <T>(action: () => Promise<T>) => action(),
	pendingReading: async (session: ReadingSession) => structuredClone(storage.values.get(`pending:${session.id}`) ?? []) as PendingReading[],
	writeValue: vi.fn(async (key: string, value: unknown) => { storage.values.set(key, structuredClone(value)); }),
	readingDatabase: async () => ({ transaction: () => ({ store: { getAllKeys: async () => [] }, done: Promise.resolve() }) }),
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
	vi.mocked(writeValue).mockClear();
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('fetch', network);
	network.mockReset().mockImplementation(async path => {
		if (path === '/reading/session') return response({ day: 20_000, generation: session.generation });
		if (path === '/reading/list') return response({ items: [], issues: [], cursor: null });
		return response({ saved: true });
	});
});
afterEach(() => vi.unstubAllGlobals());

it('persists and returns local changes without making a network request', async () => {
	const work = await queueReading(session, 'capture', { url: 'https://example.com/article', title: 'Article' });
	expect(work[0]?.action).toBe('capture');
	expect(typeof work[0]?.queuedAt).toBe('string');
	expect(await pendingReading(session)).toEqual(work);
	expect(network).not.toHaveBeenCalled();
});

it('keeps dispatched bytes immutable and sends subsequent edits in order', async () => {
	await queueReading(session, 'update', { id: 'article', changes: { favorite: true }, before: { favorite: false } });
	const started = deferred<void>(), release = deferred<Response>();
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(() => { started.resolve(); return release.promise; });
	const draining = drainReading(session);
	await started.promise;
	const [original] = await pendingReading(session);
	await queueReading(session, 'update', { id: 'article', changes: { favorite: false }, before: { favorite: true } });
	const work = await queueReading(session, 'update', { id: 'article', changes: { tags: ['essays'] }, before: { tags: [] } });
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
	await queueReading(session, 'update', { id: 'article', changes: { favorite: true }, before: { favorite: false } });
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(async () => response({ error: 'Reply lost' }, 503));
	await drainReading(session);
	const [original] = await pendingReading(session);
	expect(original).toMatchObject({ error: 'Reply lost', review: false, attempts: 1 });
	expect(original!.retryAt).toBeGreaterThan(Date.now());
	await queueReading(session, 'update', { id: 'article', changes: { favorite: false }, before: { favorite: true } });
	await drainReading(session);
	const bodies = network.mock.calls.filter(([path]) => path === '/reading/update').map(([, init]) => init?.body);
	expect(bodies).toHaveLength(3);
	expect(bodies[0]).toBe(original?.body);
	expect(bodies[1]).toBe(original?.body);
	expect(bodies[2]).not.toBe(original?.body);
});

it('retains rejected edits and their dependents for review without sending dependents', async () => {
	await queueReading(session, 'update', { id: 'article', changes: { favorite: true }, before: { favorite: false } });
	const started = deferred<void>(), release = deferred<Response>();
	network.mockImplementationOnce(async () => response({ day: 20_000, generation: session.generation }))
		.mockImplementationOnce(() => { started.resolve(); return release.promise; });
	const draining = drainReading(session); await started.promise;
	await queueReading(session, 'update', { id: 'article', changes: { tags: ['essays'] }, before: { tags: [] } });
	await queueReading(session, 'update', { id: 'other', changes: { favorite: true }, before: { favorite: false } });
	release.resolve(response({ error: 'Changed on another device' }, 409)); await draining;
	const work = await pendingReading(session);
	expect(work.map(op => op.review)).toEqual([true, true, undefined]);
	expect(work[0]?.retryAt).toBeUndefined();
	await expect(queueReading(session, 'update', { id: 'article', changes: { favorite: false }, before: { favorite: true } })).rejects.toThrow('Review');
	await drainReading(session);
	const sent = network.mock.calls.filter(([path]) => path === '/reading/update').map(([, init]) => JSON.parse(init!.body as string) as { id: string });
	expect(sent.map(op => op.id)).toEqual(['article', 'other']);
	expect(await pendingReading(session)).toHaveLength(2);
});

it('rejects stale peer edits and failed persistence before accepting work', async () => {
	await queueReading(session, 'update', { id: 'article', changes: { favorite: true }, before: { favorite: false } });
	await expect(queueReading(session, 'update', { id: 'article', changes: { favorite: true }, before: { favorite: false } })).rejects.toThrow('another tab');
	vi.mocked(writeValue).mockRejectedValueOnce(new Error('Storage full'));
	await expect(queueReading(session, 'capture', { url: 'https://example.com/article' })).rejects.toThrow('Storage full');
	expect(await pendingReading(session)).toHaveLength(1);
	expect(network).not.toHaveBeenCalled();
	storage.current = false;
	await expect(queueReading(session, 'capture', { url: 'https://example.com/other' })).rejects.toThrow('sign-in changed');
});
