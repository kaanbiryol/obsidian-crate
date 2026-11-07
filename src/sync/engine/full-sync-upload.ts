import { recordSyncError } from '../issues';
import { errorMessage } from '../../platform/logger';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import type { UploadPreparedFilesOptions } from '../transfer/upload';
import { uploadPipelined } from '../transfer/upload-pipeline';
import type { UploadDiff, PreparedUpload, SyncResult, SyncWork } from '../types';
import { decodePendingChange, type PendingKey } from '../pending/pending-change';
import { recordResolvedRace } from '../sync-result';
import { isAbortError } from '../abort';
import type { LocalManifest } from '../manifest/manifest';

export interface FullSyncUploadContext {
	reportWork?(work: SyncWork): void;
	prepareFullSyncUpload(diff: UploadDiff): Promise<PreparedUpload | null>;
	uploadPreparedFiles(prepared: PreparedUpload[], result: SyncResult, options: UploadPreparedFilesOptions): Promise<void>;
	reconcileVersionConflicts?(keys: PendingKey[], result: SyncResult): Promise<void>;
	localManifest: Pick<LocalManifest, 'getEntry'>;
	throwIfDestroyed(): void;
}

/** Bound retained bytes while using the same CAS/receipt validation as initial sync.
 * Returns the upload failures, which carry their HTTP status. */
export async function uploadFullSyncPlan(context: FullSyncUploadContext, diffs: UploadDiff[], localFiles: Record<string, FileEntry>, result: SyncResult, onCompleted: () => void): Promise<MutationFailure[]> {
	let processed = 0;
	const failures: MutationFailure[] = [];
	await uploadPipelined(context, diffs, result, {
		prepare: async diff => {
			context.throwIfDestroyed();
			try {
				const prepared = await context.prepareFullSyncUpload(diff);
				if (prepared) return prepared;
				recordSyncError(result, `Local file changed or disappeared while preparing the upload`, diff.path);
			} catch (error) {
				if (isAbortError(error)) throw error;
				recordSyncError(result, `${errorMessage(error)}`, diff.path);
			}
			processed++;
			onCompleted();
			return null;
		},
		retry: false,
		onFailure: failure => { failures.push(failure); },
		...(context.reconcileVersionConflicts ? { onVersionConflicts: async (keys: PendingKey[], syncResult: SyncResult) => {
			await context.reconcileVersionConflicts!(keys, syncResult);
			// Full sync saves this snapshot later; retain the reconciled baseline.
			for (const { path } of keys.map(decodePendingChange)) {
				const entry = context.localManifest.getEntry(path);
				if (entry) localFiles[path] = entry;
				else delete localFiles[path];
			}
		} } : {}),
		beforeChunk: () => {
			context.throwIfDestroyed();
			context.reportWork?.({ phase: 'uploading', current: processed, total: diffs.length });
		},
		onProcessed: count => {
			processed += count;
			context.reportWork?.({ phase: 'uploading', current: processed, total: diffs.length });
			for (let index = 0; index < count; index++) onCompleted();
		},
		afterChunk: unreported => {
			for (let index = 0; index < unreported; index++) { processed++; onCompleted(); }
			context.reportWork?.({ phase: 'uploading', current: processed, total: diffs.length });
		},
	});
	const uploaded = new Set(result.uploadedPaths);
	for (const diff of diffs) {
		if (!uploaded.has(diff.path)) continue;
		const entry = context.localManifest.getEntry(diff.path);
		if (entry) localFiles[diff.path] = entry;
		if (diff.cause === 'remote-deleted') recordResolvedRace(result, diff.path, 'kept-local-edit');
	}
	return failures;
}
