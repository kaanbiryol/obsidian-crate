import { queryRows } from './db';

export const MAX_BATCH_FILES = 50;
export const MAX_BATCH_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_BATCH_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MANAGED_FILES_PREFIX = '__crate__/files/';
const CLEANUP_BATCH_LIMIT = 25;
const CLEANUP_DRAIN_PROBABILITY = 0.05;

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
		await db.batch(keys.map((key) => db.prepare(
			'INSERT OR IGNORE INTO object_cleanup_queue (storage_key) VALUES (?)',
		).bind(key)));
	} catch {
		// Cleanup must never turn an already-committed file mutation into a failure.
	}
}

async function removeQueuedObjectCleanup(db: D1Database, keys: string[]): Promise<void> {
	if (keys.length === 0) return;

	try {
		await db.batch(keys.map((key) => db.prepare(
			'DELETE FROM object_cleanup_queue WHERE storage_key = ?',
		).bind(key)));
	} catch {
		// A later drain will repeat the idempotent R2 deletion and clear the row.
	}
}

export async function drainObjectCleanupQueue(bucket: R2Bucket, db: D1Database): Promise<void> {
	try {
		const rows = await queryRows<{ storage_key: string }>(
			db.prepare('SELECT storage_key FROM object_cleanup_queue ORDER BY created_at LIMIT ?')
				.bind(CLEANUP_BATCH_LIMIT),
		);
		const outcomes = await Promise.all(rows.map(async ({ storage_key: key }) => {
			try {
				await bucket.delete(key);
				return key;
			} catch {
				return null;
			}
		}));
		const deletedKeys = outcomes.filter((key): key is string => key !== null);
		if (deletedKeys.length > 0) {
			await db.batch(deletedKeys.map((key) => db.prepare(
				'DELETE FROM object_cleanup_queue WHERE storage_key = ?',
			).bind(key)));
		}
	} catch {
		// The queue is best effort and will be retried by a later mutation.
	}
}

export async function deleteBucketObjectsOrQueue(
	bucket: R2Bucket,
	db: D1Database,
	keys: string[],
): Promise<void> {
	const uniqueKeys = Array.from(new Set(keys.filter((key) => key.length > 0)));
	await queueObjectCleanup(db, uniqueKeys);
	const outcomes = await Promise.all(uniqueKeys.map(async (key) => {
		try {
			await bucket.delete(key);
			return key;
		} catch {
			return null;
		}
	}));
	await removeQueuedObjectCleanup(db, outcomes.filter((key): key is string => key !== null));
	if (Math.random() < CLEANUP_DRAIN_PROBABILITY) {
		await drainObjectCleanupQueue(bucket, db);
	}
}

export function storedObjectMatchesMetadata(
	object: { size: number; customMetadata?: Record<string, string> },
	storedFile: FileStorageRow,
): boolean {
	return (storedFile.size <= 0 || object.size === storedFile.size)
		&& (!object.customMetadata?.hash || object.customMetadata.hash === storedFile.hash);
}

export function formatMetadataCommitFailure(actionLabel: 'Upload' | 'Delete', metadataMessage: string): string {
	return `${actionLabel} not committed because sync metadata update failed: ${metadataMessage}`;
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
	const rows = await Promise.all(paths.map(async (path) => {
		const row = await getStoredFileRow(db, path);
		return row ? [path, row] as const : null;
	}));

	return new Map(rows.filter((entry): entry is readonly [string, FileStorageRow] => entry !== null));
}

export async function getChangelogBounds(db: D1Database): Promise<{
	lastSeq: number;
	minSeq: number | null;
}> {
	const rows = await queryRows<{ lastSeq: number | null; minSeq: number | null }>(
		db.prepare('SELECT MAX(seq) as lastSeq, MIN(seq) as minSeq FROM changelog'),
	);
	return {
		lastSeq: rows[0]?.lastSeq ?? 0,
		minSeq: rows[0]?.minSeq ?? null,
	};
}
