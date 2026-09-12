import { changedRows, queryRows } from './db';
import { findReferencedStorageKeys } from './storage-references';
export {
	BATCH_DELETE_MAX_FILES as MAX_BATCH_DELETE_FILES,
	BATCH_DOWNLOAD_MAX_BYTES as MAX_BATCH_DOWNLOAD_BYTES,
	BATCH_DOWNLOAD_MAX_FILES as MAX_BATCH_DOWNLOAD_FILES,
	BATCH_UPLOAD_MAX_BYTES as MAX_BATCH_TOTAL_BYTES,
	BATCH_UPLOAD_MAX_FILES as MAX_BATCH_UPLOAD_FILES,
	MAX_FILE_SIZE_BYTES as MAX_FILE_BYTES,
} from '../../protocol/sync-limits';
const MANAGED_FILES_PREFIX = '__crate__/files/';
const CLEANUP_BATCH_LIMIT = 100;
const MAX_D1_BOUND_PARAMETERS = 100;
export const FILE_VERSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface FileStorageRow {
	hash: string;
	size: number;
	storageKey: string;
}

export type ExpectedFileHash = string | null;

export function parseExpectedFileHash(value: unknown): ExpectedFileHash | undefined {
	if (value === null || value === 'absent') return null;
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim().toLowerCase();
	return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
}

export function parseDeclaredSize(headerValue: string | null): number | null {
	if (headerValue === null) {
		return null;
	}

	if (!/^\d+$/.test(headerValue)) {
		return null;
	}
	const size = Number(headerValue);
	return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export function formatMutationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createManagedObjectKey(hash: string): string {
	return `${MANAGED_FILES_PREFIX}${hash}/${crypto.randomUUID()}`;
}

function normalizeStorageKey(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function collectCleanupKeys(previousFile: FileStorageRow | null, preserve?: string): string[] {
	const keys = new Set<string>();
	if (previousFile) {
		const previousKey = previousFile.storageKey;
		if (previousKey !== preserve) {
			keys.add(previousKey);
		}
	}

	return Array.from(keys);
}

async function queueObjectCleanup(db: D1Database, keys: string[]): Promise<void> {
	if (keys.length === 0) return;

	try {
		for (let index = 0; index < keys.length; index += MAX_D1_BOUND_PARAMETERS) {
			const chunk = keys.slice(index, index + MAX_D1_BOUND_PARAMETERS);
			const placeholders = chunk.map(() => '(?)').join(', ');
			await db.prepare(
				`INSERT OR IGNORE INTO object_cleanup_queue (storage_key) VALUES ${placeholders}`,
			).bind(...chunk).run();
		}
	} catch {
		// Cleanup must never turn an already-committed file mutation into a failure.
	}
}

async function removeQueuedObjectCleanup(db: D1Database, keys: string[]): Promise<number> {
	if (keys.length === 0) return 0;
  let removed = 0;

	try {
		for (let index = 0; index < keys.length; index += MAX_D1_BOUND_PARAMETERS) {
			const chunk = keys.slice(index, index + MAX_D1_BOUND_PARAMETERS);
			const placeholders = chunk.map(() => '?').join(', ');
			removed += changedRows(await db.prepare(
				`DELETE FROM object_cleanup_queue WHERE storage_key IN (${placeholders})`,
			).bind(...chunk).run());
		}
	} catch {
		// A later drain will repeat the idempotent R2 deletion and clear the row.
	}
  return removed;
}

async function deleteQueuedBucketObjects(
	bucket: R2Bucket,
	db: D1Database,
	keys: string[],
): Promise<number> {
	const uniqueKeys = Array.from(new Set(keys.filter((key) => key.length > 0)));
	if (uniqueKeys.length === 0) return 0;

	try {
		const referenced = await findReferencedStorageKeys(db, uniqueKeys);
		const unused = uniqueKeys.filter(key => !referenced.has(key));
		if (unused.length > 0) await bucket.delete(unused.length === 1 ? unused[0]! : unused);
		// Referenced keys must leave this queue as well; their eventual expiry
		// creates a new cleanup intent after the reference is removed.
		await db.prepare('DELETE FROM staged_uploads WHERE storage_key IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(uniqueKeys)).run();
    return await removeQueuedObjectCleanup(db, uniqueKeys);
	} catch {
		// The keys remain queued for the scheduled maintenance pass.
	}
  return 0;
}

export async function drainObjectCleanupQueue(bucket: R2Bucket, db: D1Database): Promise<number> {
	try {
		const rows = await queryRows<{ storage_key: string }>(
			db.prepare('SELECT storage_key FROM object_cleanup_queue ORDER BY created_at LIMIT ?')
				.bind(CLEANUP_BATCH_LIMIT),
		);
		const keys = rows.map(({ storage_key }) => storage_key).filter((key) => key.length > 0);
		return await deleteQueuedBucketObjects(bucket, db, keys);
	} catch {
		// The scheduled handler will retry on its next invocation.
	}
  return 0;
}

export async function enqueueExpiredFileVersions(db: D1Database, now = Date.now()): Promise<void> {
	await db.batch([
		db.prepare(`INSERT OR IGNORE INTO object_cleanup_queue (storage_key)
			SELECT storage_key FROM file_versions WHERE expires_at <= ?`).bind(now),
		db.prepare('DELETE FROM file_versions WHERE expires_at <= ?').bind(now),
	]);
}

export async function deleteBucketObjectsOrQueue(
	bucket: R2Bucket,
	db: D1Database,
	keys: string[],
): Promise<void> {
	const uniqueKeys = Array.from(new Set(keys.filter((key) => key.length > 0)));
	await queueObjectCleanup(db, uniqueKeys);
	await deleteQueuedBucketObjects(bucket, db, uniqueKeys);
}

export function storedObjectMatchesMetadata(
	object: { size: number; customMetadata?: Record<string, string> },
	storedFile: FileStorageRow,
): boolean {
	return (storedFile.size <= 0 || object.size === storedFile.size)
		&& (!object.customMetadata?.hash || object.customMetadata.hash === storedFile.hash);
}

export function formatMetadataCommitFailure(actionLabel: 'Upload' | 'Delete', metadataMessage: string): string {
	return `${actionLabel} outcome is unknown because the metadata response failed; reconcile before retrying: ${metadataMessage}`;
}

export async function getStoredFileRow(db: D1Database, path: string): Promise<FileStorageRow | null> {
	const row = await db.prepare('SELECT hash, size, storage_key FROM files WHERE path = ?')
		.bind(path)
		.first<{ hash?: string; size?: number; storage_key?: string }>();
	const storageKey = normalizeStorageKey(row?.storage_key);
	if (!row || !storageKey) {
		return null;
	}

	return {
		hash: typeof row.hash === 'string' ? row.hash : '',
		size: typeof row.size === 'number' ? row.size : 0,
		storageKey,
	};
}

export async function loadStoredFileRows(db: D1Database, paths: string[]): Promise<Map<string, FileStorageRow>> {
	if (paths.length === 0) return new Map();
	if (paths.length > MAX_D1_BOUND_PARAMETERS) {
		throw new Error(`Cannot load more than ${MAX_D1_BOUND_PARAMETERS} file rows at once`);
	}

	const placeholders = paths.map(() => '?').join(', ');
	const rows = await queryRows<{
		path?: string;
		hash?: string;
		size?: number;
		storage_key?: string;
	}>(db.prepare(
		`SELECT path, hash, size, storage_key FROM files WHERE path IN (${placeholders})`,
	).bind(...paths));

	const entries: Array<readonly [string, FileStorageRow]> = [];
	for (const row of rows) {
		const path = typeof row.path === 'string' ? row.path : null;
		const storageKey = normalizeStorageKey(row.storage_key);
		if (!path || !storageKey) continue;
		entries.push([path, {
			hash: typeof row.hash === 'string' ? row.hash : '',
			size: typeof row.size === 'number' ? row.size : 0,
			storageKey,
		}]);
	}

	return new Map(entries);
}

// Separate indexed endpoints avoid scanning the entire retained changelog.
export const CHANGELOG_BOUNDS_SQL = 'SELECT (SELECT MAX(seq) FROM changelog) AS lastSeq, (SELECT MIN(seq) FROM changelog) AS minSeq';

export async function getChangelogBounds(db: D1Database): Promise<{
	lastSeq: number;
	minSeq: number | null;
}> {
	const rows = await queryRows<{ lastSeq: number | null; minSeq: number | null }>(
		db.prepare(CHANGELOG_BOUNDS_SQL),
	);
	return {
		lastSeq: rows[0]?.lastSeq ?? 0,
		minSeq: rows[0]?.minSeq ?? null,
	};
}
