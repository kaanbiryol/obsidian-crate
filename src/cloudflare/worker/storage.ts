import { sha256HexBytes } from './auth';
import { initDb, maybePruneChangelog, queryRows } from './db';

const FILES_PREFIX = 'files/';
const MANAGED_FILES_PREFIX = '__crate__/files/';

interface FileStorageRow {
	storageKey: string | null;
}

function legacyObjectKey(path: string): string {
	return FILES_PREFIX + path;
}

function createManagedObjectKey(hash: string): string {
	return `${MANAGED_FILES_PREFIX}${hash}/${crypto.randomUUID()}`;
}

function normalizeStorageKey(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function resolveObjectKey(path: string, storageKey: string | null): string {
	return storageKey ?? legacyObjectKey(path);
}

function collectCleanupKeys(path: string, previousFile: FileStorageRow | null, preserve?: string): string[] {
	const keys = new Set<string>();
	const legacyKey = legacyObjectKey(path);
	if (legacyKey !== preserve) {
		keys.add(legacyKey);
	}

	if (previousFile) {
		const previousKey = resolveObjectKey(path, previousFile.storageKey);
		if (previousKey !== preserve) {
			keys.add(previousKey);
		}
	}

	return Array.from(keys);
}

async function deleteBucketObjectsQuietly(bucket: R2Bucket, keys: string[]): Promise<void> {
	const uniqueKeys = Array.from(new Set(keys.filter((key) => key.length > 0)));
	await Promise.allSettled(uniqueKeys.map((key) => bucket.delete(key)));
}

async function getStoredFileRow(db: D1Database, path: string): Promise<FileStorageRow | null> {
	const row = await db.prepare('SELECT storage_key FROM files WHERE path = ?')
		.bind(path)
		.first<{ storage_key?: string | null }>();
	if (!row) {
		return null;
	}

	return {
		storageKey: normalizeStorageKey(row.storage_key),
	};
}

async function resolveCommittedObjectKey(db: D1Database, path: string): Promise<string | null> {
	const row = await getStoredFileRow(db, path);
	if (!row) {
		return null;
	}

	return resolveObjectKey(path, row.storageKey);
}

export interface StoredTextFile {
	path: string;
	content: string;
}

export async function listStoredMarkdownFilesByPrefix(
	bucket: R2Bucket,
	db: D1Database,
	pathPrefix: string,
): Promise<StoredTextFile[]> {
	await initDb(db);
	const rows = await queryRows<{ path: string }>(
		db.prepare(
			"SELECT path FROM files WHERE path LIKE ? ESCAPE '\\' AND lower(path) LIKE '%.md' ORDER BY path ASC",
		).bind(`${pathPrefix}/%`),
	);

	const decoder = new TextDecoder();
	const files = await Promise.all(rows.map(async (row) => {
		const objectKey = await resolveCommittedObjectKey(db, row.path);
		if (!objectKey) {
			return null;
		}

		const object = await bucket.get(objectKey);
		if (!object) {
			return null;
		}

		const content = decoder.decode(await object.arrayBuffer());
		return {
			path: row.path,
			content,
		} satisfies StoredTextFile;
	}));

	return files.filter((file): file is StoredTextFile => file !== null);
}

export async function readCommittedMarkdownFile(
	bucket: R2Bucket,
	db: D1Database,
	path: string,
): Promise<string | null> {
	await initDb(db);
	const objectKey = await resolveCommittedObjectKey(db, path);
	if (!objectKey) {
		return null;
	}

	const object = await bucket.get(objectKey);
	if (!object) {
		return null;
	}

	return new TextDecoder().decode(await object.arrayBuffer());
}

export async function writeCommittedMarkdownFile(
	bucket: R2Bucket,
	db: D1Database,
	path: string,
	content: string,
): Promise<{ hash: string; size: number }> {
	await initDb(db);
	const previousFile = await getStoredFileRow(db, path);
	const bytes = new TextEncoder().encode(content);
	const hash = await sha256HexBytes(bytes.buffer);
	const size = bytes.byteLength;
	const objectKey = createManagedObjectKey(hash);

	await bucket.put(objectKey, bytes, {
		httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
		customMetadata: { hash },
	});

	try {
		await db.batch([
			db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)')
				.bind(path, 'put', hash, size),
			db.prepare("INSERT OR REPLACE INTO files (path, hash, size, modified, storage_key) VALUES (?, ?, ?, datetime('now'), ?)")
				.bind(path, hash, size, objectKey),
		]);
		await maybePruneChangelog(db);
	} catch (error) {
		await deleteBucketObjectsQuietly(bucket, [objectKey]);
		throw error;
	}

	await deleteBucketObjectsQuietly(bucket, collectCleanupKeys(path, previousFile, objectKey));
	return { hash, size };
}
