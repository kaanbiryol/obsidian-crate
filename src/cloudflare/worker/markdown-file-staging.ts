import { trackStagedUpload } from './staged-uploads';
import { sha256HexBytes } from './auth';
import { createManagedObjectKey, MAX_FILE_BYTES } from './sync-storage';

export interface StagedMarkdownFile {
	path: string;
	hash: string;
	size: number;
	objectKey: string;
	expectedHash: string | null;
}

export async function stageMarkdownFile(
	bucket: R2Bucket,
  db: D1Database,
	path: string,
	content: string,
	expectedHash: string | null,
): Promise<StagedMarkdownFile> {
	const bytes = new TextEncoder().encode(content);
	if (bytes.byteLength > MAX_FILE_BYTES) {
		throw new Error('Reminder file exceeds 25MB limit');
	}
	const hash = await sha256HexBytes(bytes.buffer);
	const objectKey = createManagedObjectKey(hash);
	await trackStagedUpload(db, objectKey);
	await bucket.put(objectKey, bytes, {
		httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
		customMetadata: { hash },
	});
	return { path, hash, size: bytes.byteLength, objectKey, expectedHash };
}
