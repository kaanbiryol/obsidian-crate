import { isAuthFailure } from '../failures';
import { namespaceConflictLookup } from '../namespace-conflicts';

/** The server cannot store an upload beside a path its namespace still holds, as after
 * a case-only or Unicode-only rename. An upload whose clearing delete failed would only
 * be refused, so it waits for that delete. */
export function deferBlockedUploads(uploadPaths: readonly string[], failedDeletes: readonly string[]): {
	ready: string[];
	deferred: Array<{ path: string; blocking: string }>;
} {
	const blockingDelete = namespaceConflictLookup(failedDeletes);
	const ready: string[] = [];
	const deferred: Array<{ path: string; blocking: string }> = [];
	for (const path of uploadPaths) {
		const blocking = blockingDelete(path);
		if (blocking === undefined) ready.push(path);
		else deferred.push({ path, blocking });
	}
	return { ready, deferred };
}

export interface QueueDeleteOutcome {
	/** Failures so far in this flush, uploads and clearing deletes alike. */
	failures: ReadonlyArray<{ status?: number }>;
	failedUploads: ReadonlySet<string>;
	/** A version conflict sent paths to reconciliation, which reruns held-back deletes. */
	reconciling: boolean;
	/** A failure that stops automatic retries. */
	hasTerminalFailure: boolean;
}

/** Which of the remaining deletes run once the batch's uploads settle. A delete may be
 * the old name of a failed upload. Reconciliation or a retry runs held-back deletes
 * once the uploads settle; without either, they would wait for an unrelated event or
 * sync. A terminal failure gets neither, so it holds back only deletes renamed to its
 * path, never the rest of the vault. Revoked access would refuse every delete too. */
export function planQueueDeletes<T extends { path: string }>(
	deletes: readonly T[],
	outcome: QueueDeleteOutcome,
	renameDestination: (path: string) => string | undefined,
): { ready: T[]; deferred: T[] } {
	const holdAll = outcome.failures.length > 0
		&& (outcome.reconciling || !outcome.hasTerminalFailure || outcome.failures.some(failure => isAuthFailure(failure.status)));
	const ready: T[] = [];
	const deferred: T[] = [];
	for (const file of deletes) {
		const destination = renameDestination(file.path);
		if (!holdAll && (destination === undefined || !outcome.failedUploads.has(destination))) ready.push(file);
		else deferred.push(file);
	}
	return { ready, deferred };
}
