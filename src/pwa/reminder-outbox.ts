import { ExpiredReminderChange, RejectedReminderChange, submitReminderChange } from './reminder-change-request';
import type { ReminderOutboxStorage } from './reminder-outbox-storage';
import type { PendingReminderChange, ReminderChangeResult } from './reminder-outbox-types';
import type { ApiFetch } from './types';
import { stringDigest } from './string-digest';

function requestFingerprint(change: PendingReminderChange): Promise<string> {
	return stringDigest(JSON.stringify([change.method, change.path, change.body]));
}

/** Automatic wakeups share the saved deadline and budget; only user retries reset them. */
export function reminderRetryAt(change: PendingReminderChange): number | undefined {
	return change.status === 'uncertain' && !change.reviewRequired && change.attempts < 3 ? change.retryAt : undefined;
}

export function createReminderOutbox({ storage, apiFetch, isCurrent, beginMutation, commit, onChange, onScan = () => {}, onError, onSettled, withLock = work => work(), canSend = () => true }: {
	storage: ReminderOutboxStorage;
	apiFetch: ApiFetch;
	isCurrent: () => boolean;
	beginMutation: () => () => void;
	commit: (change: PendingReminderChange, result: ReminderChangeResult) => Promise<void>;
	onChange: (changes: PendingReminderChange[]) => void;
	/** After a full storage read, which can also reveal entries written elsewhere. */
	onScan?: () => void;
	onError: (message: string) => void;
	onSettled: () => void;
	withLock?: (work: () => Promise<void>) => Promise<void>;
	canSend?: () => boolean;
}) {
	let running = false;
	// Web Locks do not flush another process's localStorage view. Remember only
	// fully persisted settlements to stop stale entries bouncing between tabs.
	// Eviction/restart may replay a receipt safely; no private bodies are retained.
	const settledRequests = new Map<string, string>();
	// The last full read plus this tab's own writes. Writes from other tabs
	// arrive as storage events, which call refresh().
	let snapshot: PendingReminderChange[] | undefined;
	const publish = (changes: PendingReminderChange[]) => {
		snapshot = changes;
		if (isCurrent()) onChange(changes);
		return changes;
	};
	const refresh = () => {
		const changes = publish(storage.load());
		if (isCurrent()) onScan();
		return changes;
	};
	// A write touches only its own key, so patch that entry instead of rereading every command.
	const patch = (operationId: string, change: PendingReminderChange | null) => {
		if (!snapshot) return refresh();
		const index = snapshot.findIndex(item => item.operationId === operationId);
		if (!change) return publish(snapshot.filter(item => item.operationId !== operationId));
		return publish(index < 0 ? [...snapshot, change] : snapshot.map((item, position) => position === index ? change : item));
	};
	const update = (change: PendingReminderChange) => { storage.put(change); patch(change.operationId, change); };
	const remove = (operationId: string) => { storage.remove(operationId); patch(operationId, null); };
	const hasCurrentAttempt = (change: PendingReminderChange) => {
		if (!isCurrent()) return false;
		const item = storage.get(change.operationId);
		return item !== null && item.body === change.body && item.path === change.path && item.method === change.method;
	};
	const isQueued = (item: PendingReminderChange) => !item.reviewRequired && (item.status === 'pending'
		|| (reminderRetryAt(item) ?? Infinity) <= Date.now());

	const enqueue = (change: PendingReminderChange) => {
		if (!isCurrent()) throw new Error('Session changed. Reopen Crate before saving.');
		const current = storage.load();
		const conflict = current.find(item => item.operationId !== change.operationId
			&& (item.kind === 'reorder' || change.kind === 'reorder' || item.recordId === change.recordId));
		if (conflict) throw new Error('Resolve the pending change before changing this reminder again.');
		const previous = current.find(item => item.operationId === change.operationId);
		if (previous && (previous.status !== 'failed' || previous.ambiguous)) throw new Error('This change is still syncing. Use Retry to check its status.');
		// Persist first: quota failures leave the editor and its draft intact.
		update(change);
	};

	// Explicit retry/recovery only. Foreground and reconnect events call drain().
	const retry = (operationId: string) => {
		const change = storage.get(operationId);
		if (!change || change.reviewRequired || !isCurrent()) return;
		if (running && change.status === 'pending') return;
		update({ ...change, status: 'pending', attempts: 0, retryAt: 0, error: undefined,
			ambiguous: change.ambiguous || change.status === 'uncertain' || (change.status === 'pending' && change.attempts > 0) });
	};

	const discard = (operationId: string, reviewedChange?: string): void | Promise<void> => {
		const remove = () => {
			const change = storage.get(operationId);
			if (!change || change.status !== 'failed' || !isCurrent()) return;
			if (change.reviewRequired ? reviewedChange !== JSON.stringify(change) : change.ambiguous) return;
			storage.remove(operationId);
			refresh();
		};
		if (reviewedChange !== undefined) return withLock(async () => { remove(); });
		remove();
	};

	const drain = async () => {
		if (running || !isCurrent()) return;
		running = true;
		let settled = false;
		try {
			await withLock(async () => {
				// One full read per lock hold; each command is then reread by its own key.
				snapshot = storage.load();
				let fresh = true;
				while (isCurrent() && canSend() && (typeof navigator === 'undefined' || navigator.onLine)) {
					const candidate = snapshot?.find(isQueued);
					if (!candidate) {
						// Reread once before stopping in case a storage event is still in flight.
						if (fresh) break;
						snapshot = storage.load();
						fresh = true;
						continue;
					}
					const queued = storage.get(candidate.operationId);
					if (!queued || !isQueued(queued)) { patch(candidate.operationId, queued); continue; }
					fresh = false;
					if (settledRequests.has(queued.operationId)
						&& settledRequests.get(queued.operationId) === await requestFingerprint(queued)) {
						if (hasCurrentAttempt(queued)) remove(queued.operationId);
						continue;
					}
					const change = { ...queued, status: 'pending' as const, attempts: queued.attempts + 1,
						ambiguous: queued.ambiguous || queued.status === 'uncertain' || (queued.status === 'pending' && queued.attempts > 0) };
					update(change);
					const finish = beginMutation();
					try {
						const result = await submitReminderChange(apiFetch, change);
						if (!hasCurrentAttempt(change)) continue;
						await commit(change, result);
						if (!hasCurrentAttempt(change)) continue;
						const fingerprint = await requestFingerprint(change);
						settledRequests.set(change.operationId, fingerprint);
						if (settledRequests.size > 64) settledRequests.delete(settledRequests.keys().next().value!);
						if (!hasCurrentAttempt(change)) continue;
						remove(change.operationId);
					} catch (error) {
						if (!hasCurrentAttempt(change)) continue;
						// A prior request may still have committed even if a retry conflicts.
						const definite = error instanceof RejectedReminderChange && !change.ambiguous;
						const reviewRequired = error instanceof ExpiredReminderChange;
						update({ ...change, status: definite || reviewRequired ? 'failed' : 'uncertain', reviewRequired,
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
