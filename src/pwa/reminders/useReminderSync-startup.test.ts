import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { loadCachedReminderSnapshot, saveCachedReminderSnapshot } from './cache/reminder-cache';
import type { ApiFetch } from '../types';
import type { ReminderRecord } from './types';

const encryption = vi.hoisted(() => ({ status: 'checking', evidence: false }));
vi.mock('./encryption-session', () => ({
	reminderEncryptionSnapshot: () => ({ status: encryption.status }),
	hasReminderEncryptionEvidence: () => encryption.evidence,
}));
vi.mock('./cache/reminder-cache', () => ({
	loadCachedReminderSnapshot: vi.fn(async () => null),
	refreshCachedReminderSnapshot: vi.fn(async () => {}),
	saveCachedReminderSnapshot: vi.fn(async () => {}),
}));
import { useReminderSync } from './useReminderSync';

afterEach(() => { vi.clearAllMocks(); encryption.status = 'checking'; encryption.evidence = false; });

const record = (id: string): ReminderRecord => ({ id, content: id, completed: false, priority: 4, revision: `${id}-r`, filePath: 'Reminders/Inbox.md', project: 'Inbox' });
const listResponse = (ids: string[]) => new Response(JSON.stringify({ reminders: ids.map(record), projects: ['Inbox'], issues: [] }), { headers: { ETag: 'next' } });

function startup() {
	vi.mocked(loadCachedReminderSnapshot).mockResolvedValue({ folderPath: 'Reminders', reminders: [record('cached')], projects: ['Inbox'], savedAt: 5, etag: 'saved', issues: [] });
	const options = {
		apiFetch: vi.fn<ApiFetch>(async () => listResponse(['fetched'])),
		readUnverified: vi.fn<ApiFetch>(async () => listResponse(['early'])),
		authToken: 'token', authority: {}, bootstrapped: false, prepareSession: vi.fn(async () => {}), onSignedOut: vi.fn(),
		config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 }, setSelectedProject: vi.fn(),
	};
	return { options, rendered: renderHook(() => useReminderSync(options)) };
}

async function finishStartup({ options, rendered }: ReturnType<typeof startup>, status: string) {
	await act(async () => {});
	encryption.status = status;
	options.bootstrapped = true;
	rendered.rerender();
	await act(async () => {});
	await act(async () => { await rendered.current.loadReminders({ silent: true }); });
}

it('reads the offline copy and sends the first list request while the encryption check runs', async () => {
	const harness = startup();
	const { options, rendered } = harness;
	await act(async () => {});
	expect(loadCachedReminderSnapshot).toHaveBeenCalledOnce();
	expect(options.readUnverified).toHaveBeenCalledOnce();
	expect(new Headers(options.readUnverified.mock.calls[0]![1]!.headers).get('If-None-Match')).toBe('saved');
	// Nothing is shown before the check answers.
	expect(rendered.current.reminders).toEqual([]);
	await finishStartup(harness, 'unencrypted');
	expect(loadCachedReminderSnapshot).toHaveBeenCalledOnce();
	expect(options.apiFetch).not.toHaveBeenCalled();
	expect(rendered.current.reminders.map(item => item.id)).toEqual(['early']);
});

it.each(['ready', 'locked'])('discards the startup request when the check reports %s', async status => {
	const harness = startup();
	await finishStartup(harness, status);
	expect(harness.options.apiFetch).toHaveBeenCalledOnce();
	expect(harness.rendered.current.reminders.map(item => item.id)).toEqual(['fetched']);
	// An unlocked session reads its own offline copy again.
	expect(loadCachedReminderSnapshot).toHaveBeenCalledTimes(status === 'ready' ? 2 : 1);
});

it('waits for the check on a device with encryption evidence', async () => {
	encryption.evidence = true;
	const { options } = startup();
	await act(async () => {});
	expect(loadCachedReminderSnapshot).not.toHaveBeenCalled();
	expect(options.readUnverified).not.toHaveBeenCalled();
});

it('sends a failed startup request again through the verified client', async () => {
	const harness = startup();
	harness.options.readUnverified.mockRejectedValueOnce(new Error('offline'));
	await finishStartup(harness, 'unencrypted');
	expect(harness.options.apiFetch).toHaveBeenCalledOnce();
	expect(harness.rendered.current.reminders.map(item => item.id)).toEqual(['fetched']);
});

it('saves confirmed results committed for later once, when asked', async () => {
	encryption.evidence = true;
	const harness = startup();
	await finishStartup(harness, 'unencrypted');
	const { rendered } = harness;
	vi.mocked(saveCachedReminderSnapshot).mockClear();
	await act(() => rendered.current.commitReminderState([record('one')], ['Inbox'], { persist: 'later' }));
	await act(() => rendered.current.commitReminderState([record('one'), record('two')], ['Inbox'], { persist: 'later' }));
	expect(saveCachedReminderSnapshot).not.toHaveBeenCalled();
	await act(() => rendered.current.persistReminderState());
	await act(() => rendered.current.persistReminderState());
	expect(saveCachedReminderSnapshot).toHaveBeenCalledOnce();
	expect(vi.mocked(saveCachedReminderSnapshot).mock.calls[0]![0].reminders.map(item => item.id)).toEqual(['one', 'two']);
});

it.each([
	['visibilitychange', () => document, 'hidden'],
	['pagehide', () => window, 'visible'],
] as const)('saves confirmed results committed for later when the page hides (%s)', async (event, target, visibility) => {
	encryption.evidence = true;
	const harness = startup();
	await finishStartup(harness, 'unencrypted');
	const { rendered } = harness;
	vi.mocked(saveCachedReminderSnapshot).mockClear();
	await act(() => rendered.current.commitReminderState([record('one')], ['Inbox'], { persist: 'later' }));
	// Returning to the foreground leaves the write to the end of the drain.
	Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
	await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
	expect(saveCachedReminderSnapshot).not.toHaveBeenCalled();
	Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility });
	await act(async () => { target().dispatchEvent(new window.Event(event)); });
	expect(saveCachedReminderSnapshot).toHaveBeenCalledOnce();
	expect(vi.mocked(saveCachedReminderSnapshot).mock.calls[0]![0].reminders.map(item => item.id)).toEqual(['one']);
	// The drain's own write then has nothing left to save.
	await act(() => rendered.current.persistReminderState());
	expect(saveCachedReminderSnapshot).toHaveBeenCalledOnce();
});
