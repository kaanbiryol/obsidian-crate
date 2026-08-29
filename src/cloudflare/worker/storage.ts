import { sha256HexBytes } from './auth';
import { initDb, queryRows } from './db';
import { commitFileDelete, commitStagedFile } from './sync-mutations';
import {
	createManagedObjectKey,
	deleteBucketObjectsQuietly,
	getStoredFileRow,
	MAX_FILE_BYTES,
	resolveStoredObjectKey,
} from './sync-storage';

function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface StoredTextFile {
	path: string;
	content: string;
	hash: string;
}

export class FileVersionConflictError extends Error {
	constructor(readonly path: string, readonly currentHash: string | null) {
		super(`Remote file changed while editing: ${path}`);
		this.name = 'FileVersionConflictError';
	}
}

export async function listStoredMarkdownFilesByPrefix(
	bucket: R2Bucket,
	db: D1Database,
	pathPrefix: string,
): Promise<StoredTextFile[]> {
	await initDb(db);
	const rows = await queryRows<{ path: string; hash: string; size: number; storage_key?: string | null }>(
		db.prepare(
			"SELECT path, hash, size, storage_key FROM files WHERE path LIKE ? ESCAPE '\\' AND lower(path) LIKE '%.md' ORDER BY path ASC",
		).bind(`${escapeLikePattern(pathPrefix)}/%`),
	);

	const decoder = new TextDecoder();
	const files: Array<StoredTextFile | null> = [];
	for (let index = 0; index < rows.length; index += 8) {
		const chunk = rows.slice(index, index + 8);
		files.push(...await Promise.all(chunk.map(async (row) => {
			if (row.size > MAX_FILE_BYTES) return null;
			const objectKey = resolveStoredObjectKey(row.path, row.storage_key ?? null);
			const object = await bucket.get(objectKey);
			if (!object || (row.size > 0 && object.size !== row.size)) return null;

			const bytes = await object.arrayBuffer();
			if (await sha256HexBytes(bytes) !== row.hash) return null;
			const content = decoder.decode(bytes);
			return {
				path: row.path,
				content,
				hash: row.hash,
			} satisfies StoredTextFile;
		})));
	}

	return files.filter((file): file is StoredTextFile => file !== null);
}

export async function readCommittedMarkdownFileVersion(
	bucket: R2Bucket,
	db: D1Database,
	path: string,
): Promise<{ content: string; hash: string } | null> {
	await initDb(db);
	const file = await getStoredFileRow(db, path);
	if (!file) {
		return null;
	}

	const objectKey = resolveStoredObjectKey(path, file.storageKey);
	const object = await bucket.get(objectKey);
	if (!object || (file.size > 0 && object.size !== file.size)) {
		return null;
	}

	const bytes = await object.arrayBuffer();
	if (await sha256HexBytes(bytes) !== file.hash) {
		return null;
	}

	return {
		content: new TextDecoder().decode(bytes),
		hash: file.hash,
	};
}

export async function writeCommittedMarkdownFile(
	bucket: R2Bucket,
	db: D1Database,
	path: string,
	content: string,
	expectedHash: string | null,
): Promise<{ hash: string; size: number }> {
	await initDb(db);
	const previousFile = await getStoredFileRow(db, path);
	const bytes = new TextEncoder().encode(content);
	const hash = await sha256HexBytes(bytes.buffer);
	const size = bytes.byteLength;
	if (size > MAX_FILE_BYTES) {
		throw new Error('Reminder file exceeds 25MB limit');
	}
	const objectKey = createManagedObjectKey(hash);

	await bucket.put(objectKey, bytes, {
		httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
		customMetadata: { hash },
	});

	try {
		const commit = await commitStagedFile(bucket, db, {
			path,
			hash,
			size,
			objectKey,
			expectedHash,
			previousFile,
		});
		if (!commit.committed) {
			throw new FileVersionConflictError(path, commit.currentHash);
		}
	} catch (error) {
		if (!(error instanceof FileVersionConflictError)) {
			await deleteBucketObjectsQuietly(bucket, [objectKey]);
		}
		throw error;
	}

	return { hash, size };
}

export async function deleteCommittedMarkdownFile(
	bucket: R2Bucket,
	db: D1Database,
	path: string,
	expectedHash: string,
): Promise<void> {
	await initDb(db);
	const previousFile = await getStoredFileRow(db, path);
	const commit = await commitFileDelete(bucket, db, {
		path,
		expectedHash,
		previousFile,
	});
	if (!commit.committed) {
		throw new FileVersionConflictError(path, commit.currentHash);
	}
}
