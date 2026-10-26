import { assertReadingUpdateBase, coalesceReadingUpdate } from './coalesce-update';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { readingUrl, type ReadingChanges } from '@/reading/core/model';
import { loadReading, readingRequest, reloadReadingAfterWrites, type ReadingWrite } from './api';
import { ReadingApiError } from './session/api-error';
import { readingDrainLock, readingLock, pruneReadingAttempts, pendingReading, savePendingReading, type ReadingCache } from './storage/storage';
import { assertReadingSession, type ReadingSession } from './session/session';
import { isReadingCommand } from './storage/storage-validation';
import { hasAutomaticRetry, automaticRetryDelayMs } from '@/pwa/sync/retry-policy';

export interface ReadingUpdateIntent { id: string; changes: ReadingChanges; before: ReadingChanges }
export type ReadingCommand =
	| { action: 'capture'; intent: { url: string; title?: string; fetchArticle?: boolean } }
	| { action: 'update'; intent: ReadingUpdateIntent }
	| { action: 'retry'; intent: { id: string } };
export type PendingReading = ReadingCommand & {
	id: string; sessionId: string; queuedAt?: string; body?: string; error?: string;
	review?: boolean; attempts?: number; retryAt?: number;
};
export type ReadingRetryMode = 'automatic' | 'manual';

/** The timer and every dispatch path use the same persisted retry budget. */
export function readingRetryAt(op: PendingReading): number | undefined {
	return op.error !== undefined && !op.review && hasAutomaticRetry(op.attempts ?? 0) ? op.retryAt : undefined;
}
export function readingNeedsAttention(op: PendingReading): boolean {
	return Boolean(op.review || op.error && readingRetryAt(op) === undefined);
}
function canDispatch(op: PendingReading, mode: ReadingRetryMode): boolean {
	if (op.review) return false;
	if (op.error === undefined || mode === 'manual') return true;
	const deadline = readingRetryAt(op);
	return deadline !== undefined && deadline <= Date.now();
}

export async function queueReading(session: ReadingSession, input: ReadingCommand) {
	const command = input.action === 'capture' ? { ...input, intent: { ...input.intent, url: readingUrl(input.intent.url) } } : input;
	if (command.action === 'capture') {
		if (command.intent.title !== undefined && (typeof command.intent.title !== 'string' || command.intent.title.length > 1000)) throw new Error('Use a title shorter than 1,000 characters.');
	}
	if (!isReadingCommand(command)) throw new Error('Invalid Reading change. Reopen this article before editing.');
	return readingLock(async () => {
		assertReadingSession(session); const queue = await pendingReading(session);
		const previous = command.action === 'capture' ? [] : queue.filter(op => op.action !== 'capture' && op.intent.id === command.intent.id);
		if (previous.some(op => op.review)) throw new Error('Review this article’s unsynced changes in settings before editing again.');
		if (previous.length && (command.action !== 'update' || previous.some(op => op.action !== 'update'))) throw new Error('Article text is being updated. Try again after it syncs.');
		if (command.action === 'update') assertReadingUpdateBase(previous, command.intent);
		const existing = previous.at(-1);
		if (command.action === 'update' && existing && coalesceReadingUpdate(existing, command.intent)) {
			await savePendingReading(session, queue); return queue;
		}
		if (queue.length >= 200) throw new Error('Send or review pending Reading changes before adding more.');
		queue.push({ id: crypto.randomUUID(), sessionId: session.id, ...command, queuedAt: new Date().toISOString() });
		await savePendingReading(session, queue);
		return queue;
	});
}
/** Removes a change that needs review, and the edits that depend on it, while the
 * stored change still matches its reviewed export. Returns the remaining queue. */
export function removeReviewedReading(session: ReadingSession, id: string, reviewed: string): Promise<PendingReading[] | null> {
	return readingLock(async () => {
		assertReadingSession(session);
		const queue = await pendingReading(session);
		const index = queue.findIndex(op => op.id === id);
		const op = queue[index];
		if (!op?.review || JSON.stringify(op) !== reviewed) return null;
		const dependsOnRemoved = (later: PendingReading) => op.action !== 'capture' && later.action !== 'capture'
			&& later.intent.id === op.intent.id && Boolean(later.review);
		const next = queue.filter((later, position) => position !== index && !(position > index && dependsOnRemoved(later)));
		await savePendingReading(session, next);
		return next;
	});
}
export async function drainReading(session: ReadingSession, mode: ReadingRetryMode = 'automatic', canSend = () => true): Promise<ReadingCache | undefined> {
	if (!navigator.onLine || !canSend()) return undefined;
	return readingDrainLock(async () => {
		assertReadingSession(session);
		const queue = await pendingReading(session);
		if (!queue.some(op => canDispatch(op, mode))) return undefined;
		if (!canSend()) return undefined;
		const info = await readingRequest<{ day: number; generation: string }>('/reading/session', session);
		if (info.generation !== session.generation) throw new Error('Reading destination changed. Export and review pending work.');
		const confirmed = new Set<string>();
		const writes: ReadingWrite[] = [];
		let onlyEdits = true;
		for (const candidate of queue) {
			if (!canSend()) break;
			if (!canDispatch(candidate, mode)) continue;
			const op = await readingLock(async () => {
				const current = await pendingReading(session), next = current.find(entry => entry.id === candidate.id);
				if (!canSend() || !next || !canDispatch(next, mode)) return null;
				// A paused or uncertain predecessor still owns this article's base value.
				// Independent articles may proceed while dependent edits wait for settlement.
				if (next.action !== 'capture' && current.slice(0, current.indexOf(next)).some(entry =>
					entry.action !== 'capture' && entry.intent.id === next.intent.id && !confirmed.has(entry.id))) return null;
				if (!next.body) {
					next.body = JSON.stringify({ ...next.intent, operationId: createReminderOperationId(info.day) });
					// Store exact dispatch bytes and ID before making the request.
					await savePendingReading(session, current);
				}
				return next;
			});
			if (!op) continue;
			if (!canSend()) break;
			try {
				const response = await readingRequest<{ library?: unknown } | null>(`/reading/${op.action}`, session, op.body);
				confirmed.add(op.id);
				if (op.action === 'capture') onlyEdits = false;
				else writes.push({ itemId: op.intent.id, library: response?.library });
			} catch (error) {
				const review = error instanceof ReadingApiError && [400, 409, 410, 413].includes(error.status);
				await readingLock(async () => {
					const current = await pendingReading(session), failed = current.find(entry => entry.id === op.id);
					if (!failed) return;
					failed.error = error instanceof Error ? error.message : 'Save has not been confirmed. Retry when connected.';
					failed.review = review;
					failed.attempts = (failed.attempts ?? 0) + 1;
					failed.retryAt = !failed.review && (!(error instanceof ReadingApiError) || error.status >= 500 || error.status === 429)
						? Date.now() + automaticRetryDelayMs(failed.attempts) : undefined;
					// Later edits depend on the rejected value. Keep them for recovery,
					// but never send them or present them as if that value had committed.
					if (failed.review && failed.action !== 'capture') {
						for (const followUp of current.slice(current.indexOf(failed) + 1)) {
							if (followUp.action === 'capture' || followUp.intent.id !== failed.intent.id) continue;
							followUp.review = true;
							followUp.error = 'An earlier change to this article needs review. These edits are saved on this device.';
						}
					}
					await savePendingReading(session, current);
				});
				// A definite rejection holds back only this change and its dependents;
				// independent changes still send. Anything else may affect them all.
				if (review) continue;
				break;
			}
		}
		if (!confirmed.size) return undefined;
		// Confirm once for this batch before removing any durable command. Another
		// tab may have queued more work while the network requests were in flight.
		// Captures add items the cache does not have yet, so they reload the whole library.
		const cache = onlyEdits ? await reloadReadingAfterWrites(session, writes) : await loadReading(session);
		await readingLock(async () => {
			const current = await pendingReading(session);
			await savePendingReading(session, current.filter(op => !confirmed.has(op.id)));
			await pruneReadingAttempts(session).catch(() => { /* Committed changes remain settled; cleanup can retry later. */ });
		});
		return cache;
	});
}
