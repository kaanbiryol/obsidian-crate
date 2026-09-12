import { decodeMarkdownBytes } from '@/reminders/core/markdownEncoding';
import type { CommitEffects } from './commit-effects';
import { sha256HexBytes } from './auth';
import { queryRows } from './db';
import { stageMarkdownFile } from './markdown-file-staging';
import { commitStagedFile } from './sync-mutations';
import {
	getStoredFileRow,
	MAX_FILE_BYTES,
} from './sync-storage';

export interface StoredTextFile {
	path: string;
	content: string;
	hash: string;
}

interface StoredMarkdownFileBytes extends Omit<StoredTextFile, 'content'> {
	content: ArrayBuffer;
}

export interface StoredMarkdownFileMetadata {
	path: string;
	hash: string;
	size: number;
	storageKey: string;
}

export class FileVersionConflictError extends Error {
	constructor(readonly path: string, readonly currentHash: string | null) {
		super(`Remote file changed while editing: ${path}`);
		this.name = 'FileVersionConflictError';
	}
}

export async function listStoredMarkdownFileMetadataByPrefix(
	db: D1Database,
	pathPrefix: string,
): Promise<StoredMarkdownFileMetadata[]> {
	const rows = await queryRows<{ path: string; hash: string; size: number; storage_key: string }>(
		db.prepare(
			`SELECT path, hash, size, storage_key FROM files
			WHERE path >= ? AND path < ? AND lower(path) LIKE '%.md' ORDER BY path ASC`,
		).bind(`${pathPrefix}/`, `${pathPrefix}0`),
	);
	return rows.map((row) => ({
		path: row.path,
		hash: row.hash,
		size: row.size,
		storageKey: row.storage_key,
	}));
}

export async function readStoredMarkdownFiles(
	bucket: R2Bucket,
	rows: StoredMarkdownFileMetadata[],
): Promise<StoredMarkdownFileBytes[]> {
	const files: Array<StoredMarkdownFileBytes | null> = [];
	for (let index = 0; index < rows.length; index += 6) {
		const chunk = rows.slice(index, index + 6);
		files.push(...await Promise.all(chunk.map(async (row) => {
			if (row.size > MAX_FILE_BYTES) return null;
			const objectKey = row.storageKey;
			const object = await bucket.get(objectKey);
			if (!object || (row.size > 0 && object.size !== row.size)) return null;

			const bytes = await object.arrayBuffer();
			if (await sha256HexBytes(bytes) !== row.hash) return null;
			return {
				path: row.path,
				content: bytes,
				hash: row.hash,
			} satisfies StoredMarkdownFileBytes;
		})));
	}

	return files.filter((file): file is StoredMarkdownFileBytes => file !== null);
}

export async function readCommittedMarkdownFileVersion(
	bucket: R2Bucket,
	db: D1Database,
	path: string,
): Promise<{ content: string; hash: string } | null> {
	const file = await getStoredFileRow(db, path);
	if (!file) {
		return null;
	}

	const objectKey = file.storageKey;
	const object = await bucket.get(objectKey);
	if (!object || (file.size > 0 && object.size !== file.size)) {
		return null;
	}

	const bytes = await object.arrayBuffer();
	if (await sha256HexBytes(bytes) !== file.hash) {
		return null;
	}

	return {
		content: decodeMarkdownBytes(bytes),
		hash: file.hash,
	};
}

export async function writeCommittedMarkdownFile(
	bucket: R2Bucket,
	db: D1Database,
	path: string,
	content: string,
	expectedHash: string | null,
	effects?: CommitEffects,
): Promise<{ hash: string; size: number }> {
	const previousFile = await getStoredFileRow(db, path);
	const staged = await stageMarkdownFile(bucket, db, path, content, expectedHash);

	// Leave staged bytes for orphan cleanup if the transaction outcome is unknown.
	const commit = await commitStagedFile(bucket, db, {
			path,
			hash: staged.hash,
			size: staged.size,
			objectKey: staged.objectKey,
			content,
			expectedHash,
			previousFile,
			effects,
	});
	if (!commit.committed) {
		throw new FileVersionConflictError(path, commit.currentHash);
	}

	return { hash: staged.hash, size: staged.size };
}
