import { RejectedReminderChange, submitReminderChange } from './reminder-change-request';
import type { ReminderOutboxStorage } from './reminder-outbox-storage';
import type { PendingReminderChange, ReminderChangeResult } from './reminder-outbox-types';
import type { ApiFetch } from './types';

export function createReminderOutbox({ storage, apiFetch, isCurrent, beginMutation, commit, onChange, onError, onSettled, withLock = work => work(), canSend = () => true }: {
	storage: ReminderOutboxStorage;
	apiFetch: ApiFetch;
	isCurrent: () => boolean;
	beginMutation: () => () => void;
	commit: (change: PendingReminderChange, result: ReminderChangeResult) => Promise<PendingReminderChange | void>;
	onChange: (changes: PendingReminderChange[]) => void;
	onError: (message: string) => void;
	onSettled: () => void;
	withLock?: (work: () => Promise<void>) => Promise<void>;
	canSend?: () => boolean;
}) {
	let running = false;
	const refresh = () => {
		const changes = storage.load();
		if (isCurrent()) onChange(changes);
		return changes;
	};
	const update = (change: PendingReminderChange) => { storage.put(change); refresh(); };
	const hasCurrentAttempt = (change: PendingReminderChange) => isCurrent() && storage.load().some(item => item.operationId === change.operationId && item.body === change.body);

	const enqueue = (change: PendingReminderChange) => {
		if (!isCurrent()) throw new Error('Session changed. Reopen Crate before saving.');
		const conflict = storage.load().find(item => item.operationId !== change.operationId
			&& (item.kind === 'reorder' || change.kind === 'reorder' || item.recordId === change.recordId));
		if (conflict) throw new Error('Resolve the pending change before changing this reminder again.');
		const previous = storage.load().find(item => item.operationId === change.operationId);
		if (previous && (previous.status !== 'failed' || previous.ambiguous)) throw new Error('This change is still syncing. Use Retry to check its status.');
		// Persist first: quota failures leave the editor and its draft intact.
		update(change);
	};

	const retry = (operationId: string) => {
		const change = storage.load().find(item => item.operationId === operationId);
		if (!change || !isCurrent()) return;
		if (running && change.status === 'pending') return;
		update({ ...change, status: 'pending', attempts: 0, retryAt: 0, error: undefined,
			ambiguous: change.ambiguous || change.status === 'uncertain' || (change.status === 'pending' && change.attempts > 0) });
	};

	const discard = (operationId: string) => {
		const change = storage.load().find(item => item.operationId === operationId);
		if (!change || change.status !== 'failed' || change.ambiguous || !isCurrent()) return;
		storage.remove(operationId);
		refresh();
	};

	const drain = async () => {
		if (running || !isCurrent()) return;
		running = true;
		let settled = false;
		try {
			await withLock(async () => {
				while (isCurrent() && canSend() && (typeof navigator === 'undefined' || navigator.onLine)) {
					const queued = storage.load().find(item => item.status === 'pending'
						|| (item.status === 'uncertain' && item.attempts < 3 && item.retryAt <= Date.now()));
					if (!queued) break;
					const change = { ...queued, status: 'pending' as const, attempts: queued.attempts + 1,
						ambiguous: queued.ambiguous || queued.status === 'uncertain' || (queued.status === 'pending' && queued.attempts > 0) };
					update(change);
					const finish = beginMutation();
					try {
						const result = await submitReminderChange(apiFetch, change);
						if (!hasCurrentAttempt(change)) continue;
						const followUp = await commit(change, result);
						if (!hasCurrentAttempt(change)) continue;
						// Keep the successor durable before removing the original receipt check.
						if (followUp && !storage.load().some(item => item.operationId === followUp.operationId)) storage.put(followUp);
						storage.remove(change.operationId);
						refresh();
					} catch (error) {
						if (!hasCurrentAttempt(change)) continue;
						// A prior request may still have committed even if a retry conflicts.
						const definite = error instanceof RejectedReminderChange && !change.ambiguous;
						update({ ...change, status: definite ? 'failed' : 'uncertain',
							ambiguous: !definite,
							error: error instanceof Error ? error.message : String(error),
							retryAt: Date.now() + 2_000 * 2 ** (change.attempts - 1) });
					} finally { finish(); settled = true; }
				}
			});
		} catch (error) {
			if (isCurrent()) onError(error instanceof Error ? error.message : String(error));
		} finally {
			running = false;
			if (settled && isCurrent()) onSettled();
		}
	};

	return { enqueue, retry, discard, drain, refresh };
}
