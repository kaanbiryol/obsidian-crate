import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useReminderSync } from './useReminderSync';
import { invalidatePwaSession } from '../session-generation';
import { loadCachedReminderSnapshot, saveCachedReminderSnapshot } from './cache/reminder-cache';
import type { ApiFetch } from '../types';
import type { ReminderRecord } from './types';
import { reminderSyncStatus } from '../sync/reminder-status';

vi.mock('./cache/reminder-cache', () => ({
	loadCachedReminderSnapshot: vi.fn(async () => null),
	refreshCachedReminderSnapshot: vi.fn(async () => {}),
	saveCachedReminderSnapshot: vi.fn(async () => {}),
}));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

function reminder(id: string, overrides: Partial<ReminderRecord> = {}): ReminderRecord {
	return { id, content: id, completed: false, priority: 4, revision: `${id}-original`,
		filePath: 'Reminders/Inbox.md', project: 'Inbox', ...overrides };
}
function response(reminders: ReminderRecord[], projects = ['Inbox']) {
	return new Response(JSON.stringify({ reminders, projects }), { headers: { ETag: 'latest-list' } });
}
function harness() {
	const requests: Array<{ resolve: (value: Response) => void }> = [];
	const options = {
		apiFetch: vi.fn<ApiFetch>(() => new Promise<Response>(resolve => { requests.push({ resolve }); })),
		authToken: 'token', authority: {}, bootstrapped: false, prepareSession: async () => {}, onSignedOut: vi.fn(),
		config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 }, setSelectedProject: vi.fn(),
	};
	const rendered = renderHook(() => useReminderSync(options));
	const original = reminder('one');
	act(() => rendered.current.hydrateCachedSnapshot({ folderPath: 'Reminders', reminders: [original], projects: ['Inbox'], savedAt: 1 }));
	const load = () => {
		let promise: Promise<void>;
		act(() => { promise = rendered.current.loadReminders({ silent: true }); });
		return promise!;
	};
	const settle = async (index: number, result: Response, pending: Promise<void>) => {
		await act(async () => { requests[index]!.resolve(result); await pending; });
	};
	const commit = (records: ReminderRecord[]) => act(() => rendered.current.commitReminderState(records));
	/** Answers a request with index progress, then waits out the one-second poll delay. */
	const warming = async (index: number, remainingFiles: number) => {
		await act(async () => {
			requests[index]!.resolve(new Response(JSON.stringify({ remainingFiles, totalFiles: 10 }), { status: 202 }));
			await vi.advanceTimersByTimeAsync(1_000);
		});
	};
	return { rendered, options, requests, original, load, settle, commit, warming };
}

describe('PWA reminder refresh around local writes', () => {
	it.each([200, 304])('keeps indexing progress out of recovery state until HTTP %s confirms the list', async status => {
		vi.useFakeTimers();
		const { rendered, original, requests, load, settle, warming } = harness();
		act(() => { window.dispatchEvent(new window.Event('online')); });
		const pending = load();
		await warming(0, 3);
		expect(requests).toHaveLength(2);
		expect(rendered.current.indexingProgress).toEqual({ indexedFiles: 7, totalFiles: 10 });
		expect(rendered.current.error).toBeNull();
		expect(reminderSyncStatus({ ...rendered.current, changes: [], storageError: null })).toEqual({
			state: 'syncing', label: 'Preparing reminders: 7 of 10 files indexed…',
		});
		await settle(1, status === 200 ? response([original]) : new Response(null, { status: 304 }), pending);
		expect(rendered.current.indexingProgress).toBeNull();
		expect(rendered.current.error).toBeNull();
		expect(reminderSyncStatus({ ...rendered.current, changes: [], storageError: null }).state).toBe('synced');
	});

	it('replaces indexing progress with attention only when the refresh fails', async () => {
		vi.useFakeTimers();
		const { rendered, load, settle, warming } = harness();
		const pending = load();
		await warming(0, 3);
		await settle(1, new Response('Index unavailable', { status: 503 }), pending);
		expect(rendered.current.indexingProgress).toBeNull();
		expect(rendered.current.error).toBe('Index unavailable');
		expect(reminderSyncStatus({ ...rendered.current, changes: [], storageError: null }).state).toBe('error');
	});

	it.each(['reset', 'replacement', 'mutation'] as const)('clears indexing progress on %s and ignores the old response', async change => {
		vi.useFakeTimers();
		const { rendered, options, load, settle, warming } = harness();
		const pending = load();
		await warming(0, 3);
		let finish: (() => void) | undefined;
		if (change === 'reset') {
			invalidatePwaSession();
			act(() => rendered.current.resetReminderState());
		} else if (change === 'replacement') {
			options.apiFetch = vi.fn(async () => response([]));
			rendered.rerender();
		} else act(() => { finish = rendered.current.beginLocalMutation(); });
		expect(rendered.current.indexingProgress).toBeNull();
		await warming(1, 1);
		expect(rendered.current.indexingProgress).toBeNull();
		await settle(2, response([]), pending);
		finish?.();
		expect(rendered.current.indexingProgress).toBeNull();
	});

	it.each([
		{}, { reminders: [] }, { projects: [] },
		{ reminders: [null], projects: ['Inbox'] },
		{ reminders: [reminder('one'), reminder('one')], projects: ['Inbox'] },
		{ reminders: [reminder('one', { filePath: 'Private/Inbox.md' })], projects: ['Inbox'] },
		{ reminders: [reminder('one', { dueDate: '2099-02-30' })], projects: ['Inbox'] },
		{ reminders: [reminder('one')], projects: [null] },
		{ reminders: [], projects: [], issues: 'invalid' },
	])('preserves the confirmed snapshot and ETag after an invalid list: %j', async invalid => {
		const { rendered, original, options, load, settle } = harness();
		await settle(0, response([original]), load());
		vi.mocked(saveCachedReminderSnapshot).mockClear();
		await settle(1, new Response(JSON.stringify(invalid), { headers: { ETag: 'invalid-list' } }), load());
		expect(rendered.current.getSnapshot()).toEqual({ reminders: [original], projects: ['Inbox'] });
		expect(rendered.current.error).toContain('invalid reminder data');
		expect(saveCachedReminderSnapshot).not.toHaveBeenCalled();
		expect(loadCachedReminderSnapshot).not.toHaveBeenCalled();
		const next = load();
		expect(new Headers(options.apiFetch.mock.calls.at(-1)?.[1]?.headers).get('If-None-Match')).toBe('latest-list');
		await settle(2, response([], []), next);
		expect(rendered.current.getSnapshot()).toEqual({ reminders: [], projects: [] });
		expect(rendered.current.error).toBeNull();
	});

	it('keeps malformed JSON out of a confirmed snapshot', async () => {
		const { rendered, original, load, settle } = harness();
		await settle(0, new Response('{'), load());
		expect(rendered.current.reminders).toEqual([original]);
		expect(rendered.current.error).toContain('invalid reminder data');
		expect(saveCachedReminderSnapshot).not.toHaveBeenCalled();
	});

	it('reports unavailable data when the first response is invalid', async () => {
		const { rendered, load, settle } = harness();
		act(() => rendered.current.resetReminderState());
		await settle(0, new Response('{}'), load());
		expect(rendered.current.dataMode).toBe('error');
		expect(rendered.current.lastUpdatedAt).toBeNull();
		expect(saveCachedReminderSnapshot).not.toHaveBeenCalled();
	});

	it('retains source issues through acknowledgements and 304 until a complete read repairs them', async () => {
		const { rendered, original, load, settle, commit } = harness();
		const issues = [{ path: 'Reminders/Large.md', reason: 'Source exceeds the reminder size limit' }];
		await settle(0, new Response(JSON.stringify({ reminders: [original], projects: ['Inbox'], issues })), load());
		expect(rendered.current.issues).toEqual(issues);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith({ folderPath: 'Reminders', reminders: [original], projects: ['Inbox'], savedAt: expect.any(Number) as number, etag: undefined, issues, deltaBase: undefined });
		const corrected = { ...original, content: 'Healthy reminder stays editable' };
		await commit([corrected]);
		expect(rendered.current.reminders).toEqual([corrected]);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith({ folderPath: 'Reminders', reminders: [corrected], projects: ['Inbox'], savedAt: expect.any(Number) as number, etag: undefined, issues, deltaBase: undefined });
		await settle(1, new Response(null, { status: 304 }), load());
		expect(rendered.current.issues).toEqual(issues);
		await settle(2, response([corrected]), load());
		expect(rendered.current.issues).toEqual([]);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith({ folderPath: 'Reminders', reminders: [corrected], projects: ['Inbox'], savedAt: expect.any(Number) as number, etag: 'latest-list', issues: [], deltaBase: undefined });
	});

	it('restores cached source issues after a network error and clears them on logout', async () => {
		const { rendered, original, load, settle } = harness();
		const issues = [{ path: 'Reminders/Copy.md', reason: 'Duplicate reminder ID' }];
		act(() => rendered.current.resetReminderState());
		vi.mocked(loadCachedReminderSnapshot).mockResolvedValueOnce({ folderPath: 'Reminders', reminders: [original], projects: ['Inbox'], savedAt: 123, issues });
		await settle(0, new Response('Offline', { status: 503 }), load());
		expect(rendered.current.reminders).toEqual([original]);
		expect(rendered.current.issues).toEqual(issues);
		expect(rendered.current.error).toBe('Offline');
		act(() => rendered.current.resetReminderState());
		expect(rendered.current.issues).toEqual([]);
		expect(rendered.current.hasHydratedCache()).toBe(false);
	});

	it.each([true, false])('starts a fresh read after a write (stale read finishes first=%s)', async staleFirst => {
		const { rendered, requests, original, load, settle, commit } = harness();
		const staleRead = load();
		expect(load()).toBe(staleRead);
		expect(requests).toHaveLength(1);
		const finish = rendered.current.beginLocalMutation();
		const local = { ...original, completed: true, revision: 'one-confirmed' };
		await commit([local]);
		finish();
		const freshRead = load();
		expect(freshRead).not.toBe(staleRead);
		expect(requests).toHaveLength(2);
		const fullList = [local, reminder('remote', { project: 'Work' })];
		if (staleFirst) {
			await settle(0, response([], []), staleRead);
			expect(rendered.current.reminders).toEqual([local]);
			expect(load()).toBe(freshRead);
		}
		await settle(1, response(fullList, ['Inbox', 'Work']), freshRead);
		if (!staleFirst) await settle(0, response([], []), staleRead);
		expect(rendered.current.getSnapshot()).toEqual({ reminders: fullList, projects: ['Inbox', 'Work'] });
		expect(rendered.current.reminders).toEqual(fullList);
		expect(rendered.current.projects).toEqual(['Inbox', 'Work']);
		expect(saveCachedReminderSnapshot).toHaveBeenCalledTimes(2);
	});

	it('detaches reads both when a write begins and when it finishes', async () => {
		const { rendered, requests, original, load, settle, commit } = harness();
		const before = load();
		const finish = rendered.current.beginLocalMutation();
		const during = load();
		expect(during).not.toBe(before);
		const local = { ...original, content: 'Saved correction', revision: 'one-confirmed' };
		await commit([local]);
		finish();
		const after = load();
		expect(after).not.toBe(during);
		await settle(1, response([], []), during);
		await settle(0, response([original]), before);
		expect(rendered.current.reminders).toEqual([local]);
		expect(load()).toBe(after);
		expect(requests).toHaveLength(3);
		const fullList = [local, reminder('remote')];
		await settle(2, response(fullList), after);
		expect(rendered.current.reminders).toEqual(fullList);
		expect(saveCachedReminderSnapshot).toHaveBeenCalledTimes(2);
	});

	it.each([true, false])('isolates a new session from an old mutation (old write finishes first=%s)', async oldWriteFirst => {
		const { rendered, original, load, settle } = harness();
		const oldRead = load();
		const finishOldWrite = rendered.current.beginLocalMutation();
		invalidatePwaSession();
		act(() => rendered.current.resetReminderState());
		const newRead = load();
		if (oldWriteFirst) finishOldWrite();
		expect(load()).toBe(newRead);
		await settle(0, response([original]), oldRead);
		expect(rendered.current.reminders).toEqual([]);
		expect(rendered.current.refreshing).toBe(true);
		expect(load()).toBe(newRead);
		const records = [reminder('new-session-reminder', { project: 'Work' })];
		await settle(1, response(records, ['Work']), newRead);
		expect(rendered.current.reminders).toEqual(records);
		expect(rendered.current.projects).toEqual(['Work']);
		expect(rendered.current.refreshing).toBe(false);
		expect(saveCachedReminderSnapshot).toHaveBeenCalledOnce();
		if (!oldWriteFirst) finishOldWrite();
	});

	it('keeps a newer confirmed snapshot instead of an older disk copy after a failed refresh', async () => {
		const { rendered, original, load, settle, commit } = harness();
		const confirmed = { ...original, content: 'Acknowledged edit', revision: 'one-confirmed' };
		await commit([confirmed]);
		const savedAt = rendered.current.lastUpdatedAt;
		vi.mocked(loadCachedReminderSnapshot).mockResolvedValue({ folderPath: 'Reminders', reminders: [original], projects: ['Inbox'], savedAt: 1 });
		await settle(0, new Response('Offline', { status: 503 }), load());
		expect(loadCachedReminderSnapshot).not.toHaveBeenCalled();
		expect(rendered.current.reminders).toEqual([confirmed]);
		expect(rendered.current.lastUpdatedAt).toBe(savedAt);
		expect(rendered.current.dataMode).toBe('cached');
		expect(rendered.current.error).toBe('Offline');
		vi.mocked(loadCachedReminderSnapshot).mockReset();
	});

	it('applies a peer confirmation in memory without rewriting the offline copy', async () => {
		const { rendered, original } = harness();
		const confirmed = { ...original, content: 'Peer edit', revision: 'one-peer' };
		await act(() => rendered.current.commitReminderState([confirmed], ['Inbox'], { persist: false }));
		expect(rendered.current.reminders).toEqual([confirmed]);
		expect(rendered.current.dataMode).toBe('live');
		expect(saveCachedReminderSnapshot).not.toHaveBeenCalled();
	});

	it('ignores late errors from invalidated reads without restoring an older cache', async () => {
		const { rendered, original, load, settle, commit } = harness();
		const staleRead = load();
		const finish = rendered.current.beginLocalMutation();
		const local = { ...original, completed: true };
		await commit([local]);
		finish();
		const freshRead = load();
		const fullList = [local, reminder('remote')];
		await settle(1, response(fullList), freshRead);
		await settle(0, new Response('Old read failed', { status: 503 }), staleRead);
		expect(rendered.current.reminders).toEqual(fullList);
		expect(loadCachedReminderSnapshot).not.toHaveBeenCalled();
		expect(saveCachedReminderSnapshot).toHaveBeenCalledTimes(2);
	});

	it('does not persist a response after unmount', async () => {
		const { rendered, load, settle } = harness();
		const pending = load();
		rendered.unmount();
		await settle(0, response([reminder('late')]), pending);
		expect(saveCachedReminderSnapshot).not.toHaveBeenCalled();
	});

	it('does not start a new request through a callback retained after unmount', async () => {
		const { rendered, options } = harness();
		const load = rendered.current.loadReminders;
		rendered.unmount();
		await load();
		expect(options.apiFetch).not.toHaveBeenCalled();
	});

	it('detaches old API client reads when the same token is re-enrolled', async () => {
		const { rendered, options, load, settle } = harness();
		const previous = load();
		options.apiFetch = vi.fn(async () => response([reminder('new')]));
		rendered.rerender();
		await act(() => rendered.current.loadReminders());
		await settle(0, response([reminder('old')]), previous);
		expect(rendered.current.reminders.map(item => item.id)).toEqual(['new']);
		expect(saveCachedReminderSnapshot).toHaveBeenCalledOnce();
	});
});

it('does not start reminder refreshes while paused, including retained callbacks', async () => {
	const options = { enabled: false, apiFetch: vi.fn<ApiFetch>(async () => response([])), authToken: 'token',
		authority: {}, bootstrapped: false, prepareSession: async () => {}, onSignedOut: vi.fn(),
		config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 }, setSelectedProject: vi.fn() };
	const rendered = renderHook(() => useReminderSync(options));
	const retained = rendered.current.loadReminders;
	await act(async () => retained());
	expect(options.apiFetch).not.toHaveBeenCalled();
	options.enabled = true; rendered.rerender();
	await act(async () => retained());
	expect(options.apiFetch).toHaveBeenCalledOnce();
	options.enabled = false; rendered.rerender();
	await act(async () => retained());
	expect(options.apiFetch).toHaveBeenCalledOnce();

});

describe('delta refresh', () => {
	const work = (id: string) => reminder(id, { filePath: 'Reminders/Work.md', project: 'Work' });
	const full = (reminders: ReminderRecord[]) => new Response(JSON.stringify({ reminders, projects: ['Inbox', 'Work'], issues: [] }),
		{ headers: { ETag: 'first', 'X-Crate-Delta-Base': '7.base' } });

	it('asks for notes changed since the confirmed snapshot and merges them in note order', async () => {
		const { rendered, options, original, load, settle } = harness();
		await settle(0, full([original, work('two')]), load());
		const pending = load();
		expect(options.apiFetch.mock.lastCall![0]).toBe('/reminders/list?folderPath=Reminders&since=7.base');
		const edited = work('three');
		await settle(1, new Response(JSON.stringify({ delta: true, changedPaths: ['Reminders/Work.md', 'Reminders/Gone.md'], reminders: [edited], projects: ['Inbox', 'Work'], issues: [] }),
			{ headers: { ETag: 'second', 'X-Crate-Delta-Base': '9.base' } }), pending);
		expect(rendered.current.reminders).toEqual([original, edited]);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith({ folderPath: 'Reminders', reminders: [original, edited], projects: ['Inbox', 'Work'], savedAt: expect.any(Number) as number, etag: 'second', issues: [], deltaBase: '9.base' });
	});

	it('never reads a malformed delta as a full list and falls back to a full read', async () => {
		const { rendered, options, original, load, settle } = harness();
		await settle(0, full([original, work('two')]), load());
		// A delta reminder outside its declared notes is rejected whole.
		await settle(1, new Response(JSON.stringify({ delta: true, changedPaths: ['Reminders/Work.md'], reminders: [reminder('stray')], projects: [], issues: [] })), load());
		expect(rendered.current.reminders).toEqual([original, work('two')]);
		expect(rendered.current.error).toMatch(/invalid reminder data/);
		const next = load();
		expect(options.apiFetch.mock.lastCall![0]).toBe('/reminders/list?folderPath=Reminders');
		await settle(2, full([original]), next);
		expect(rendered.current.reminders).toEqual([original]);
	});

	it('rejects a delta whose records duplicate an unchanged note identity', async () => {
		const { rendered, original, load, settle } = harness();
		await settle(0, full([original, work('two')]), load());
		await settle(1, new Response(JSON.stringify({ delta: true, changedPaths: ['Reminders/Work.md'], reminders: [work('one')], projects: ['Inbox', 'Work'], issues: [] })), load());
		expect(rendered.current.reminders).toEqual([original, work('two')]);
		expect(rendered.current.error).toMatch(/invalid reminder data/);
	});

	it('advances the delta base from a 304 without rewriting the snapshot', async () => {
		const { options, original, load, settle } = harness();
		await settle(0, full([original]), load());
		vi.mocked(saveCachedReminderSnapshot).mockClear();
		await settle(1, new Response(null, { status: 304, headers: { ETag: 'refreshed', 'X-Crate-Delta-Base': '12.base' } }), load());
		const pending = load();
		expect(options.apiFetch.mock.lastCall![0]).toBe('/reminders/list?folderPath=Reminders&since=12.base');
		expect(new Headers(options.apiFetch.mock.lastCall![1]!.headers).get('If-None-Match')).toBe('refreshed');
		expect(saveCachedReminderSnapshot).not.toHaveBeenCalled();
		await settle(2, new Response(null, { status: 304 }), pending);
	});
});

describe('PWA reminder offline copy hydration', () => {
	function hydration(authToken: string | null) {
		const options = { apiFetch: vi.fn<ApiFetch>(), authToken, authority: {}, bootstrapped: false,
			prepareSession: vi.fn(async () => {}), onSignedOut: vi.fn(),
			config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 }, setSelectedProject: vi.fn() };
		return { options, rendered: renderHook(() => useReminderSync(options)) };
	}

	it('reads the offline copy after app startup and reports hydration', async () => {
		vi.mocked(loadCachedReminderSnapshot).mockResolvedValueOnce({ folderPath: 'Reminders', reminders: [reminder('cached')], projects: ['Inbox'], savedAt: 5 });
		const { options, rendered } = hydration('token');
		expect(rendered.current.hydrated).toBe(false);
		expect(loadCachedReminderSnapshot).not.toHaveBeenCalled();
		options.bootstrapped = true;
		rendered.rerender();
		await act(async () => {});
		expect(options.prepareSession).toHaveBeenCalledOnce();
		expect(loadCachedReminderSnapshot).toHaveBeenCalledWith('Reminders');
		expect(rendered.current.hydrated).toBe(true);
		expect(rendered.current.reminders.map(item => item.id)).toEqual(['cached']);
		expect(rendered.current.dataMode).toBe('cached');
		expect(options.onSignedOut).not.toHaveBeenCalled();
		options.authority = {};
		rendered.rerender();
		expect(rendered.current.hydrated).toBe(false);
	});

	it('resets the view without reading storage when signed out', async () => {
		const { options, rendered } = hydration(null);
		options.bootstrapped = true;
		rendered.rerender();
		await act(async () => {});
		expect(options.onSignedOut).toHaveBeenCalledOnce();
		expect(options.prepareSession).not.toHaveBeenCalled();
		expect(loadCachedReminderSnapshot).not.toHaveBeenCalled();
		expect(rendered.current.hydrated).toBe(true);
	});
});
