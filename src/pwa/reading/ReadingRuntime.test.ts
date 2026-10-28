import { act, createElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { SettingsContext } from '../settings/settings-context';
import { createSettingsStore } from '../settings/settings-store';
import { pwaSyncState } from '../sync/state';
import { ReadingRuntimeProvider, useReadingRuntime } from './ReadingRuntime';
import { readReadingCache, readReadingDraft, readReadingShare, removeReadingShare, readingLock, saveReadingDraft, savePendingReading } from './storage/storage';
import { READING_SESSION_KEY, type ReadingSession } from './session/session';
import type { PendingReading, ReadingCommand } from './outbox';
import type { ReadingItem } from '@/reading/core/model';

vi.mock('../shared-features', () => ({ useSharedFeatures: () => ({ reading: true }) }));
vi.mock('../sync/SyncFeedback', () => ({ useSyncFeedback: () => showToast }));
vi.mock('../connection/AppConnection', () => ({
	useAppConnection: () => ({ reading: connection, logOut: vi.fn() }), useConnectionReset: vi.fn(),
}));
vi.mock('./useReadingSync', () => ({ useReadingSync: () => ({
	refresh: vi.fn(), refreshManually: vi.fn(), syncing: false, syncedSession: session, isOffline: false,
}) }));
vi.mock('./storage/storage', async importOriginal => ({
	...await importOriginal<typeof import('./storage/storage')>(),
	readReadingCache: vi.fn(async () => ({ items: [], issues: [], savedAt: 1 })),
	pendingReading: vi.fn(async () => []), readReadingDraft: vi.fn(async () => undefined),
	hasEarlierReadingChanges: vi.fn(async () => false), saveReadingDraft: vi.fn(async () => {}), savePendingReading: vi.fn(async () => {}),
	readReadingShare: vi.fn(async () => undefined), removeReadingShare: vi.fn(async () => {}),
	readingLock: vi.fn(),
}));

const session: ReadingSession = { id: 'reading', token: 'token', generation: 'one', folderPath: 'Reading', expiresAt: 1 };
const connection = { session, ready: true, connecting: false, lockedSession: null, connectionState: 'available', resetSession: vi.fn() };
const showToast = vi.fn();
const article: ReadingItem = { crate_reading_version: 1, crate_reading_id: '12345678-1234-4123-8123-123456789abc',
	title: 'An article', path: 'Reading/article.md', source_url: 'https://example.test/article',
	saved_at: '2026-10-01T12:00:00Z', reading_status: 'inbox', favorite: false, tags: [], extraction_status: 'ready' };
let currentSession: ReadingSession | null;
beforeEach(() => {
	vi.clearAllMocks(); currentSession = session; connection.connecting = false;
	vi.mocked(savePendingReading).mockReset().mockResolvedValue(undefined);
	vi.mocked(removeReadingShare).mockReset().mockResolvedValue(undefined);
	vi.mocked(readingLock).mockReset();
	vi.stubGlobal('localStorage', { getItem: (key: string) => key === READING_SESSION_KEY ? JSON.stringify(currentSession) : null });
	vi.stubGlobal('location', { href: 'https://example.test/notifications' });
	vi.stubGlobal('navigator', { onLine: true });
});

async function harness() {
	const store = createSettingsStore();
	store.setFeature('reminders', { ready: true, connected: true, updateReady: true, updateContentReady: true,
		canApplyUpdate: () => true, status: { state: 'synced', label: 'Synced' }, attention: null, unsynced: false,
		config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 },
		push: { phase: 'unsupported', status: null }, onRefresh: vi.fn(), onLogout: vi.fn(), onEnablePush: vi.fn(), recovery: null });
	const hook = renderHook(useReadingRuntime, undefined, children =>
		createElement(SettingsContext.Provider, { value: store }, createElement(ReadingRuntimeProvider, { children })));
	await act(async () => {}); // Let the real session hook hydrate the mocked storage.
	expect(pwaSyncState(store.getSnapshot()).canUpdate).toBe(true);
	let release!: () => void;
	const lock = new Promise<void>(resolve => { release = resolve; });
	vi.mocked(readingLock).mockImplementation(async action => { await lock; return action(); });
	return { hook, store, release };
}

const commands: ReadingCommand[] = [
	{ action: 'capture', intent: { url: 'https://example.test/article' } },
	{ action: 'update', intent: { id: 'article', before: { favorite: false }, changes: { favorite: true } } },
	{ action: 'retry', intent: { id: 'article' } },
];
it.each([
	{ reason: 'the retry budget is exhausted', attempts: 3 },
	{ reason: 'the change needs review', review: true, error: undefined },
	{ reason: 'automatic retry is unavailable', retryAt: undefined },
])('announces a failed change only when $reason', async ({ reason: _reason, ...terminal }) => {
	const h = await harness();
	const retryable: PendingReading = { ...commands[0]!, id: 'change', sessionId: session.id,
		error: 'Temporarily unavailable', attempts: 1, retryAt: Date.now() + 2_000 };
	act(() => { h.hook.current.connection.publishPending(session, [retryable]); });
	expect(showToast).not.toHaveBeenCalled();
	expect(h.store.getSnapshot().reading).toMatchObject({ retryAt: retryable.retryAt, status: { state: 'error' } });

	act(() => { h.hook.current.connection.publishPending(session, [{ ...retryable, ...terminal }]); });
	expect(h.store.getSnapshot().reading?.retryAt).toBe(Infinity);
	expect(showToast).toHaveBeenCalledExactlyOnceWith('error', 'Reading changes need attention. Review them in settings.');
	h.hook.rerender();
	expect(showToast).toHaveBeenCalledOnce();
});

it('reports only work that waits for the user as blocking a launch update', async () => {
	const h = await harness();
	const blocked = () => h.store.getSnapshot().reading?.updateBlocked;
	expect(blocked()).toBe(false);
	const change: PendingReading = { ...commands[1]!, id: 'change', sessionId: session.id };
	act(() => { h.hook.current.connection.publishPending(session, [change]); });
	expect(blocked()).toBe(false);
	act(() => { h.hook.current.connection.publishPending(session, [{ ...change, error: 'Temporarily unavailable', attempts: 1, retryAt: Date.now() + 2_000 }]); });
	expect(blocked()).toBe(false);
	act(() => { h.hook.current.connection.publishPending(session, [{ ...change, review: true }]); });
	expect(blocked()).toBe(true);
	act(() => { h.hook.current.connection.publishPending(session, []); });
	expect(blocked()).toBe(false);
	act(() => { h.hook.current.connection.openCapture(); });
	expect(blocked()).toBe(true);
	expect(pwaSyncState(h.store.getSnapshot())).toMatchObject({ updateBlocked: true, canUpdate: false });
});

it.each(commands)('blocks reload while a $action command waits for storage and then publishes its durable queue', async command => {
	const h = await harness();
	let pending!: ReturnType<typeof h.hook.current.queueChange>;
	act(() => {
		pending = h.hook.current.queueChange(command);
		expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
	});
	expect(h.store.getSnapshot().reading?.updateReady).toBe(false);
	expect(h.hook.current.connection.pending).toEqual([]);
	h.hook.rerender();
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
	await act(async () => { h.release(); await pending; });
	expect(savePendingReading).toHaveBeenCalledWith(session, [expect.objectContaining(command)]);
	expect(h.store.getSnapshot().reading).toMatchObject({ pendingCount: 1, unsynced: true });
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
});

it('keeps overlapping preparations blocked until both fail and allows retry after storage recovers', async () => {
	const h = await harness();
	let failFirst!: (cause: Error) => void;
	vi.mocked(readingLock).mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }));
	vi.mocked(savePendingReading).mockRejectedValueOnce(new Error('Storage full'));
	let first!: Promise<unknown>, second!: Promise<unknown>;
	act(() => {
		first = h.hook.current.queueChange(commands[0]!).catch(() => {});
		second = h.hook.current.queueChange(commands[1]!).catch(() => {});
	});
	await act(async () => { failFirst(new Error('Storage unavailable')); await first; });
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
	await act(async () => { h.release(); await second; });
	expect(showToast).toHaveBeenCalledTimes(2);
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(true);
	await act(async () => { await h.hook.current.queueChange(commands[0]!); });
	expect(h.store.getSnapshot().reading?.pendingCount).toBe(1);
});

it('does not publish a delayed command after logout and unmount', async () => {
	const h = await harness();
	let pending!: Promise<unknown>;
	act(() => { pending = h.hook.current.queueChange(commands[0]!).catch(() => {}); });
	currentSession = null; h.hook.unmount();
	vi.mocked(savePendingReading).mockClear();
	await act(async () => { h.release(); await pending; });
	expect(savePendingReading).not.toHaveBeenCalled();
	expect(showToast).not.toHaveBeenCalled();
	expect(h.store.getSnapshot().reading).toBeNull();
});

it('clears transient preparation after a failure during connection rehydration', async () => {
	const h = await harness();
	vi.mocked(savePendingReading).mockRejectedValueOnce(new Error('Storage unavailable'));
	let pending!: Promise<unknown>;
	act(() => { pending = h.hook.current.queueChange(commands[0]!).catch(() => {}); });
	connection.connecting = true; h.hook.rerender();
	expect(h.hook.current.connection.isCurrentSession(session)).toBe(false);
	await act(async () => { h.release(); await pending; });
	expect(showToast).not.toHaveBeenCalled();
	connection.connecting = false; h.hook.rerender();
	await act(async () => {});
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(true);
});

it('owns save preparation while storage is delayed and prevents duplicate captures', async () => {
	const h = await harness();
	await act(async () => h.hook.current.connection.setUrl(article.source_url));
	const open = vi.fn();
	let saved!: Promise<boolean>, repeated!: Promise<boolean>;
	act(() => {
		saved = h.hook.current.saveLink(open);
		repeated = h.hook.current.saveLink(open);
		expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
	});
	expect(await repeated).toBe(false);
	expect(h.hook.current.saving).toBe(true);
	await act(async () => { h.release(); expect(await saved).toBe(true); });
	expect(h.hook.current.connection.pending).toMatchObject([{ action: 'capture', intent: { url: article.source_url, fetchArticle: true } }]);
	expect(h.hook.current.connection.url).toBe('');
	expect(h.hook.current.saving).toBe(false);
	expect(open).not.toHaveBeenCalled();
	expect(showToast).toHaveBeenCalledWith('success', 'Link saved');
});

it.each([false, true])('opens an existing shared link and guards delayed completion (session replaced: %s)', async replaced => {
	vi.mocked(readReadingCache).mockResolvedValueOnce({ items: [article], issues: [], savedAt: 1 });
	vi.mocked(readReadingDraft).mockResolvedValueOnce(undefined);
	vi.mocked(readReadingShare).mockResolvedValueOnce({ url: `${article.source_url}#section` });
	vi.stubGlobal('location', { href: 'https://example.test/notifications?share=shared' });
	// This starts with an open capture, so update readiness is intentionally false.
	const hook = renderHook(useReadingRuntime, undefined, children => createElement(SettingsContext.Provider,
		{ value: createSettingsStore() }, createElement(ReadingRuntimeProvider, { children })));
	await act(async () => {});
	// The draft keeps the shared link, so its staged copy is removed at once.
	expect(saveReadingDraft).toHaveBeenCalledWith(session, { url: `${article.source_url}#section` });
	expect(removeReadingShare).toHaveBeenCalledWith(session, 'shared');
	const draftWrite = vi.mocked(saveReadingDraft).mock.calls.findIndex(([, draft]) => draft.url === `${article.source_url}#section`);
	expect(vi.mocked(saveReadingDraft).mock.invocationCallOrder[draftWrite]).toBeLessThan(vi.mocked(removeReadingShare).mock.invocationCallOrder[0]!);
	let release!: () => void;
	const opening = new Promise<void>(resolve => { release = resolve; });
	const open = vi.fn(async () => { await opening; });
	let saved!: Promise<boolean>;
	await act(async () => { saved = hook.current.saveLink(open); });
	expect(open).toHaveBeenCalledWith(article);
	expect(hook.current.saving).toBe(true);
	if (replaced) currentSession = null;
	await act(async () => {
		release();
		if (replaced) await expect(saved).rejects.toThrow('Reading sign-in');
		else expect(await saved).toBe(true);
	});
	expect(hook.current.connection.url).toBe(replaced ? `${article.source_url}#section` : '');
	if (replaced) expect(showToast).not.toHaveBeenCalled();
	else expect(showToast).toHaveBeenCalledWith('info', 'Opened your saved link');
	expect(removeReadingShare).toHaveBeenCalledOnce();
	expect(hook.current.connection.pending).toEqual([]);
});

