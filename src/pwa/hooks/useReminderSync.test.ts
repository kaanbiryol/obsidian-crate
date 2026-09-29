import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useReminderSync } from './useReminderSync';
import { invalidatePwaSession } from '../session-generation';
import { loadCachedReminderSnapshot, saveCachedReminderSnapshot } from '../reminder-cache';
import type { ApiFetch, ReminderRecord } from '../types';

vi.mock('../reminder-cache', () => ({
	loadCachedReminderSnapshot: vi.fn(async () => null),
	refreshCachedReminderSnapshot: vi.fn(async () => {}),
	saveCachedReminderSnapshot: vi.fn(async () => {}),
}));
afterEach(() => { vi.clearAllMocks(); });

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
		authToken: 'token',
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
	return { rendered, options, requests, original, load, settle, commit };
}

describe('PWA reminder refresh around local writes', () => {
	it('retains source issues through acknowledgements and 304 until a complete read repairs them', async () => {
		const { rendered, original, load, settle, commit } = harness();
		const issues = [{ path: 'Reminders/Large.md', reason: 'Source exceeds the reminder size limit' }];
		await settle(0, new Response(JSON.stringify({ reminders: [original], projects: ['Inbox'], issues })), load());
		expect(rendered.current.issues).toEqual(issues);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith('Reminders', [original], ['Inbox'], expect.any(Number), undefined, issues);
		const corrected = { ...original, content: 'Healthy reminder stays editable' };
		await commit([corrected]);
		expect(rendered.current.reminders).toEqual([corrected]);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith('Reminders', [corrected], ['Inbox'], expect.any(Number), undefined, issues);
		await settle(1, new Response(null, { status: 304 }), load());
		expect(rendered.current.issues).toEqual(issues);
		await settle(2, response([corrected]), load());
		expect(rendered.current.issues).toEqual([]);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith('Reminders', [corrected], ['Inbox'], expect.any(Number), 'latest-list', []);
	});

	it('restores cached source issues after a network error and clears them on logout', async () => {
		const { rendered, original, load, settle } = harness();
		const issues = [{ path: 'Reminders/Copy.md', reason: 'Duplicate reminder ID' }];
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
