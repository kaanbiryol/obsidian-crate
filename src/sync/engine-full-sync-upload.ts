import { errorMessage } from '../plugin/logger';
import type { FileEntry } from '../protocol/sync-types';
import { BATCH_UPLOAD_CONCURRENCY, UPLOAD_CONCURRENCY } from './engine-constants';
import { prepareUploadChunks } from './transfer-budget';
import type { UploadPreparedFilesOptions } from './transfer-upload';
import type { UploadDiff, PreparedUpload, SyncResult } from './types';
import { recordResolvedRace } from './sync-result';

export interface FullSyncUploadContext {
	prepareFullSyncUpload(diff: UploadDiff): Promise<PreparedUpload | null>;
	uploadPreparedFiles(prepared: PreparedUpload[], result: SyncResult, options: UploadPreparedFilesOptions): Promise<void>;
	getLocalManifestEntry(path: string): FileEntry | undefined;
	throwIfDestroyed(): void;
	isAbortError(error: unknown): boolean;
}

/** Bound retained bytes while using the same CAS/receipt validation as initial sync. */
export async function uploadFullSyncPlan(context: FullSyncUploadContext, diffs: UploadDiff[], localFiles: Record<string, FileEntry>, result: SyncResult, onCompleted: () => void): Promise<void> {
	const chunks = prepareUploadChunks(diffs, async diff => {
		context.throwIfDestroyed();
		try {
			const prepared = await context.prepareFullSyncUpload(diff);
			if (prepared) return prepared;
			result.errors.push(`${diff.path}: Local file changed or disappeared while preparing the upload`);
		} catch (error) {
			if (context.isAbortError(error)) throw error;
			result.errors.push(`${diff.path}: ${errorMessage(error)}`);
		}
		onCompleted();
		return null;
	});
	for await (const chunk of chunks) {
		context.throwIfDestroyed();
		await context.uploadPreparedFiles(chunk, result, {
			concurrency: UPLOAD_CONCURRENCY, batchConcurrency: BATCH_UPLOAD_CONCURRENCY, retry: false,
		});
		chunk.forEach(() => onCompleted());
	}
	const uploaded = new Set(result.uploadedPaths);
	for (const diff of diffs) {
		if (!uploaded.has(diff.path)) continue;
		const entry = context.getLocalManifestEntry(diff.path);
		if (entry) localFiles[diff.path] = entry;
		if (diff.cause === 'remote-deleted') recordResolvedRace(result, diff.path, 'kept-local-edit');
	}
}
