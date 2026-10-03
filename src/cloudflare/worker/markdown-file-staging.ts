import { trackStagedUpload } from './staged-uploads';
import { sha256HexBytes } from './auth';
import { createManagedObjectKey } from './sync-storage';
import { ENCRYPTED_FILE_CONTENT_TYPE, fileTransportLimit } from '../../encryption/file-format';

export interface StagedMarkdownFile {
	path: string;
	hash: string;
	size: number;
	objectKey: string;
	expectedHash: string | null;
	expectedRevision?: string;
}

export async function stageMarkdownFile(
	bucket: R2Bucket,
  db: D1Database,
	path: string,
	content: string,
	expectedHash: string | null,
	encrypted = false,
): Promise<StagedMarkdownFile> {
	const bytes = new TextEncoder().encode(content);
	const contentType = encrypted ? ENCRYPTED_FILE_CONTENT_TYPE : 'text/markdown; charset=utf-8';
	if (bytes.byteLength > fileTransportLimit(contentType)) {
		throw new Error('Reminder file exceeds 25MB limit');
	}
	const hash = await sha256HexBytes(bytes.buffer);
	const objectKey = createManagedObjectKey(hash);
	await trackStagedUpload(db, objectKey, path, contentType === ENCRYPTED_FILE_CONTENT_TYPE);
	await bucket.put(objectKey, bytes, {
		httpMetadata: { contentType },
		customMetadata: { hash },
	});
	return { path, hash, size: bytes.byteLength, objectKey, expectedHash };
}
