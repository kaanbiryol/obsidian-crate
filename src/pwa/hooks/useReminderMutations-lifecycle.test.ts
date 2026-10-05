import { act, createElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useReminderMutations } from './useReminderMutations';
import { useReminderOutbox } from './useReminderOutbox';
import { newReminderOperationId } from '../reminder-operation-id';
import { createSettingsStore } from '../settings-store';
import { SettingsContext, useFeatureSettings } from '../settings-context';
import { pwaSyncState } from '../sync/state';
import { invalidatePwaSession } from '../session-generation';
import type { PendingReminderChange } from '../reminder-outbox-types';
import type { ReminderRecord } from '../types';

vi.mock('./useReminderOutbox', () => ({ useReminderOutbox: vi.fn() }));
vi.mock('../reminder-operation-id', () => ({ newReminderOperationId: vi.fn() }));

function deferred() {
	let resolve!: (id: string) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal('localStorage', { getItem: () => null });
});

function harness() {
	const changes: PendingReminderChange[] = [];
	const outbox = {
		enqueue: vi.fn((change: PendingReminderChange) => { changes.push(change); }),
		drain: vi.fn(async () => {}), retry: vi.fn(), discard: vi.fn(), refresh: vi.fn(() => changes),
	};
	vi.mocked(useReminderOutbox).mockReturnValue({ changes, ready: true, outboxRef: { current: outbox }, storageError: null,
		retryInitialization: vi.fn(), recoveryChanges: [], recoverChanges: vi.fn(), quarantinedChanges: [], removeQuarantinedChanges: vi.fn(async () => true) });
	const reminder: ReminderRecord = { id: 'one', content: 'My reminder', completed: false, priority: 4,
		project: 'Inbox', filePath: 'Reminders/Inbox.md', revision: 'one' };
	const config = { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 };
	const feature = { updateReady: true, updateContentReady: true, canApplyUpdate: () => true, ready: true, connected: true, status: { state: 'synced' as const, label: 'Synced' },
		attention: null, unsynced: false, onRefresh: vi.fn(async () => {}), onLogout: vi.fn(async () => {}) };
	const store = createSettingsStore();
	store.setFeature('reading', { ...feature, shortcut: null, issues: null });
	const showToast = vi.fn();
	const hook = renderHook(() => {
		const mutations = useReminderMutations({ authToken: 'token', bootstrapped: true, config, reminders: [reminder], projects: ['Inbox'],
			getSnapshot: () => ({ reminders: [reminder], projects: ['Inbox'] }), selectedProject: null,
			apiFetch: vi.fn(), beginLocalMutation: () => () => {}, commitReminderState: vi.fn(), closeModal: vi.fn(),
			ensureCanMutate: () => true, refreshPresentation: vi.fn(), setSaving: vi.fn(), showToast, loadReminders: vi.fn() });
		useFeatureSettings('reminders', { ...feature, config, push: { phase: 'unsupported', status: null },
			onEnablePush: vi.fn(async () => {}), recovery: null, unsynced: changes.length > 0,
			updateReady: !mutations.isPreparingMutation(), canApplyUpdate: () => !mutations.isPreparingMutation() });
		return mutations;
	}, undefined, children => createElement(SettingsContext.Provider, { value: store }, children));
	return { hook, store, outbox, changes, showToast };
}

it.each(['complete', 'delete', 'reorder'] as const)('blocks updates before enqueue and publishes preparation failure for %s', async action => {
	const issuance = deferred();
	vi.mocked(newReminderOperationId).mockReturnValueOnce(issuance.promise);
	const h = harness();
	let pending!: Promise<void>;
	act(() => {
		pending = action === 'complete' ? h.hook.current.toggleReminderCompleted('one', false)
			: action === 'delete' ? h.hook.current.deleteReminder('one') : h.hook.current.persistReorder('Inbox', ['one']);
		// The synchronous reload guard must work before the state update commits.
		expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
	});
	expect(h.store.getSnapshot().reminders?.updateReady).toBe(false);
	expect(h.outbox.enqueue).not.toHaveBeenCalled();
	h.hook.rerender();
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
	await act(async () => { issuance.reject(new Error('Offline')); await pending; });
	expect(h.showToast).toHaveBeenCalledWith('error', 'Offline');
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(true);
});

it('keeps updates blocked across overlapping preparations and the handoff to durable changes', async () => {
	const first = deferred(), second = deferred();
	vi.mocked(newReminderOperationId).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
	const h = harness();
	let complete!: Promise<void>, reorder!: Promise<void>;
	act(() => {
		complete = h.hook.current.toggleReminderCompleted('one', false);
		reorder = h.hook.current.persistReorder('Inbox', ['one']);
	});
	await act(async () => { first.reject(new Error('Unavailable')); await complete; });
	expect(h.store.getSnapshot().reminders?.updateReady).toBe(false);
	await act(async () => { second.resolve('operation'); await reorder; });
	expect(h.hook.current.isPreparingMutation()).toBe(false);
	expect(h.outbox.enqueue).toHaveBeenCalledOnce();
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
});

it('does not republish readiness or enqueue after logout and unmount during preparation', async () => {
	const issuance = deferred();
	vi.mocked(newReminderOperationId).mockReturnValueOnce(issuance.promise);
	const h = harness();
	let pending!: Promise<void>;
	act(() => { pending = h.hook.current.toggleReminderCompleted('one', false); });
	invalidatePwaSession();
	h.hook.unmount();
	await act(async () => { issuance.resolve('obsolete'); await pending; });
	expect(h.store.getSnapshot().reminders).toBeNull();
	expect(pwaSyncState(h.store.getSnapshot()).canUpdate).toBe(false);
	expect(h.outbox.enqueue).not.toHaveBeenCalled();
});
