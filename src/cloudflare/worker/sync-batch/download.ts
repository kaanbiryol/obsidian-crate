import { corsResponse } from '../cors';
import { parseJsonObject, sanitizePath } from '../utils';
import {
	loadStoredFileRows,
	MAX_BATCH_DOWNLOAD_BYTES,
	MAX_BATCH_DOWNLOAD_FILES,
	storedObjectMatchesMetadata,
	type FileStorageRow,
} from '../sync-storage';

export async function handleBatchDownload(
	request: Request,
	bucket: R2Bucket,
	db: D1Database,
): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}
	const rawPaths = parsedBody.value.paths;
	if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > MAX_BATCH_DOWNLOAD_FILES) {
		return corsResponse({ error: `paths array required (maximum ${MAX_BATCH_DOWNLOAD_FILES})` }, 400);
	}
	if (!rawPaths.every((path) => typeof path === 'string' && path.length <= 4096)) {
		return corsResponse({ error: 'Invalid path in batch' }, 400);
	}
	const paths = rawPaths as string[];
	if (new Set(paths).size !== paths.length) {
		return corsResponse({ error: 'Duplicate paths are not allowed' }, 400);
	}

	let storedFiles = new Map<string, FileStorageRow>();
	try {
		storedFiles = await loadStoredFileRows(db, paths);
		const declaredTotal = Array.from(storedFiles.values())
			.reduce((total, file) => total + file.size, 0);
		if (declaredTotal > MAX_BATCH_DOWNLOAD_BYTES) {
			return corsResponse({ error: 'Batch download exceeds 8MB limit; download files individually' }, 413);
		}
	} catch {
		return corsResponse({ error: 'Sync metadata unavailable' }, 503);
	}

	const files: Array<{
		path: string;
		content: string;
		hash: string;
		size: number;
		contentType: string;
		revision?: string;
		error?: string;
	}> = [];
	let totalBytes = 0;
	for (const rawPath of paths) {
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			files.push({ path: rawPath, content: '', hash: '', size: 0, contentType: '', error: 'Invalid path' });
			continue;
		}

		try {
			const storedFile = storedFiles.get(safePath) ?? null;
			const objectKey = storedFile?.storageKey ?? null;
			if (!objectKey) {
				files.push({ path: safePath, content: '', hash: '', size: 0, contentType: '', error: 'File not found' });
				continue;
			}

			const object = await bucket.get(objectKey);
			if (!object) {
				files.push({
					path: safePath,
					content: '',
					hash: '',
					size: 0,
					contentType: '',
					error: 'File content unavailable',
				});
				continue;
			}
			if (storedFile && !storedObjectMatchesMetadata(object, storedFile)) {
				files.push({
					path: safePath,
					content: '',
					hash: storedFile.hash,
					size: storedFile.size,
					contentType: '',
					error: 'File content failed integrity validation',
				});
				continue;
			}

			totalBytes += object.size;
			if (totalBytes > MAX_BATCH_DOWNLOAD_BYTES) {
				return corsResponse({ error: 'Batch download exceeds 8MB limit; download files individually' }, 413);
			}

			const arrayBuffer = await object.arrayBuffer();
			const bytes = new Uint8Array(arrayBuffer);
			const chunkSize = 8192;
			let binary = '';
			for (let i = 0; i < bytes.length; i += chunkSize) {
				const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
				binary += String.fromCharCode(...chunk);
			}

			files.push({
				path: safePath,
				content: btoa(binary),
				revision: storedFile?.storageKey,
				hash: storedFile?.hash || object.customMetadata?.hash || '',
				size: object.size,
				contentType: object.httpMetadata?.contentType || 'application/octet-stream',
			});
		} catch (error: unknown) {
			files.push({
				path: safePath,
				content: '',
				hash: '',
				size: 0,
				contentType: '',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return corsResponse({ files });
}
