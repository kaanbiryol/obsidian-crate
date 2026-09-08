import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReminderSync } from './useReminderSync';
import { invalidatePwaSession } from '../session-generation';
import { loadCachedReminderSnapshot, saveCachedReminderSnapshot } from '../reminder-cache';
import type { ApiFetch, ReminderRecord } from '../types';

const hookState = vi.hoisted(() => ({ setters: [] as Array<ReturnType<typeof vi.fn>> }));

vi.mock('react', () => ({
	useCallback: (callback: unknown) => callback,
	useEffect: () => {},
	useRef: (current: unknown) => ({ current }),
	useState: (initial: unknown) => {
		const setState = vi.fn();
		hookState.setters.push(setState);
		return [typeof initial === 'function' ? (initial as () => unknown)() : initial, setState];
	},
}));
vi.mock('../reminder-cache', () => ({
	loadCachedReminderSnapshot: vi.fn(async () => null),
	refreshCachedReminderSnapshot: vi.fn(async () => {}),
	saveCachedReminderSnapshot: vi.fn(async () => {}),
}));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

function reminder(id: string, overrides: Partial<ReminderRecord> = {}): ReminderRecord {
	return { id, content: id, completed: false, priority: 4, revision: `${id}-original`,
		filePath: 'Reminders/Inbox.md', project: 'Inbox', ...overrides };
}

function response(reminders: ReminderRecord[], projects = ['Inbox']) {
	return new Response(JSON.stringify({ reminders, projects }), { headers: { ETag: 'latest-list' } });
}

function harness() {
	hookState.setters = [];
	const requests: Array<{ resolve: (value: Response) => void }> = [];
	const apiFetch = vi.fn<ApiFetch>(() => new Promise<Response>(resolve => { requests.push({ resolve }); }));
	const hook = useReminderSync({
		apiFetch, authToken: 'token', bootstrapped: true,
		config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 }, setSelectedProject: vi.fn(),
	});
	const original = reminder('one');
	hook.hydrateCachedSnapshot({ folderPath: 'Reminders', reminders: [original], projects: ['Inbox'], savedAt: 1 });
	return { hook, requests, original, setRefreshing: hookState.setters[3]!, setIssues: hookState.setters[8]! };
}

describe('PWA reminder refresh around local writes', () => {
	it('retains structured source issues through local acknowledgements and 304 until a complete read repairs them', async () => {
		const { hook, requests, original, setIssues } = harness();
		const issues = [{ path: 'Reminders/Large.md', reason: 'Source exceeds the reminder size limit' }];
		const partial = hook.loadReminders();
		requests[0]!.resolve(new Response(JSON.stringify({ reminders: [original], projects: ['Inbox'], issues })));
		await partial;
		expect(setIssues).toHaveBeenLastCalledWith(issues);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith('Reminders', [original], ['Inbox'], expect.any(Number), undefined, issues);
		const corrected = { ...original, content: 'Healthy reminder stays editable' };
		await hook.commitReminderState([corrected]);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith('Reminders', [corrected], ['Inbox'], expect.any(Number), undefined, issues);
		const unchanged = hook.loadReminders();
		requests[1]!.resolve(new Response(null, { status: 304 }));
		await unchanged;
		expect(setIssues).toHaveBeenLastCalledWith(issues);
		const repaired = hook.loadReminders();
		requests[2]!.resolve(response([corrected]));
		await repaired;
		expect(setIssues).toHaveBeenLastCalledWith([]);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith('Reminders', [corrected], ['Inbox'], expect.any(Number), 'latest-list', []);
	});

	it('restores omitted-source explanations with a cached snapshot after a network error and clears them on logout', async () => {
		const { hook, requests, original, setIssues } = harness();
		const issues = [{ path: 'Reminders/Copy.md', reason: 'Duplicate reminder ID' }];
		vi.mocked(loadCachedReminderSnapshot).mockResolvedValueOnce({ folderPath: 'Reminders', reminders: [original], projects: ['Inbox'], savedAt: 123, issues });
		const failed = hook.loadReminders();
		requests[0]!.resolve(new Response('Offline', { status: 503 }));
		await failed;
		expect(hook.remindersRef.current).toEqual([original]);
		expect(setIssues).toHaveBeenLastCalledWith(issues);
		expect(hookState.setters[4]).toHaveBeenLastCalledWith('Offline');
		hook.resetReminderState();
		expect(setIssues).toHaveBeenLastCalledWith([]);
	});

	it.each([true, false])('starts a fresh read after a write while an invalidated read is unresolved (stale first=%s)', async staleFirst => {
		const { hook, requests, original } = harness();
		const staleRead = hook.loadReminders({ silent: true });
		expect(hook.loadReminders({ silent: true })).toBe(staleRead);
		expect(requests).toHaveLength(1);

		const finish = hook.beginLocalMutation();
		const local = { ...original, completed: true, revision: 'one-confirmed' };
		await hook.commitReminderState([local]);
		finish();
		const freshRead = hook.loadReminders({ silent: true });
		expect(freshRead).not.toBe(staleRead);
		expect(requests).toHaveLength(2);

		const fullList = [local, reminder('remote', { description: 'Added on another device', project: 'Work' })];
		if (staleFirst) {
			requests[0]!.resolve(response([], []));
			await staleRead;
			expect(hook.remindersRef.current).toEqual([local]);
			// Finishing an invalidated read must not clear the newer in-flight read.
			expect(hook.loadReminders({ silent: true })).toBe(freshRead);
			expect(requests).toHaveLength(2);
		}
		requests[1]!.resolve(response(fullList, ['Inbox', 'Work']));
		await freshRead;
		if (!staleFirst) {
			requests[0]!.resolve(response([], []));
			await staleRead;
		}

		expect(hook.remindersRef.current).toEqual(fullList);
		expect(hook.projectsRef.current).toEqual(['Inbox', 'Work']);
		expect(saveCachedReminderSnapshot).toHaveBeenCalledTimes(2);
		expect(saveCachedReminderSnapshot).toHaveBeenLastCalledWith('Reminders', fullList, ['Inbox', 'Work'], expect.any(Number), 'latest-list', []);
	});

	it('detaches reads both when a write begins and when it finishes', async () => {
		const { hook, requests, original } = harness();
		const beforeWrite = hook.loadReminders({ silent: true });
		const finish = hook.beginLocalMutation();
		const duringWrite = hook.loadReminders({ silent: true });
		expect(duringWrite).not.toBe(beforeWrite);
		expect(requests).toHaveLength(2);

		const local = { ...original, content: 'Saved correction', revision: 'one-confirmed' };
		await hook.commitReminderState([local]);
		finish();
		const afterWrite = hook.loadReminders({ silent: true });
		expect(afterWrite).not.toBe(duringWrite);
		expect(requests).toHaveLength(3);

		requests[1]!.resolve(response([], []));
		requests[0]!.resolve(response([original]));
		await Promise.all([beforeWrite, duringWrite]);
		expect(hook.remindersRef.current).toEqual([local]);
		expect(hook.loadReminders({ silent: true })).toBe(afterWrite);
		expect(requests).toHaveLength(3);

		const fullList = [local, reminder('remote')];
		requests[2]!.resolve(response(fullList));
		await afterWrite;
		expect(hook.remindersRef.current).toEqual(fullList);
		expect(saveCachedReminderSnapshot).toHaveBeenCalledTimes(2);
	});

	it.each([true, false])('isolates a new session from a previous session mutation (old write finishes first=%s)', async oldWriteFirst => {
		const { hook, requests, original, setRefreshing } = harness();
		const oldRead = hook.loadReminders({ silent: true });
		const finishOldWrite = hook.beginLocalMutation();
		invalidatePwaSession();
		hook.resetReminderState();
		const newRead = hook.loadReminders({ silent: true });
		expect(requests).toHaveLength(2);

		if (oldWriteFirst) finishOldWrite();
		expect(hook.loadReminders({ silent: true })).toBe(newRead);
		expect(requests).toHaveLength(2);
		requests[0]!.resolve(response([original]));
		await oldRead;
		expect(hook.remindersRef.current).toEqual([]);
		expect(setRefreshing).toHaveBeenLastCalledWith(true);
		expect(hook.loadReminders({ silent: true })).toBe(newRead);

		const newSessionRecords = [reminder('new-session-reminder', { project: 'Work' })];
		requests[1]!.resolve(response(newSessionRecords, ['Work']));
		await newRead;
		expect(hook.remindersRef.current).toEqual(newSessionRecords);
		expect(hook.projectsRef.current).toEqual(['Work']);
		expect(setRefreshing).toHaveBeenLastCalledWith(false);
		expect(saveCachedReminderSnapshot).toHaveBeenCalledOnce();
		if (!oldWriteFirst) finishOldWrite();
	});

	it('ignores a late error from the invalidated read without restoring an older cached snapshot', async () => {
		const { hook, requests, original } = harness();
		const staleRead = hook.loadReminders({ silent: true });
		const finish = hook.beginLocalMutation();
		const local = { ...original, completed: true };
		await hook.commitReminderState([local]);
		finish();
		const freshRead = hook.loadReminders({ silent: true });

		const fullList = [local, reminder('remote')];
		requests[1]!.resolve(response(fullList));
		await freshRead;
		requests[0]!.resolve(new Response('Old read failed', { status: 503 }));
		await staleRead;

		expect(hook.remindersRef.current).toEqual(fullList);
		expect(loadCachedReminderSnapshot).not.toHaveBeenCalled();
		expect(saveCachedReminderSnapshot).toHaveBeenCalledTimes(2);
	});
});
