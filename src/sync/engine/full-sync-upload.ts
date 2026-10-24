import { recordSyncError } from '../issues';
import { errorMessage } from '../../platform/logger';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import type { UploadPreparedFilesOptions } from '../transfer/upload';
import { uploadPipelined } from '../transfer/upload-pipeline';
import type { UploadDiff, PreparedUpload, SyncResult } from '../types';
import { recordResolvedRace } from '../sync-result';
import { isAbortError } from '../abort';

export interface FullSyncUploadContext {
	reportWork?(phase: import('../types').SyncWork['phase'], current?: number, total?: number): void;
	prepareFullSyncUpload(diff: UploadDiff): Promise<PreparedUpload | null>;
	uploadPreparedFiles(prepared: PreparedUpload[], result: SyncResult, options: UploadPreparedFilesOptions): Promise<void>;
	reconcileVersionConflicts?(paths: string[], result: SyncResult): Promise<void>;
	getLocalManifestEntry(path: string): Readonly<FileEntry> | undefined;
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
		...(context.reconcileVersionConflicts ? { onVersionConflicts: async (paths: string[], syncResult: SyncResult) => {
			await context.reconcileVersionConflicts!(paths, syncResult);
			// Full sync saves this snapshot later; retain the reconciled baseline.
			for (const path of paths) {
				const entry = context.getLocalManifestEntry(path);
				if (entry) localFiles[path] = entry;
				else delete localFiles[path];
			}
		} } : {}),
		beforeChunk: () => {
			context.throwIfDestroyed();
			context.reportWork?.('uploading', processed, diffs.length);
		},
		onProcessed: count => {
			processed += count;
			context.reportWork?.('uploading', processed, diffs.length);
			for (let index = 0; index < count; index++) onCompleted();
		},
		afterChunk: unreported => {
			for (let index = 0; index < unreported; index++) { processed++; onCompleted(); }
			context.reportWork?.('uploading', processed, diffs.length);
		},
	});
	const uploaded = new Set(result.uploadedPaths);
	for (const diff of diffs) {
		if (!uploaded.has(diff.path)) continue;
		const entry = context.getLocalManifestEntry(diff.path);
		if (entry) localFiles[diff.path] = entry;
		if (diff.cause === 'remote-deleted') recordResolvedRace(result, diff.path, 'kept-local-edit');
	}
	return failures;
}
