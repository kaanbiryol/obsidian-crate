import type { Vault } from 'obsidian';
import type { BatchUploadFile, RemoteFileVersion } from '../../protocol/sync-types';
import { DurableUploads } from '../durability/durable-uploads';
import { DurableRestores } from '../durability/durable-restores';
import { arrayBufferToBase64 } from '@/platform/base64';
import type { LocalManifest } from '../manifest/manifest';
import type { MarkdownBaseCache } from '../merge/markdown-base-cache';
import { assertRenamesPreserved } from '../manifest/rename-dependencies';
import type { UploadApplyPhase } from '../diagnostics/upload-diagnostics';
import type { SyncWorkerApi } from '../worker-api/sync';
import { createLargeTransferGate } from '../transfer/budget';

/** One engine's file mutations always use its checkpoint and recovery journals. */
export function createEngineFileOperations(
	transport: SyncWorkerApi,
	manifest: LocalManifest,
	vault: Vault,
	cache: MarkdownBaseCache,
	clientSession: string,
	/** The largest file this device syncs with its server. */
	fileLimit: () => number,
) {
	const uploads = new DurableUploads(manifest, transport, cache, clientSession);
	const restores = new DurableRestores(manifest, transport);
	const largeTransfers = createLargeTransferGate();
	return {
		recoverUploads: (onProgress?: (current: number, total: number) => void) => uploads.recover(onProgress),
		getUploadDiagnostics: () => uploads.getDiagnostics(),
		recordMergeApplication: (path: string, hash: string, phase: UploadApplyPhase) => uploads.recordMergeApplication(path, hash, phase),
		uploadFile: (path: string, content: ArrayBuffer, hash: string, size: number, contentType: string,
			expectedHash: string | null, operationId?: string, mergePreimage?: ArrayBuffer) =>
			largeTransfers(size, () => !mergePreimage && transport.usesChunkedUpload(path, size)
				? uploads.chunked({ path, hash, size, contentType, expectedHash, operationId }, content)
				: uploads.single({ path, content: arrayBufferToBase64(content), hash, size, contentType, expectedHash, operationId }, mergePreimage, content)),
		batchUpload: (files: BatchUploadFile[]) => uploads.batch(files),
		async batchDelete(paths: string[], expectedHashes?: Record<string, string>, expectedRevisions?: Record<string, string>) {
			await assertRenamesPreserved(manifest, vault, paths, fileLimit());
			return transport.batchDelete(paths, expectedHashes, expectedRevisions);
		},
		downloadFile: (path: string, size?: number) => largeTransfers(size, () => transport.downloadFile(path, size)),
		batchDownload: (paths: string[]) => transport.batchDownload(paths),
		batchLimits: () => transport.batchLimits(),
		getChanges: (since: number) => transport.getChanges(since),
		restoreFileVersion: (version: RemoteFileVersion) => restores.restore(version),
		getPendingRestores: () => restores.pending(),
		finishRestore: (storageKey: string) => restores.finish(storageKey),
	};
}

export type EngineFileOperations = ReturnType<typeof createEngineFileOperations>;
