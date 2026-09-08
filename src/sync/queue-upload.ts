import { isMarkdownPath } from './markdown-base-cache';
import type { PreparedUpload } from './types';
import type { QueueFlushContext, QueueUploadFailure } from './queue-flush-types';
import { HttpError } from './api';
import { errorMessage } from '../plugin/logger';
import { isAbortError } from './abort';

export async function uploadPendingFiles(
	context: QueueFlushContext,
	uploads: PreparedUpload[],
	completedQueueKeys: Set<string>,
	uploadConcurrency: number,
): Promise<QueueUploadFailure[]> {
	const uploadTasks = uploads.map(upload => async () => {
		try {
			const result = await context.api.uploadFile(
				upload.path,
				upload.content,
				upload.hash,
				upload.size,
				upload.contentType || 'application/octet-stream',
				upload.expectedHash ?? null,
			);
			if (!result.success) {
				throw new Error(result.error || `Upload failed: ${upload.path}`);
			}
			if (result.hash && result.hash !== upload.hash) {
				throw new Error(`Hash mismatch after upload for ${upload.path}`);
			}

			context.localManifest.setEntry(upload.path, {
				hash: upload.hash,
				revision: result.revision,
				size: upload.size,
				modified: await context.getModifiedIso(upload.path, upload.mtime),
			});
			if (isMarkdownPath(upload.path)) {
				await context.markdownBaseCache?.putBase(upload.path, upload.hash, upload.content);
			}
			completedQueueKeys.add(upload.path);
			return null;
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			return {
				path: upload.path,
				error: errorMessage(error),
				...(error instanceof HttpError ? { status: error.status, code: error.code } : {}),
			};
		}
	});

	const failures = await context.runConcurrent(uploadTasks, uploadConcurrency);
	return failures.filter((failure): failure is QueueUploadFailure => failure !== null);
}
