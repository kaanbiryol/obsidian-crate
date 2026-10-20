import { createReminderOutbox } from './reminder-outbox';
import type { createReminderOutboxStorage, createReminderRecoveryStorage, QuarantinedReminderEntry } from './reminder-outbox-storage';
import { applyReminderListEffect } from './reminder-list-state';
import type { createReminderSettlementChannel } from './reminder-settlement';
import { subscribeReminderOutboxEvents } from './reminder-outbox-events';
import type { PendingReminderChange } from './reminder-outbox-types';
import { REMINDER_OUTBOX_LOCK } from './reminder-storage-keys';
import type { ApiFetch, LoadReminders, ReminderRecord, ShowToast } from '../../types';

/** The latest values from the hosting view, read when the session needs them. */
export interface ReminderOutboxSessionHost {
	enabled?: boolean;
	hasSnapshot?: boolean;
	canRecover?: boolean;
	apiFetch: ApiFetch;
	beginLocalMutation: () => () => void;
	invalidateReads: () => void;
	commitReminderState: (reminders: ReminderRecord[], projects?: string[], options?: { persist?: boolean }) => void | Promise<void>;
	getSnapshot: () => { reminders: ReminderRecord[]; projects: string[] };
	loadReminders: LoadReminders;
	showToast: ShowToast;
}

/** One authenticated folder's outbox, earlier-session recovery and peer events.
 * The hook mirrors its callbacks into React state and disposes it on change. */
export function createReminderOutboxSession({ storage, recovery, settlement, isCurrent, current, onChanges, onRecoveryChanges, onQuarantine, onStorageError }: {
	storage: Awaited<ReturnType<typeof createReminderOutboxStorage>>;
	recovery: Awaited<ReturnType<typeof createReminderRecoveryStorage>>;
	settlement: Awaited<ReturnType<typeof createReminderSettlementChannel>>;
	isCurrent: () => boolean;
	current: () => ReminderOutboxSessionHost;
	onChanges: (changes: PendingReminderChange[]) => void;
	onRecoveryChanges: (changes: PendingReminderChange[]) => void;
	onQuarantine: (entries: QuarantinedReminderEntry[]) => void;
	onStorageError: (message: string) => void;
}) {
	if (!navigator.locks) throw new Error('Update this browser to safely sync changes between tabs.');
	const showError = (error: unknown) => current().showToast('error', error instanceof Error ? error.message : String(error));
	const refreshQuarantine = () => {
		if (isCurrent()) onQuarantine([...storage.quarantined(), ...recovery.quarantined()]);
	};
	const outbox = createReminderOutbox({
		storage, apiFetch: current().apiFetch, isCurrent,
		withLock: work => navigator.locks.request(REMINDER_OUTBOX_LOCK, work),
		canSend: () => current().enabled !== false && current().hasSnapshot !== false,
		beginMutation: () => current().beginLocalMutation(),
		onChange: onChanges,
		onScan: refreshQuarantine,
		onError: message => { onStorageError(message); current().showToast('error', message); },
		onSettled: () => { void current().loadReminders({ silent: true }); },
		commit: async (change, result) => {
			const host = current();
			let list = host.getSnapshot();
			if (result.reminder) list = applyReminderListEffect(list, { kind: 'upsert', record: result.reminder });
			else if (change.kind === 'delete') list = applyReminderListEffect(list, { kind: 'delete', recordId: change.recordId });
			else if (change.kind === 'reorder') list = applyReminderListEffect(list, change);
			await host.commitReminderState(list.reminders, list.projects);
			if (isCurrent()) settlement.publish(change, result);
			if (isCurrent() && result.notificationWarning) host.showToast('info', `Saved. Notification sync failed: ${result.notificationWarning}`);
			if (isCurrent() && change.kind === 'save' && !result.notificationWarning) {
				host.showToast('success', change.path === '/reminders/create' ? 'Reminder created' : 'Reminder updated');
			}
			return undefined;
		},
	});
	outbox.refresh();
	onRecoveryChanges(recovery.load());

	const resume = () => {
		if (!isCurrent()) return;
		try {
			outbox.refresh();
			void outbox.drain();
		} catch (error) { showError(error); }
	};
	const removeQuarantined = async (entries: QuarantinedReminderEntry[]): Promise<boolean> => {
		try {
			await navigator.locks.request(REMINDER_OUTBOX_LOCK, () => {
				if (!isCurrent()) return;
				storage.removeQuarantined(entries);
				recovery.removeQuarantined(entries);
				refreshQuarantine();
			});
			return isCurrent();
		} catch (error) {
			if (isCurrent()) showError(error);
			return false;
		}
	};
	const recover = async (): Promise<void> => {
		if (!isCurrent() || current().canRecover === false || current().hasSnapshot === false) return;
		try {
			await navigator.locks.request(REMINDER_OUTBOX_LOCK, () => {
				if (!isCurrent()) return;
				const recovered = new Set(recovery.load().map(change => change.operationId));
				recovery.adopt();
				onRecoveryChanges(recovery.load());
				// Selecting recovery explicitly resumes these earlier-session attempts.
				for (const change of outbox.refresh()) {
					if (recovered.has(change.operationId) && change.status === 'uncertain') outbox.retry(change.operationId);
				}
			});
			resume();
		} catch (error) { showError(error); }
	};
	const dispose = subscribeReminderOutboxEvents({
		storage, recovery, settlement, outbox, isCurrent, resume, setRecoveryChanges: onRecoveryChanges, current,
	});
	return { outbox, resume, recover, removeQuarantined, dispose };
}
