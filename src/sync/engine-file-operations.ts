import type { Vault } from 'obsidian';
import type { BatchUploadFile, RemoteFileVersion } from '../protocol/sync-types';
import { DurableUploads } from './durable-uploads';
import { DurableRestores } from './durable-restores';
import { arrayBufferToBase64 } from './encoding';
import type { LocalManifest } from './manifest';
import type { MarkdownBaseCache } from './markdown-base-cache';
import { assertRenamePreserved } from './rename-dependencies';
import type { UploadApplyPhase } from './upload-diagnostics';
import type { SyncWorkerApi } from './worker-api/sync';

/** One engine's file mutations always use its checkpoint and recovery journals. */
export function createEngineFileOperations(
	transport: SyncWorkerApi,
	manifest: LocalManifest,
	vault: Vault,
	cache: MarkdownBaseCache,
	clientSession: string,
) {
	const uploads = new DurableUploads(manifest, transport, cache, clientSession);
	const restores = new DurableRestores(manifest, transport);
	return {
		recoverUploads: (onProgress?: (current: number, total: number) => void) => uploads.recover(onProgress),
		getUploadDiagnostics: () => uploads.getDiagnostics(),
		recordMergeApplication: (path: string, hash: string, phase: UploadApplyPhase) => uploads.recordMergeApplication(path, hash, phase),
		uploadFile: (path: string, content: ArrayBuffer, hash: string, size: number, contentType: string,
			expectedHash: string | null, operationId?: string, mergePreimage?: ArrayBuffer) =>
			uploads.single({ path, content: arrayBufferToBase64(content), hash, size, contentType, expectedHash, operationId }, mergePreimage),
		batchUpload: (files: BatchUploadFile[]) => uploads.batch(files),
		async deleteFile(path: string, expectedHash: string, expectedRevision?: string) {
			await assertRenamePreserved(manifest, vault, path);
			return transport.deleteFile(path, expectedHash, expectedRevision);
		},
		async batchDelete(paths: string[], expectedHashes?: Record<string, string>, expectedRevisions?: Record<string, string>) {
			for (const path of paths) await assertRenamePreserved(manifest, vault, path);
			return transport.batchDelete(paths, expectedHashes, expectedRevisions);
		},
		downloadFile: (path: string) => transport.downloadFile(path),
		batchDownload: (paths: string[]) => transport.batchDownload(paths),
		getChanges: (since: number) => transport.getChanges(since),
		restoreFileVersion: (version: RemoteFileVersion) => restores.restore(version),
		getPendingRestores: () => restores.pending(),
		finishRestore: (storageKey: string) => restores.finish(storageKey),
	};
}

export type EngineFileOperations = ReturnType<typeof createEngineFileOperations>;
