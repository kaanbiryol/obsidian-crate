import { useEffect, useRef, useState } from 'react';
import { createReminderOutbox } from '../reminder-outbox';
import { createReminderOutboxStorage, createReminderRecoveryStorage } from '../reminder-outbox-storage';
import { capturePwaSession } from '../session-generation';
import { mergeReminderRecord } from '../reminder-optimistic-state';
import { mergeProject, reorderProjectReminders } from '../reminder-list-state';
import { applyReminderSettlement, createReminderSettlementChannel } from '../reminder-settlement';
import type { PendingReminderChange } from '../reminder-outbox-types';
import type { ApiFetch, LoadReminders, ReminderRecord, ShowToast } from '../types';
import type { MutableRefObject } from 'react';

export function useReminderOutbox(options: {
	authToken: string | null;
	bootstrapped: boolean;
	folderPath: string;
	apiFetch: ApiFetch;
	beginLocalMutation: () => () => void;
	commitReminderState: (reminders: ReminderRecord[], projects?: string[]) => void | Promise<void>;
	remindersRef: MutableRefObject<ReminderRecord[]>;
	projectsRef: MutableRefObject<string[]>;
	loadReminders: LoadReminders;
	showToast: ShowToast;
	hasSnapshot?: boolean;
	canRecover?: boolean;
}) {
	const [changes, setChanges] = useState<PendingReminderChange[]>([]);
	const [recoveryChanges, setRecoveryChanges] = useState<PendingReminderChange[]>([]);
	const recoverRef = useRef<(() => Promise<void>) | null>(null);
	const [ready, setReady] = useState(false);
	const [storageError, setStorageError] = useState<string | null>(null);
	const [initialization, setInitialization] = useState(0);
	const outboxRef = useRef<ReturnType<typeof createReminderOutbox> | null>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const { authToken, bootstrapped, folderPath } = options;

	useEffect(() => {
		let alive = true;
		const sessionCurrent = capturePwaSession();
		const isCurrent = () => alive && sessionCurrent();
		outboxRef.current = null;
		setReady(false);
		setStorageError(null);
		setChanges([]);
		setRecoveryChanges([]);
		recoverRef.current = null;
		if (!authToken || !bootstrapped) return;
		let cleanup = () => {};
		void Promise.all([createReminderOutboxStorage(authToken, folderPath), createReminderRecoveryStorage(authToken, folderPath), createReminderSettlementChannel(authToken, folderPath)]).then(([storage, recovery, settlement]) => {
			if (!isCurrent()) return;
			if (!navigator.locks) throw new Error('Update this browser to safely sync changes between tabs.');
			const outbox = createReminderOutbox({
				storage, apiFetch: optionsRef.current.apiFetch, isCurrent,
				withLock: work => navigator.locks.request('crate-reminder-outbox', work),
				canSend: () => optionsRef.current.hasSnapshot !== false,
				beginMutation: () => optionsRef.current.beginLocalMutation(),
				onChange: setChanges,
			onError: message => { setStorageError(message); optionsRef.current.showToast('error', message); },
				onSettled: () => { void optionsRef.current.loadReminders({ silent: true }); },
				commit: async (change, result) => {
					const current = optionsRef.current;
					let reminders = current.remindersRef.current;
					let projects = current.projectsRef.current;
					if (result.reminder) {
						reminders = mergeReminderRecord(reminders, result.reminder);
						projects = mergeProject(projects, result.reminder.project);
					} else if (change.kind === 'delete') reminders = reminders.filter(item => item.id !== change.recordId);
					else if (change.kind === 'reorder') reminders = reorderProjectReminders(reminders, change.project!, change.orderedIds!);
					await current.commitReminderState(reminders, projects);
					if (isCurrent()) settlement.publish(change, result);
					if (isCurrent() && result.notificationWarning) current.showToast('info', `Saved. Notification sync failed: ${result.notificationWarning}`);
					if (isCurrent() && result.reminder && change.followUp) {
						const { followUpReminderChange } = await import('../save-reminder-command');
						return followUpReminderChange(change, result.reminder);
					}
					return undefined;
				},
			});
			outbox.refresh();
			setRecoveryChanges(recovery.load());
			outboxRef.current = outbox;
			setReady(true);
			const resume = () => {
				if (!isCurrent()) return;
				try {
					// Resume durable attempts when the app is reopened or connectivity returns.
					for (const change of outbox.refresh()) {
						if (change.status === 'uncertain') outbox.retry(change.operationId);
					}
					void outbox.drain();
				} catch (error) { optionsRef.current.showToast('error', error instanceof Error ? error.message : String(error)); }
			};
			recoverRef.current = async () => {
				if (!isCurrent() || optionsRef.current.canRecover === false || optionsRef.current.hasSnapshot === false) return;
				try {
					await navigator.locks.request('crate-reminder-outbox', () => {
						if (!isCurrent()) return;
						recovery.adopt();
						setRecoveryChanges(recovery.load());
						outbox.refresh();
					});
					resume();
				} catch (error) { optionsRef.current.showToast('error', error instanceof Error ? error.message : String(error)); }
			};
			const visible = () => { if (document.visibilityState === 'visible') resume(); };
			const storageChanged = (event: StorageEvent) => {
				if (!isCurrent()) return;
				if (event.key === settlement.key && event.newValue) {
					const confirmed = settlement.read(event);
					const current = optionsRef.current;
					const finish = current.beginLocalMutation();
					void (async () => {
						try {
							const next = confirmed && current.hasSnapshot !== false ? applyReminderSettlement(current.remindersRef.current, current.projectsRef.current, confirmed) : null;
							if (next) await current.commitReminderState(next.reminders, next.projects);
						} catch (error) { if (isCurrent()) current.showToast('error', error instanceof Error ? error.message : String(error)); }
						finally { finish(); if (isCurrent()) void optionsRef.current.loadReminders({ silent: true }); }
					})();
					return;
				}
				if (!recovery.acceptsKey(event.key)) return;
				try {
					// Also revalidate if a confirmation was missed, or another tab discarded a rejection.
					if (storage.acceptsKey(event.key) && event.oldValue && event.newValue === null) {
						const finish = optionsRef.current.beginLocalMutation();
						finish();
						void optionsRef.current.loadReminders({ silent: true });
					}
					setRecoveryChanges(recovery.load()); outbox.refresh(); void outbox.drain();
				}
				catch (error) { optionsRef.current.showToast('error', error instanceof Error ? error.message : String(error)); }
			};
			window.addEventListener('online', resume);
			document.addEventListener('visibilitychange', visible);
			window.addEventListener('storage', storageChanged);
			cleanup = () => {
				window.removeEventListener('online', resume);
				document.removeEventListener('visibilitychange', visible);
				window.removeEventListener('storage', storageChanged);
			};
			resume();
		}).catch((error: unknown) => {
			if (isCurrent()) setStorageError(`Could not load pending changes. ${error instanceof Error ? error.message : String(error)}`);
		});
		return () => { alive = false; outboxRef.current = null; recoverRef.current = null; cleanup(); };
	}, [authToken, bootstrapped, folderPath, initialization]);

	useEffect(() => {
		if (ready && options.hasSnapshot !== false) void outboxRef.current?.drain();
	}, [ready, options.hasSnapshot]);

	useEffect(() => {
		if (!ready || !navigator.onLine) return;
		const retryTimes = changes.filter(change => change.status === 'uncertain' && change.attempts < 3).map(change => change.retryAt);
		if (retryTimes.length === 0) return;
		const timer = window.setTimeout(() => { void outboxRef.current?.drain(); }, Math.max(0, Math.min(...retryTimes) - Date.now()));
		return () => window.clearTimeout(timer);
	}, [changes, ready]);

	return { changes, ready, outboxRef, storageError, retryInitialization: () => setInitialization(value => value + 1),
		recoveryChanges: options.canRecover === false || options.hasSnapshot === false ? [] : recoveryChanges,
		recoverChanges: () => { void recoverRef.current?.(); } };
}
