import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReminderMutations } from './useReminderMutations';
import { invalidatePwaSession } from '../session-generation';
import { restoreReminderDraft } from '../reminder-drafts';
import type { ModalState, ReminderRecord } from '../types';
vi.mock('react', () => ({ useCallback: (callback: unknown) => callback, useRef: (current: unknown) => ({ current }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function harness() {
	const remindersRef = { current: ['one', 'two'].map(id => ({ id, content: id, completed: false, priority: 4, revision: id, filePath: `Reminders/${id}.md`, project: id })) as ReminderRecord[] };
	const requests: Array<{ body: Record<string, unknown>; resolve: (response: Response) => void }> = [];
	const commit = vi.fn((value: ReminderRecord[]) => { remindersRef.current = value; });
	const closeModal = vi.fn(); const showToast = vi.fn();
	const hook = useReminderMutations({
		apiFetch: async (_path, init) => new Promise<Response>(resolve => { requests.push({ body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>, resolve }); }),
		beginLocalMutation: () => () => {}, ensureCanMutate: () => true, commitReminderState: commit,
		setReminders: value => { remindersRef.current = typeof value === 'function' ? value(remindersRef.current) : value; },
		remindersRef, projectsRef: { current: ['one', 'two'] }, config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 },
		projects: ['one', 'two'], selectedProject: null, closeModal, setProjects: () => {}, setSaving: () => {}, showToast,
	});
	return { hook, requests, remindersRef, commit, closeModal, showToast };
}
function confirmed(record: ReminderRecord) { return new Response(JSON.stringify({ reminder: { ...record, completed: true, revision: `${record.revision}-new` } })); }

describe('PWA acknowledgement and concurrency', () => {
	it.each([false, true])('merges overlapping successes without restoring stale list state (reverse=%s)', async reverse => {
		const { hook, requests, remindersRef } = harness();
		const promises = [hook.toggleReminderCompleted('one', false), hook.toggleReminderCompleted('two', false)];
		for (const index of reverse ? [1, 0] : [0, 1]) {
			requests[index]!.resolve(confirmed(remindersRef.current[index]!)); await promises[index];
		}
		expect(remindersRef.current.map(record => record.completed)).toEqual([true, true]);
	});
	it('does not roll back another record when one mutation fails', async () => {
		const { hook, requests, remindersRef } = harness();
		const one = hook.toggleReminderCompleted('one', false); const two = hook.toggleReminderCompleted('two', false);
		requests[1]!.resolve(confirmed(remindersRef.current[1]!)); await two;
		requests[0]!.resolve(new Response('Conflict', { status: 409 })); await one;
		expect(remindersRef.current.map(record => record.completed)).toEqual([false, true]);
	});
	it('prevents a second mutation overtaking the same reminder', async () => {
		const { hook, requests, remindersRef } = harness();
		const one = hook.toggleReminderCompleted('one', false); await hook.toggleReminderCompleted('one', false);
		expect(requests).toHaveLength(1);
		requests[0]!.resolve(confirmed(remindersRef.current[0]!)); await one;
	});
	it('ignores a successful mutation response after logout', async () => {
		const { hook, requests, remindersRef, commit } = harness();
		const one = hook.toggleReminderCompleted('one', false);
		invalidatePwaSession(); requests[0]!.resolve(confirmed(remindersRef.current[0]!)); await one;
		expect(commit).not.toHaveBeenCalled();
	});
	it('retains failed drafts and reuses the same operation on retry', async () => {
		const memory = new Map<string, string>();
		vi.stubGlobal('sessionStorage', { setItem: (key: string, value: string) => memory.set(key, value), getItem: (key: string) => memory.get(key), removeItem: (key: string) => memory.delete(key) });
		const { hook, requests, closeModal } = harness();
		const modal: ModalState = { mode: 'create', operationId: crypto.randomUUID(), draft: { content: 'My unsaved draft', description: 'Details', project: 'Inbox', defaultProject: 'Inbox', priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false } };
		const saving = hook.saveReminder(modal);
		await vi.waitFor(() => expect(requests).toHaveLength(1));
		expect(closeModal).not.toHaveBeenCalled();
		requests[0]!.resolve(new Response('Offline', { status: 503 })); await saving;
		expect(closeModal).not.toHaveBeenCalled();
		expect(restoreReminderDraft({ ...modal, draft: { ...modal.draft, content: '' } }).draft.content).toBe('My unsaved draft');
		const retry = hook.saveReminder(modal); await vi.waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[1]!.body).toEqual(requests[0]!.body);
		requests[1]!.resolve(new Response(JSON.stringify({ reminder: { id: modal.operationId, content: modal.draft.content, project: 'Inbox' } }))); await retry;
		expect(closeModal).toHaveBeenCalledOnce();
		expect(memory.size).toBe(0);
	});
});
