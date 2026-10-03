import { recordSyncError } from './issues';
import { errorMessage } from '../plugin/logger';
import type { FileEntry } from '../protocol/sync-types';
import { BATCH_UPLOAD_CONCURRENCY, UPLOAD_CONCURRENCY } from './engine-constants';
import { pipelineUploadChunks } from './transfer-budget';
import type { UploadPreparedFilesOptions } from './transfer-upload';
import type { UploadDiff, PreparedUpload, SyncResult } from './types';
import { recordResolvedRace } from './sync-result';

export interface FullSyncUploadContext {
	reportWork?(phase: import('./types').SyncWork['phase'], current?: number, total?: number): void;
	prepareFullSyncUpload(diff: UploadDiff): Promise<PreparedUpload | null>;
	uploadPreparedFiles(prepared: PreparedUpload[], result: SyncResult, options: UploadPreparedFilesOptions): Promise<void>;
	reconcileVersionConflicts?(paths: string[], result: SyncResult): Promise<void>;
	getLocalManifestEntry(path: string): FileEntry | undefined;
	throwIfDestroyed(): void;
	isAbortError(error: unknown): boolean;
}

/** Bound retained bytes while using the same CAS/receipt validation as initial sync. */
export async function uploadFullSyncPlan(context: FullSyncUploadContext, diffs: UploadDiff[], localFiles: Record<string, FileEntry>, result: SyncResult, onCompleted: () => void): Promise<void> {
	let processed = 0;
	const chunks = pipelineUploadChunks(diffs, async diff => {
		context.throwIfDestroyed();
		try {
			const prepared = await context.prepareFullSyncUpload(diff);
			if (prepared) return prepared;
			recordSyncError(result, `Local file changed or disappeared while preparing the upload`, diff.path);
		} catch (error) {
			if (context.isAbortError(error)) throw error;
			recordSyncError(result, `${errorMessage(error)}`, diff.path);
		}
		processed++;
		onCompleted();
		return null;
	});
	for await (const chunk of chunks) {
		context.throwIfDestroyed();
		let reported = 0;
		context.reportWork?.('uploading', processed, diffs.length);
		await context.uploadPreparedFiles(chunk, result, {
			...(context.reconcileVersionConflicts ? { onVersionConflicts: async (paths: string[], syncResult: SyncResult) => {
				await context.reconcileVersionConflicts!(paths, syncResult);
				// Full sync saves this snapshot later; retain the reconciled baseline.
				for (const path of paths) {
					const entry = context.getLocalManifestEntry(path);
					if (entry) localFiles[path] = entry;
					else delete localFiles[path];
				}
			} } : {}),
			onProcessed: (count) => {
				reported += count;
				processed += count;
				context.reportWork?.('uploading', processed, diffs.length);
				for (let index = 0; index < count; index++) onCompleted();
			},
			concurrency: UPLOAD_CONCURRENCY, batchConcurrency: BATCH_UPLOAD_CONCURRENCY, retry: false,
		});
		for (let index = reported; index < chunk.length; index++) { processed++; onCompleted(); }
		context.reportWork?.('uploading', processed, diffs.length);
	}
	const uploaded = new Set(result.uploadedPaths);
	for (const diff of diffs) {
		if (!uploaded.has(diff.path)) continue;
		const entry = context.getLocalManifestEntry(diff.path);
		if (entry) localFiles[diff.path] = entry;
		if (diff.cause === 'remote-deleted') recordResolvedRace(result, diff.path, 'kept-local-edit');
	}
}
