import { isMarkdownPath } from './markdown-base-cache';
import type { PreparedUpload } from '../plugin/types';
import type { QueueFlushContext, QueueOperations } from './queue-flush-types';

export async function prepareQueueOperations(
	context: QueueFlushContext,
	paths: string[],
): Promise<QueueOperations> {
	const uploads: PreparedUpload[] = [];
	const deletes: QueueOperations['deletes'] = [];

	for (const path of paths) {
		if (path.startsWith('delete:')) {
			const deletedPath = path.substring(7);
			const expectedHash = context.localManifest.getEntry?.(deletedPath)?.hash;
			if (expectedHash) {
				deletes.push({ path: deletedPath, expectedHash });
			}
			continue;
		}

		const upload = await context.prepareUploadFromPath(path);
		if (upload) {
			uploads.push(upload);
		}
	}

	return { uploads, deletes };
}

export async function uploadPendingFiles(
	context: QueueFlushContext,
	uploads: PreparedUpload[],
	completedQueueKeys: Set<string>,
	uploadConcurrency: number,
): Promise<void> {
	const uploadTasks = uploads.map(upload => async () => {
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
			size: upload.size,
			modified: await context.getModifiedIso(upload.path, upload.mtime),
		});
		if (isMarkdownPath(upload.path)) {
			await context.markdownBaseCache?.putBase(upload.path, upload.hash, upload.content);
		}
		completedQueueKeys.add(upload.path);
	});

	await context.runConcurrent(uploadTasks, uploadConcurrency);
}
