import { afterEach, expect, it, vi } from 'vitest';
import { subscribeReminderOutboxEvents } from './reminder-outbox-events';
import type { ReminderRecord } from './types';

const before: ReminderRecord = { id: 'one', content: 'Before', completed: false, priority: 4,
	project: 'Inbox', filePath: 'Reminders/Inbox.md', revision: 'before' };
const after = { ...before, content: 'After', revision: 'after' };
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

function harness() {
	const browser = new EventTarget(), page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
	vi.stubGlobal('window', browser); vi.stubGlobal('document', page);
	let active = true;
	const finish = vi.fn(), loadReminders = vi.fn(async () => {}), showToast = vi.fn();
	const commitReminderState = vi.fn(async (_reminders: ReminderRecord[]) => {});
	const beginLocalMutation = vi.fn(() => finish);
	const outbox = { refresh: vi.fn(() => []), drain: vi.fn(async () => {}) };
	const resume = vi.fn(), setRecoveryChanges = vi.fn();
	const dispose = subscribeReminderOutboxEvents({
		isCurrent: () => active, resume, outbox, setRecoveryChanges,
		storage: { acceptsKey: key => key === 'pending' },
		recovery: { acceptsKey: key => key === 'pending' || key === 'recovery', load: () => [] },
		settlement: { key: 'settled', read: () => ({ version: 1, operationId: 'operation', kind: 'save',
			recordId: 'one', previousRevision: 'before', reminder: after }) },
		current: () => ({ beginLocalMutation, getSnapshot: () => ({ reminders: [before], projects: ['Inbox'] }),
			commitReminderState, loadReminders, showToast }),
	});
	cleanups.push(dispose);
	const storage = (key: string, newValue: string | null, oldValue: string | null = null) =>
		browser.dispatchEvent(Object.assign(new Event('storage'), { key, newValue, oldValue }));
	return { browser, page, storage, dispose, logout: () => { active = false; }, finish, beginLocalMutation,
		loadReminders, showToast, commitReminderState, outbox, resume, setRecoveryChanges };
}

it.each(['logout', 'dispose'] as const)('settles an already dispatched commit without refreshing after %s', async stop => {
	const h = harness();
	let reject!: (error: Error) => void;
	const committed = new Promise<void>((_resolve, fail) => { reject = fail; });
	h.commitReminderState.mockReturnValue(committed);
	h.storage('settled', 'receipt');
	expect(h.commitReminderState).toHaveBeenCalledWith([after], ['Inbox']);
	expect(h.finish).not.toHaveBeenCalled();
	h[stop]();
	reject(new Error('Late storage failure'));
	await committed.catch(() => {});
	expect(h.finish).toHaveBeenCalledOnce();
	expect(h.showToast).not.toHaveBeenCalled();
	expect(h.loadReminders).not.toHaveBeenCalled();
	h.storage('pending', null, 'command');
	expect(h.outbox.refresh).not.toHaveBeenCalled();
});

it('invalidates reads when a peer removes a command without a confirmation', () => {
	const h = harness();
	h.storage('unrelated', null, 'value');
	expect(h.beginLocalMutation).not.toHaveBeenCalled();
	h.storage('pending', null, 'command');
	expect(h.beginLocalMutation).toHaveBeenCalledOnce();
	expect(h.finish).toHaveBeenCalledOnce();
	expect(h.loadReminders).toHaveBeenCalledWith({ silent: true });
	expect(h.setRecoveryChanges).toHaveBeenCalledWith([]);
	expect(h.outbox.drain).toHaveBeenCalledOnce();
});

it('detaches wakeups and storage listeners as a single subscription', () => {
	const h = harness();
	h.browser.dispatchEvent(new Event('online'));
	h.page.dispatchEvent(new Event('visibilitychange'));
	expect(h.resume).toHaveBeenCalledTimes(2);
	h.dispose();
	h.browser.dispatchEvent(new Event('online'));
	h.page.dispatchEvent(new Event('visibilitychange'));
	h.storage('settled', 'receipt');
	expect(h.resume).toHaveBeenCalledTimes(2);
	expect(h.commitReminderState).not.toHaveBeenCalled();
});
