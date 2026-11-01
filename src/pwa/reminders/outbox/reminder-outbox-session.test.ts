import { afterEach, expect, it, vi } from 'vitest';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { QuarantinedReminderEntry } from './reminder-outbox-storage';

const outbox = vi.hoisted(() => ({ refresh: vi.fn((): PendingReminderChange[] => []), drain: vi.fn(async () => {}), retry: vi.fn() }));
const outboxOptions = vi.hoisted(() => ({ current: null as null | { onSettled: () => void; commit: (change: PendingReminderChange, result: object) => Promise<void> } }));
vi.mock('./reminder-outbox', () => ({ createReminderOutbox: (options: typeof outboxOptions.current) => { outboxOptions.current = options; return outbox; } }));
vi.mock('./reminder-outbox-events', () => ({ subscribeReminderOutboxEvents: () => () => {} }));
import { createReminderOutboxSession } from './reminder-outbox-session';

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

const change = (operationId: string, status: PendingReminderChange['status']) =>
	({ operationId, status, kind: 'delete', recordId: operationId, path: '/reminders/delete', method: 'DELETE', body: '{}', attempts: 1, retryAt: 0 }) as PendingReminderChange;
const damaged: QuarantinedReminderEntry = { key: 'damaged', raw: '{' };

function harness(host: Record<string, unknown> = {}) {
	const lock = vi.fn(async (_name: string, work: () => unknown) => work());
	vi.stubGlobal('navigator', { locks: { request: lock } });
	let active = true;
	let earlier = [change('earlier-uncertain', 'uncertain'), change('earlier-failed', 'failed')];
	const storage = { quarantined: vi.fn(() => [damaged]), removeQuarantined: vi.fn() };
	const recovery = {
		load: vi.fn(() => earlier), quarantined: vi.fn((): QuarantinedReminderEntry[] => []), removeQuarantined: vi.fn(),
		adopt: vi.fn(() => { earlier = []; }),
	};
	const showToast = vi.fn(), onRecoveryChanges = vi.fn(), onQuarantine = vi.fn();
	const session = createReminderOutboxSession({
		storage: storage as never, recovery: recovery as never, settlement: { publish: vi.fn() } as never,
		isCurrent: () => active, onChanges: vi.fn(), onRecoveryChanges, onQuarantine, onStorageError: vi.fn(),
		current: () => ({ apiFetch: vi.fn() as never, showToast, beginLocalMutation: () => () => {}, invalidateReads: vi.fn(),
			commitReminderState: vi.fn(), getSnapshot: () => ({ reminders: [], projects: [] }), loadReminders: vi.fn(async () => {}), ...host }),
	});
	vi.clearAllMocks();
	return { session, lock, storage, recovery, showToast, onRecoveryChanges, onQuarantine, replace: () => { active = false; } };
}

it('adopts earlier-session changes and retries only their uncertain attempts', async () => {
	const h = harness();
	outbox.refresh.mockReturnValue([change('earlier-uncertain', 'uncertain'), change('earlier-failed', 'failed'), change('current-uncertain', 'uncertain')]);
	await h.session.recover();
	expect(h.lock).toHaveBeenCalledOnce();
	expect(h.recovery.adopt).toHaveBeenCalledOnce();
	expect(h.onRecoveryChanges).toHaveBeenCalledWith([]);
	expect(outbox.retry.mock.calls).toEqual([['earlier-uncertain']]);
	expect(outbox.drain).toHaveBeenCalledOnce();
});

it.each([{ canRecover: false }, { hasSnapshot: false }])('does not recover while %j', async host => {
	const h = harness(host);
	await h.session.recover();
	expect(h.lock).not.toHaveBeenCalled();
	expect(h.recovery.adopt).not.toHaveBeenCalled();
});

it('leaves earlier-session changes alone once the session is replaced', async () => {
	const h = harness();
	h.lock.mockImplementationOnce(async (_name, work) => { h.replace(); return work(); });
	await h.session.recover();
	expect(h.recovery.adopt).not.toHaveBeenCalled();
	expect(outbox.drain).not.toHaveBeenCalled();
});

it('removes reviewed damaged entries from both stores under the outbox lock', async () => {
	const h = harness();
	await expect(h.session.removeQuarantined([damaged])).resolves.toBe(true);
	expect(h.storage.removeQuarantined).toHaveBeenCalledWith([damaged]);
	expect(h.recovery.removeQuarantined).toHaveBeenCalledWith([damaged]);
	expect(h.onQuarantine).toHaveBeenCalledWith([damaged]);
});

it('keeps damaged entries when the session is replaced or the lock fails', async () => {
	const replaced = harness();
	replaced.lock.mockImplementationOnce(async (_name, work) => { replaced.replace(); return work(); });
	await expect(replaced.session.removeQuarantined([damaged])).resolves.toBe(false);
	expect(replaced.storage.removeQuarantined).not.toHaveBeenCalled();

	const failing = harness();
	failing.lock.mockRejectedValueOnce(new Error('Locks unavailable'));
	await expect(failing.session.removeQuarantined([damaged])).resolves.toBe(false);
	expect(failing.storage.removeQuarantined).not.toHaveBeenCalled();
	expect(failing.showToast).toHaveBeenCalledWith('error', 'Locks unavailable');
});

it('keeps confirmed results in memory during a drain and saves them once before reloading', async () => {
	const order: string[] = [];
	const commitReminderState = vi.fn(async () => {});
	const persistReminderState = vi.fn(async () => { order.push('persist'); });
	const loadReminders = vi.fn(async () => { order.push('load'); });
	harness({ commitReminderState, persistReminderState, loadReminders });
	await outboxOptions.current!.commit(change('one', 'pending'), {});
	expect(commitReminderState).toHaveBeenCalledWith([], [], { persist: 'later' });
	outboxOptions.current!.onSettled();
	await vi.waitFor(() => expect(order).toEqual(['persist', 'load']));
});
