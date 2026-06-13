import { initDb, queryRows } from './db';
import { FILES_PREFIX } from './utils';

export const MAX_BATCH_FILES = 50;
export const MAX_BATCH_TOTAL_BYTES = 10 * 1024 * 1024;
const MANAGED_FILES_PREFIX = '__crate__/files/';

export interface FileStorageRow {
	storageKey: string | null;
}

export function parseDeclaredSize(headerValue: string | null): number | null {
	if (headerValue === null) {
		return null;
	}

	const size = Number.parseInt(headerValue, 10);
	return Number.isInteger(size) && size >= 0 ? size : null;
}

export function formatMutationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function legacyObjectKey(path: string): string {
	return FILES_PREFIX + path;
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

function resolveObjectKey(path: string, storageKey: string | null): string {
	return storageKey ?? legacyObjectKey(path);
}

export function collectCleanupKeys(path: string, previousFile: FileStorageRow | null, preserve?: string): string[] {
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

export async function deleteBucketObjectsQuietly(bucket: R2Bucket, keys: string[]): Promise<void> {
	const uniqueKeys = Array.from(new Set(keys.filter((key) => key.length > 0)));
	await Promise.allSettled(uniqueKeys.map((key) => bucket.delete(key)));
}

export function formatMetadataCommitFailure(actionLabel: 'Upload' | 'Delete', metadataMessage: string): string {
	return `${actionLabel} not committed because sync metadata update failed: ${metadataMessage}`;
}

export async function getStoredFileRow(db: D1Database, path: string): Promise<FileStorageRow | null> {
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

export async function loadStoredFileRows(db: D1Database, paths: string[]): Promise<Map<string, FileStorageRow>> {
	const rows = await Promise.all(paths.map(async (path) => {
		const row = await getStoredFileRow(db, path);
		return row ? [path, row] as const : null;
	}));

	return new Map(rows.filter((entry): entry is readonly [string, FileStorageRow] => entry !== null));
}

export async function resolveCommittedObjectKey(db: D1Database, path: string): Promise<string | null> {
	const row = await getStoredFileRow(db, path);
	if (!row) {
		return null;
	}

	return resolveObjectKey(path, row.storageKey);
}

export async function getChangelogBounds(db: D1Database): Promise<{
	lastSeq: number;
	minSeq: number | null;
}> {
	const maxRows = await queryRows<{ lastSeq: number }>(db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'));
	const minRows = await queryRows<{ minSeq: number | null }>(db.prepare('SELECT MIN(seq) as minSeq FROM changelog'));
	return {
		lastSeq: maxRows[0]?.lastSeq || 0,
		minSeq: minRows[0]?.minSeq ?? null,
	};
}

export async function ensureSyncMetadata(db: D1Database): Promise<void> {
	await initDb(db);
}
