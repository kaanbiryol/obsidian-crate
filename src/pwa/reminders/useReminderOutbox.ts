import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSyncFailureToast } from '../hooks/useSyncFailureToast';
import { reminderNeedsAttention, reminderRetryAt, type createReminderOutbox } from './outbox/reminder-outbox';
import { createReminderOutboxStorage, createReminderRecoveryStorage, type QuarantinedReminderEntry } from './outbox/reminder-outbox-storage';
import { capturePwaSession } from '../connection/session-generation';
import { createReminderSettlementChannel } from './outbox/reminder-settlement';
import { createReminderOutboxSession } from './outbox/reminder-outbox-session';
import { reminderEncryptionSnapshot, subscribeReminderEncryption } from './encryption-session';
import type { PendingReminderChange } from './outbox/reminder-outbox-types';
import type { ApiFetch, ShowToast } from '../types';
import type { LoadReminders, ReminderRecord } from './types';
import type { ConfirmedReminderSnapshot } from './useReminderSync';

export function useReminderOutbox(options: {
	enabled?: boolean;
	authToken: string | null;
	bootstrapped: boolean;
	folderPath: string;
	apiFetch: ApiFetch;
	beginLocalMutation: () => () => void;
	invalidateReads: () => void;
	commitReminderState: (reminders: ReminderRecord[], projects?: string[], options?: { persist?: boolean }) => void | Promise<void>;
	getSnapshot: () => ConfirmedReminderSnapshot;
	loadReminders: LoadReminders;
	showToast: ShowToast;
	hasSnapshot?: boolean;
	canRecover?: boolean;
}) {
	const [changes, setChanges] = useState<PendingReminderChange[]>([]);
	const [recoveryChanges, setRecoveryChanges] = useState<PendingReminderChange[]>([]);
	const [quarantinedChanges, setQuarantinedChanges] = useState<QuarantinedReminderEntry[]>([]);
	const removeQuarantinedRef = useRef<((entries: QuarantinedReminderEntry[]) => Promise<boolean>) | null>(null);
	const recoverRef = useRef<(() => Promise<void>) | null>(null);
	const [ready, setReady] = useState(false);
	const [storageError, setStorageError] = useState<string | null>(null);
	const [initialization, setInitialization] = useState(0);
	const outboxRef = useRef<ReturnType<typeof createReminderOutbox> | null>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const { authToken, bootstrapped, folderPath } = options;
	// While locked, sealed changes read as unparseable and would be offered for removal as damaged.
	const locked = useSyncExternalStore(subscribeReminderEncryption, reminderEncryptionSnapshot).status === 'locked';

	useEffect(() => {
		let alive = true;
		const sessionCurrent = capturePwaSession();
		const isCurrent = () => alive && sessionCurrent();
		outboxRef.current = null;
		setReady(false);
		setStorageError(null);
		setChanges([]);
		setRecoveryChanges([]);
		setQuarantinedChanges([]);
		removeQuarantinedRef.current = null;
		recoverRef.current = null;
		if (!authToken || !bootstrapped || locked) return;
		let dispose = () => {};
		void Promise.all([createReminderOutboxStorage(authToken, folderPath), createReminderRecoveryStorage(authToken, folderPath), createReminderSettlementChannel(authToken, folderPath)]).then(([storage, recovery, settlement]) => {
			if (!isCurrent()) return;
			const session = createReminderOutboxSession({
				storage, recovery, settlement, isCurrent, current: () => optionsRef.current,
				onChanges: setChanges, onRecoveryChanges: setRecoveryChanges, onQuarantine: setQuarantinedChanges, onStorageError: setStorageError,
			});
			dispose = session.dispose;
			outboxRef.current = session.outbox;
			removeQuarantinedRef.current = session.removeQuarantined;
			recoverRef.current = session.recover;
			setReady(true);
			session.resume();
		}).catch((error: unknown) => {
			if (isCurrent()) setStorageError(`Could not load pending changes. ${error instanceof Error ? error.message : String(error)}`);
		});
		return () => { alive = false; outboxRef.current = null; recoverRef.current = null; removeQuarantinedRef.current = null; dispose(); };
	}, [authToken, bootstrapped, folderPath, initialization, locked]);

	useEffect(() => {
		if (ready && options.enabled !== false && options.hasSnapshot !== false) void outboxRef.current?.drain();
	}, [ready, options.enabled, options.hasSnapshot]);

	useEffect(() => {
		if (!ready || options.enabled === false || !navigator.onLine) return;
		const retryTimes = changes.flatMap(change => reminderRetryAt(change) ?? []);
		if (retryTimes.length === 0) return;
		const timer = window.setTimeout(() => { void outboxRef.current?.drain(); }, Math.max(0, Math.min(...retryTimes) - Date.now()));
		return () => window.clearTimeout(timer);
	}, [changes, ready, options.enabled]);
	const currentOutbox = outboxRef.current;
	useSyncFailureToast({
		scope: authToken ? JSON.stringify([authToken, folderPath]) : null,
		ready,
		operationIds: changes.filter(reminderNeedsAttention).map(change => change.operationId),
		feature: 'Reminder', showToast: options.showToast,
		isCurrent: () => currentOutbox !== null && outboxRef.current === currentOutbox,
	});

	return { changes, ready, outboxRef, storageError, retryInitialization: () => setInitialization(value => value + 1),
		quarantinedChanges, removeQuarantinedChanges: (entries: QuarantinedReminderEntry[]) => removeQuarantinedRef.current?.(entries) ?? Promise.resolve(false),
		recoveryChanges: options.enabled !== false && (options.canRecover === false || options.hasSnapshot === false) ? [] : recoveryChanges,
		recoverChanges: () => { void recoverRef.current?.(); } };
}
