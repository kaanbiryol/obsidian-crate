import { decodePendingChange, pendingChangeKey } from '../pending/pending-change';
import { isAbortError } from '../abort';
import { recordDeferredChange, recordSyncError } from '../issues';
import type { Vault } from 'obsidian';
import { readLocalFileEntry } from '../local/local-file-entry';
import { classifyPath } from '../planner/reconciliation';
import { fileFailure, isVersionConflict, isVersionConflictError } from '../failures';
import { cancelSyncResult, createEmptySyncResult, finalizeSyncResult } from '../sync-result';
import { RemoteVersionChangedError } from '../transfer/download';
import type { FileDiff, SyncResult, SyncWork, UploadDiff } from '../types';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import { errorMessage } from '../../platform/logger';
import type { DiffApplyOutcome } from '../transfer/types';
import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import type { DeleteRemoteFiles } from '../transfer/delete';
import type { ConditionalDeleteCandidate } from '../transfer/delete-batches';
import { namespaceConflictLookup } from '../namespace-conflicts';

const MAX_RECONCILE_ATTEMPTS = 3;

interface TargetedManifest {
	getEntry(path: string): Readonly<FileEntry> | undefined;
	setEntry(path: string, entry: FileEntry): void;
	removeEntry(path: string): void;
	save(): Promise<void>;
}

export interface TargetedReconcileContext {
	deleteRemoteFiles: DeleteRemoteFiles;
	reportWork?(work: SyncWork): void;
	vault: Vault;
	localManifest: TargetedManifest;
	getRemoteEntries(paths: string[]): Promise<Record<string, FileEntry>>;
	shouldIgnore(path: string): boolean;
	/** Upload ordinary edits together; return paths that need fresh reconciliation. */
	uploadDiffs?(diffs: UploadDiff[], result: SyncResult): Promise<string[]>;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult,
	): Promise<DiffApplyOutcome>;
	/** Receives each file's failure with its HTTP status, so the caller can classify the result. */
	onFailure?(failure: MutationFailure): void;
}

/** Reconcile selected files or queue paths that lost a compare-and-swap race. */
export async function reconcileQueuePaths(
	context: TargetedReconcileContext,
	queueKeys: string[],
): Promise<SyncResult> {
	const result = createEmptySyncResult();
	try {
		const uniqueQueueKeys = [...new Set(queueKeys)];
		const targetPaths = [...new Set(uniqueQueueKeys.map(queueKey =>
			decodePendingChange(queueKey).path))];
		context.reportWork?.({ phase: 'server' });
		const state: ReconcileState = {
			context,
			result,
			remoteEntries: createPathRecord(await context.getRemoteEntries(targetPaths)),
			processed: 0,
			total: uniqueQueueKeys.length,
			deletions: [],
			uploads: new Map(),
			deleteCandidates: new Map(),
		};
		reportProgress(state);

		// Settle uploads and acknowledge matching server copies before deleting old
		// rename sources. Queue insertion order puts the old name first.
		for (const queueKey of uniqueQueueKeys) await reconcile(state, queueKey, 'scan');
		// The server cannot store a deleted path beside an upload in its namespace, as
		// after a case-only or Unicode-only rename, so those deletes go first.
		const uploadConflict = namespaceConflictLookup(state.uploads.keys());
		const clearing = new Set(state.deletions.filter(queueKey => uploadConflict(decodePendingChange(queueKey).path) !== undefined));
		await deleteDeferred(state, [...clearing]);
		await uploadCollected(state);
		// Upload retries may hold back further deletions, so filter only now.
		await deleteDeferred(state, state.deletions.filter(queueKey => !clearing.has(queueKey)));

		context.reportWork?.({ phase: 'saving' });
		await context.localManifest.save();
		finalizeSyncResult(result);
		return result;
	} catch (error) {
		if (isAbortError(error)) return cancelSyncResult(result);
		throw error;
	}
}

/**
 * How `reconcile` treats one queue key:
 * - `scan`: the first pass. Ordinary uploads are collected into one batch and
 *   deletions wait for the delete phase.
 * - `delete`: the delete phase. Deletions are collected into one guarded batch.
 * - `upload-retry`: a batched upload lost a race. The path applies on its own and
 *   a deletion still waits for the delete phase.
 * - `delete-retry`: a batched deletion lost a race. The path applies on its own,
 *   deletion included.
 * A retry starts at attempt 2, since the batch was the first.
 */
type ReconcileMode = 'scan' | 'delete' | 'upload-retry' | 'delete-retry';

/** One targeted reconciliation, shared by its passes. */
interface ReconcileState {
	readonly context: TargetedReconcileContext;
	readonly result: SyncResult;
	/** The server versions planned against; a retry refreshes its path. */
	readonly remoteEntries: Record<string, FileEntry>;
	/** Progress through `total` queue keys. */
	processed: number;
	readonly total: number;
	/** Queue keys whose deletion waits for the delete phase. */
	readonly deletions: string[];
	readonly uploads: Map<string, { diff: UploadDiff; keys: string[] }>;
	readonly deleteCandidates: Map<string, { file: ConditionalDeleteCandidate; keys: string[] }>;
}

/** What one attempt did with a path. */
type AttemptStep =
	/** Collected into a batch or held for the delete phase, which settles and counts it. */
	| 'handed-off'
	| 'settled'
	/** Recorded as a failure. */
	| 'failed'
	/** A newer local edit deferred the write; plan again against the current server version. */
	| 'deferred'
	/** The server version changed since it was read; plan again against the current one. */
	| 'raced';

/** Reconciles one queue key, retrying up to the attempt limit. */
async function reconcile(state: ReconcileState, queueKey: string, mode: ReconcileMode): Promise<void> {
	const { context, result } = state;
	const path = decodePendingChange(queueKey).path;
	if (context.shouldIgnore(path)) {
		result.settledKeys.push(queueKey);
		countProcessed(state, 1);
		return;
	}

	let step: AttemptStep = 'failed';
	const firstAttempt = mode === 'upload-retry' || mode === 'delete-retry' ? 2 : 1;
	for (let attempt = firstAttempt; attempt <= MAX_RECONCILE_ATTEMPTS; attempt++) {
		const canRetry = attempt < MAX_RECONCILE_ATTEMPTS;
		try {
			step = await attemptPath(state, queueKey, path, mode, canRetry);
			// A failed read after a deferred write fails only this path.
			if (step === 'deferred') await refreshRemoteEntry(context, state.remoteEntries, path);
		} catch (error) {
			if (isAbortError(error)) throw error;
			if (canRetry && isRemoteVersionChange(error)) step = 'raced';
			else {
				recordPathFailure(state, path, error);
				step = 'failed';
			}
		}
		// A failed read after a lost race stops the run, as a failed first read does.
		if (step === 'raced') await refreshRemoteEntry(context, state.remoteEntries, path);
		else if (step !== 'deferred') break;
	}

	if (step === 'handed-off') return;
	// Every failed step has recorded its path's error; one still deferred or raced has not.
	if (step !== 'settled' && step !== 'failed') {
		recordSyncError(result, `Reconciliation did not converge`, path);
	}
	countProcessed(state, 1);
}

/** Plans one path against the known server version and applies or hands off the decision.
 * `classifyPath` decides; the mode only chooses when a decision runs. */
async function attemptPath(state: ReconcileState, queueKey: string, path: string, mode: ReconcileMode, canRetry: boolean): Promise<AttemptStep> {
	const { context, result } = state;
	const localEntry = await readLocalFileEntry(context.vault, path);
	const remoteEntry = getPathEntry(state.remoteEntries, path);
	const baseEntry = context.localManifest.getEntry(path);
	const decision = classifyPath(path, localEntry, remoteEntry, baseEntry);
	if (decision?.action === 'upload' && mode === 'scan' && context.uploadDiffs) {
		const upload = state.uploads.get(path) ?? { diff: decision, keys: [] };
		upload.keys.push(queueKey);
		state.uploads.set(path, upload);
		return 'handed-off';
	}
	if (decision?.action === 'delete' && (mode === 'scan' || mode === 'upload-retry')) {
		state.deletions.push(queueKey);
		return 'handed-off';
	}
	if (decision?.action === 'delete' && mode === 'delete') {
		if (!decision.remoteHash) {
			recordPathFailure(state, path, 'Missing remote version for delete');
			return 'failed';
		}
		const candidate = state.deleteCandidates.get(path) ?? { file: { path, expectedHash: decision.remoteHash, expectedRevision: decision.remoteRevision }, keys: [] };
		candidate.keys.push(queueKey);
		state.deleteCandidates.set(path, candidate);
		return 'handed-off';
	}

	if (!decision) {
		if (localEntry && remoteEntry) {
			context.localManifest.setEntry(path, {
				...remoteEntry,
				modified: localEntry.modified,
			});
		} else {
			context.localManifest.removeEntry(path);
		}
	} else if (decision.action === 'delete') {
		if (result.errors.length > 0) {
			recordPathFailure(state, path, 'Remote deletion deferred until uploads and reconciliation finish successfully');
			return 'failed';
		}
		const [failure] = await context.deleteRemoteFiles([{ path, expectedHash: decision.remoteHash, expectedRevision: decision.remoteRevision }], result, { onVersionConflicts: async () => {} });
		if (failure) {
			const raced = isVersionConflict(failure.status, failure.code);
			if (raced && canRetry) return 'raced';
			// Deletion records every failure except the version conflicts it hands back.
			if (raced) recordSyncError(result, failure.error, path);
			context.onFailure?.(failure);
			return 'failed';
		}
	} else {
		const localFiles = createPathRecord<FileEntry>();
		if (localEntry) localFiles[path] = localEntry;
		const outcome = await context.processDiff(decision, localFiles, result);
		if (outcome.status === 'deferred' && !outcome.review) {
			if (canRetry) return 'deferred';
			recordPathFailure(state, path, outcome.reason);
			return 'failed';
		}
		// A saved review copy settles this change; the path keeps its baseline.
		if (outcome.status === 'deferred') recordDeferredChange(result, outcome, path);
	}

	result.settledKeys.push(queueKey);
	return 'settled';
}

/** Collects the deferred deletions, then sends them as one guarded batch. A deletion
 * that lost a race reconciles again on its own. */
async function deleteDeferred(state: ReconcileState, queueKeys: readonly string[]): Promise<void> {
	const { context, result, deleteCandidates } = state;
	for (const queueKey of queueKeys) await reconcile(state, queueKey, 'delete');
	if (!deleteCandidates.size) return;
	const candidates = [...deleteCandidates];
	deleteCandidates.clear();
	const retryKeys = new Set<string>();
	const failures = await context.deleteRemoteFiles(candidates.map(([, candidate]) => candidate.file), result, {
		onProcessed: count => { state.processed += count; },
		onVersionConflicts: async keys => { for (const key of keys) retryKeys.add(key); },
	});
	for (const failure of failures) context.onFailure?.(failure);
	const deleted = new Set(result.deletedPaths);
	for (const [path, candidate] of candidates) {
		if (retryKeys.has(pendingChangeKey('delete', path))) {
			if (!await refreshOrRecordFailure(state, path)) continue;
			// The batch counted this file; each retried key counts itself.
			state.processed -= 1;
			for (const key of candidate.keys) await reconcile(state, key, 'delete-retry');
		} else if (deleted.has(path)) result.settledKeys.push(...candidate.keys);
	}
}

/** Uploads the collected edits as one batch. An upload that lost a race reconciles
 * again on its own. */
async function uploadCollected(state: ReconcileState): Promise<void> {
	const { context, result, uploads } = state;
	if (!uploads.size || !context.uploadDiffs) return;
	const retryPaths = new Set(await context.uploadDiffs([...uploads.values()].map(upload => upload.diff), result));
	const uploadedPaths = new Set(result.uploadedPaths);
	for (const [path, upload] of uploads) {
		if (!retryPaths.has(path)) {
			if (uploadedPaths.has(path)) result.settledKeys.push(...upload.keys);
			countProcessed(state, upload.keys.length);
		} else if (await refreshOrRecordFailure(state, path)) {
			for (const key of upload.keys) await reconcile(state, key, 'upload-retry');
		} else countProcessed(state, upload.keys.length);
	}
}

function isRemoteVersionChange(error: unknown): boolean {
	return error instanceof RemoteVersionChangedError || isVersionConflictError(error);
}

/** Reads a path's current server version before it retries. A failed read fails the path. */
async function refreshOrRecordFailure(state: ReconcileState, path: string): Promise<boolean> {
	try {
		await refreshRemoteEntry(state.context, state.remoteEntries, path);
		return true;
	} catch (error) {
		if (isAbortError(error)) throw error;
		recordPathFailure(state, path, error);
		return false;
	}
}

function recordPathFailure(state: ReconcileState, path: string, error: unknown): void {
	recordSyncError(state.result, errorMessage(error), path);
	state.context.onFailure?.(fileFailure(path, error));
}

function reportProgress(state: ReconcileState): void {
	state.context.reportWork?.({ phase: 'applying', current: state.processed, total: state.total });
}

function countProcessed(state: ReconcileState, count: number): void {
	state.processed += count;
	reportProgress(state);
}

async function refreshRemoteEntry(
	context: Pick<TargetedReconcileContext, 'getRemoteEntries'>,
	remoteEntries: Record<string, FileEntry>,
	path: string,
): Promise<void> {
	const refreshed = await context.getRemoteEntries([path]);
	const entry = getPathEntry(refreshed, path);
	if (entry) remoteEntries[path] = entry;
	else delete remoteEntries[path];
}
