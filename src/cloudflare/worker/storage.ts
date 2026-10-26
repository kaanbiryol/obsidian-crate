import { FILE_FOLDER_MATCH, fileFolderArgs } from './sync/file-identity';
import { decodeMarkdownBytes } from '@/reminders/core/markdownEncoding';
import type { CommitEffects } from './commit-effects';
import { queryRows } from './db';
import { stageMarkdownFile } from './sync/markdown-file-staging';
import { commitStagedFile } from './sync/mutations';
import {
	getStoredFileRow,
	MAX_FILE_BYTES,
	readVerifiedBytes,
} from './sync/storage';

interface StoredTextFile {
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
			WHERE ${FILE_FOLDER_MATCH} AND lower(path) LIKE '%.md' ORDER BY path ASC`,
		).bind(...fileFolderArgs(pathPrefix)),
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
			const content = await readVerifiedBytes(bucket, row);
			return content && { path: row.path, content, hash: row.hash } satisfies StoredMarkdownFileBytes;
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

	const bytes = await readVerifiedBytes(bucket, file);
	return bytes && {
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
	const staged = await stageMarkdownFile(bucket, db, path, content, expectedHash);

	// Leave staged bytes for orphan cleanup if the transaction outcome is unknown.
	const commit = await commitStagedFile(bucket, db, {
			path,
			hash: staged.hash,
			size: staged.size,
			objectKey: staged.objectKey,
			content,
			expectedHash,
			effects,
	});
	if (!commit.committed) {
		throw new FileVersionConflictError(path, commit.currentHash);
	}

	return { hash: staged.hash, size: staged.size };
}
