import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { invalidatePwaSession } from '../session-generation';
import type { PendingReminderChange } from '../reminder-outbox-types';
import type { ApiFetch, ReminderRecord } from '../types';
import { useReminderOutbox } from './useReminderOutbox';

const stored = vi.hoisted(() => ({ changes: [] as PendingReminderChange[], initializing: undefined as Promise<void> | undefined }));
vi.mock('../reminder-outbox-storage', () => ({
	createReminderOutboxStorage: async () => { await stored.initializing; return {
		load: () => structuredClone(stored.changes),
		put: (change: PendingReminderChange) => {
			stored.changes = [...stored.changes.filter(item => item.operationId !== change.operationId), structuredClone(change)];
		},
		remove: (id: string) => { stored.changes = stored.changes.filter(item => item.operationId !== id); },
		quarantined: () => [], acceptsKey: () => false,
	}; },
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
	stored.initializing = undefined;
	vi.stubGlobal('navigator', { onLine: true, locks: { request: async (_name: string, work: () => Promise<void>) => work() } });
});

it('does not replace a new folder outbox when the old initialization finishes', async () => {
	const old = deferred<void>();
	stored.initializing = old.promise;
	const options = {
		authToken: 'token', folderPath: 'Reminders', bootstrapped: true, apiFetch: vi.fn<ApiFetch>(), showToast: vi.fn(),
		beginLocalMutation: () => () => {}, commitReminderState: async () => {},
		getSnapshot: () => ({ reminders: [], projects: [] }), loadReminders: vi.fn(),
	};
	const rendered = renderHook(() => useReminderOutbox(options));
	expect(rendered.current.ready).toBe(false);
	stored.initializing = undefined;
	options.folderPath = 'New folder';
	rendered.rerender();
	await act(async () => {});
	const current = rendered.current.outboxRef.current;
	expect(rendered.current.ready).toBe(true);
	await act(async () => old.resolve());
	expect(rendered.current.outboxRef.current).toBe(current);
	rendered.unmount();
	expect(options.apiFetch).not.toHaveBeenCalled();
});
afterEach(() => vi.useRealTimers());
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

it.each([1, 3])('preserves a saved retry deadline and %i attempts across mounting and browser resume', async attempts => {
	vi.useFakeTimers();
	const change: PendingReminderChange = {
		operationId: 'saved-operation', recordId: 'one', kind: 'save', path: '/reminders/create', method: 'POST',
		body: '{"operationId":"saved-operation","content":"Keep these exact bytes"}',
		status: 'uncertain', attempts, retryAt: Date.now() + 10_000, ambiguous: true,
	};
	stored.changes = [change];
	const apiFetch = vi.fn<ApiFetch>(async () => new Response('Unavailable', { status: 503 }));
	const mount = () => renderHook(() => useReminderOutbox({
		authToken: 'token', folderPath: 'Reminders', bootstrapped: true, apiFetch, showToast: vi.fn(),
		beginLocalMutation: () => () => {}, commitReminderState: async () => {},
		getSnapshot: () => ({ reminders: [], projects: ['Inbox'] }), loadReminders: vi.fn(),
	}));
	const first = mount();
	await act(async () => {});
	expect(apiFetch).not.toHaveBeenCalled();
	first.unmount();
	const reopened = mount();
	await act(async () => {});
	Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
	await act(async () => {
		window.dispatchEvent(new window.Event('online'));
		document.dispatchEvent(new window.Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(9_999);
	});
	expect(apiFetch).not.toHaveBeenCalled();
	expect(stored.changes).toEqual([change]);
	await act(async () => { await vi.advanceTimersByTimeAsync(1); });
	if (attempts === 1) {
		expect(apiFetch).toHaveBeenCalledExactlyOnceWith(change.path, { method: change.method, body: change.body });
		expect(stored.changes[0]).toMatchObject({ attempts: 2, status: 'uncertain', body: change.body });
	} else {
		await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
		expect(apiFetch).not.toHaveBeenCalled();
		apiFetch.mockResolvedValue(confirmed());
		await act(async () => {
			reopened.current.outboxRef.current!.retry(change.operationId);
			await reopened.current.outboxRef.current!.drain();
		});
		expect(apiFetch).toHaveBeenCalledExactlyOnceWith(change.path, { method: change.method, body: change.body });
		expect(stored.changes).toEqual([]);
	}
	reopened.unmount();
});
