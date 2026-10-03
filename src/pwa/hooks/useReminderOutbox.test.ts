import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { invalidatePwaSession } from '../session-generation';
import type { PendingReminderChange } from '../reminder-outbox-types';
import type { ApiFetch, ReminderRecord } from '../types';
import { useReminderOutbox } from './useReminderOutbox';

const stored = vi.hoisted(() => ({ changes: [] as PendingReminderChange[] }));
vi.mock('../reminder-outbox-storage', () => ({
	createReminderOutboxStorage: async () => ({
		load: () => structuredClone(stored.changes),
		put: (change: PendingReminderChange) => {
			stored.changes = [...stored.changes.filter(item => item.operationId !== change.operationId), structuredClone(change)];
		},
		remove: (id: string) => { stored.changes = stored.changes.filter(item => item.operationId !== id); },
		quarantined: () => [], acceptsKey: () => false,
	}),
	createReminderRecoveryStorage: async () => ({ load: () => [], quarantined: () => [], acceptsKey: () => false }),
}));
vi.mock('../reminder-settlement', () => ({ createReminderSettlementChannel: async () => ({ publish: vi.fn() }) }));
vi.mock('./useSyncFailureToast', () => ({ useSyncFailureToast: vi.fn() }));

const reminder: ReminderRecord = { id: 'one', content: 'My reminder', completed: false, priority: 4,
	project: 'Inbox', filePath: 'Reminders/Inbox.md', revision: 'confirmed' };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
function confirmed(notificationWarning?: string) {
	return new Response(JSON.stringify({ reminder, notificationWarning }));
}
beforeEach(() => {
	stored.changes = [];
	vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_name: string, work: () => Promise<void>) => work() } });
});
async function harness(path = '/reminders/create', online = true) {
	Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
	const response = deferred<Response>();
	const apiFetch = vi.fn<ApiFetch>(() => response.promise);
	const showToast = vi.fn();
	const commitReminderState = vi.fn(async () => {});
	const rendered = renderHook(() => useReminderOutbox({
		authToken: 'token', folderPath: 'Reminders', bootstrapped: true, apiFetch, showToast,
		beginLocalMutation: () => () => {}, commitReminderState,
		getSnapshot: () => ({ reminders: [], projects: ['Inbox'] }), loadReminders: vi.fn(),
	}));
	await act(async () => {});
	let draining!: Promise<void>;
	await act(async () => {
		rendered.current.outboxRef.current!.enqueue({ operationId: 'operation', recordId: 'one', kind: 'save',
			path, method: 'POST', body: '{}', status: 'pending', attempts: 0, retryAt: 0 });
		draining = rendered.current.outboxRef.current!.drain();
	});
	return { rendered, response, apiFetch, showToast, commitReminderState, draining };
}

it.each([['/reminders/create', 'Reminder created'], ['/reminders/update', 'Reminder updated']])(
	'waits for server confirmation and local commit for %s', async (path, message) => {
		const state = await harness(path);
		expect(state.apiFetch).toHaveBeenCalledOnce();
		expect(state.showToast).not.toHaveBeenCalled();
		const committed = deferred<void>();
		state.commitReminderState.mockImplementation(() => committed.promise);
		await act(async () => { state.response.resolve(confirmed()); });
		expect(state.commitReminderState).toHaveBeenCalledOnce();
		expect(state.showToast).not.toHaveBeenCalled();
		await act(async () => { committed.resolve(); await state.draining; });
		expect(state.showToast).toHaveBeenCalledExactlyOnceWith('success', message);
		expect(stored.changes).toEqual([]);
	});

it('keeps offline saves quiet until reconnect confirms them', async () => {
	const state = await harness('/reminders/create', false);
	await state.draining;
	expect(state.apiFetch).not.toHaveBeenCalled();
	expect(state.showToast).not.toHaveBeenCalled();
	Object.defineProperty(navigator, 'onLine', { value: true });
	await act(async () => {
		state.response.resolve(confirmed());
		await state.rendered.current.outboxRef.current!.drain();
	});
	expect(state.showToast).toHaveBeenCalledExactlyOnceWith('success', 'Reminder created');
});

it.each([409, 503])('does not announce success for a %s response, but does after retry', async status => {
	const state = await harness();
	await act(async () => { state.response.resolve(new Response('Save failed', { status })); await state.draining; });
	expect(state.showToast).not.toHaveBeenCalled();
	expect(stored.changes).toHaveLength(1);
	state.apiFetch.mockResolvedValue(confirmed());
	await act(async () => {
		state.rendered.current.outboxRef.current!.retry('operation');
		await state.rendered.current.outboxRef.current!.drain();
		await state.rendered.current.outboxRef.current!.drain();
	});
	expect(state.showToast).toHaveBeenCalledExactlyOnceWith('success', 'Reminder created');
});

it('preserves notification warnings instead of replacing them with success', async () => {
	const state = await harness();
	await act(async () => { state.response.resolve(confirmed('Unavailable')); await state.draining; });
	expect(state.showToast).toHaveBeenCalledExactlyOnceWith('info', 'Saved. Notification sync failed: Unavailable');
});

it('does not announce a delayed confirmation after logout', async () => {
	const state = await harness();
	invalidatePwaSession();
	await act(async () => { state.response.resolve(confirmed()); await state.draining; });
	expect(state.showToast).not.toHaveBeenCalled();
});
