import { trackUploadLease } from './staging/upload-leases';
import { ENCRYPTED_FILE_CONTENT_TYPE, fileTransportLimit } from '../../../encryption/file-format';
import { createManagedObjectKey } from '../../../protocol/storage-keys';
import { sha256Hex } from '../../../platform/sha256';

export interface StagedMarkdownFile {
	path: string;
	hash: string;
	size: number;
	objectKey: string;
	/** The upload lease that names `objectKey`. */
	leaseId: string;
	expectedHash: string | null;
	expectedRevision?: string;
	/** Set by the committer: the `descriptor` column of an encrypted file. */
	descriptor?: string | null;
}

/** Stage server-written notes under one lease: every key is leased before any R2 put.
 * A put that fails leaves its key, and any not yet put, leased for cleanup. */
export async function stageMarkdownFiles(
	bucket: R2Bucket,
	db: D1Database,
	files: ReadonlyArray<{ path: string; content: string; expectedHash: string | null }>,
	encrypted = false,
): Promise<StagedMarkdownFile[]> {
	const contentType = encrypted ? ENCRYPTED_FILE_CONTENT_TYPE : 'text/markdown; charset=utf-8';
	const prepared = await Promise.all(files.map(async file => {
		const bytes = new TextEncoder().encode(file.content);
		if (bytes.byteLength > fileTransportLimit(contentType)) {
			throw new Error('Reminder file exceeds 25MB limit');
		}
		const hash = await sha256Hex(bytes.buffer);
		return { ...file, bytes, hash, objectKey: createManagedObjectKey(hash) };
	}));
	const { id: leaseId } = await trackUploadLease(db, prepared.map(file => ({ storageKey: file.objectKey, path: file.path })), { encrypted });
	const staged: StagedMarkdownFile[] = [];
	for (const file of prepared) {
		await bucket.put(file.objectKey, file.bytes, {
			httpMetadata: { contentType },
			customMetadata: { hash: file.hash },
		});
		staged.push({ path: file.path, hash: file.hash, size: file.bytes.byteLength, objectKey: file.objectKey, leaseId, expectedHash: file.expectedHash });
	}
	return staged;
}

export async function stageMarkdownFile(
	bucket: R2Bucket,
	db: D1Database,
	path: string,
	content: string,
	expectedHash: string | null,
	encrypted = false,
): Promise<StagedMarkdownFile> {
	return (await stageMarkdownFiles(bucket, db, [{ path, content, expectedHash }], encrypted))[0]!;
}
