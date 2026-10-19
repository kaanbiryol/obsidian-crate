import { portablePathKey } from '../../protocol/portable-path';
import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { queryRows } from './db';
export {
	BATCH_DELETE_MAX_FILES as MAX_BATCH_DELETE_FILES,
	BATCH_DOWNLOAD_MAX_BYTES as MAX_BATCH_DOWNLOAD_BYTES,
	BATCH_DOWNLOAD_MAX_FILES as MAX_BATCH_DOWNLOAD_FILES,
	BATCH_UPLOAD_MAX_BYTES as MAX_BATCH_TOTAL_BYTES,
	BATCH_UPLOAD_MAX_FILES as MAX_BATCH_UPLOAD_FILES,
	MAX_FILE_SIZE_BYTES as MAX_FILE_BYTES,
} from '../../protocol/sync-limits';
const MANAGED_FILES_PREFIX = '__crate__/files/';
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
	const row = await db.prepare(`SELECT hash, size, storage_key FROM files WHERE ${FILE_PATH_MATCH}`)
		.bind(...filePathArgs(path))
		.first<{ hash?: string; size?: number; storage_key?: string }>();
	return toFileStorageRow(row);
}

export function toFileStorageRow(row: { hash?: string | null; size?: number | null; storage_key?: string | null } | null): FileStorageRow | null {
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
		`SELECT path, hash, size, storage_key FROM files WHERE portable_path IN (${placeholders})`,
	).bind(...paths.map(portablePathKey)));

	const entries: Array<readonly [string, FileStorageRow]> = [];
	for (const row of rows) {
		const path = typeof row.path === 'string' ? row.path : null;
		const storageKey = normalizeStorageKey(row.storage_key);
		if (!path || !storageKey || !paths.includes(path)) continue;
		entries.push([path, {
			hash: typeof row.hash === 'string' ? row.hash : '',
			size: typeof row.size === 'number' ? row.size : 0,
			storageKey,
		}]);
	}

	return new Map(entries);
}

// Separate indexed endpoints avoid scanning the entire retained changelog.
export const LAST_SEQ_SQL = `MAX(COALESCE((SELECT MAX(seq) FROM changelog), 0),
  COALESCE((SELECT snapshot_seq FROM initial_import), 0))`;
export const CHANGELOG_BOUNDS_SQL = `SELECT ${LAST_SEQ_SQL} AS lastSeq,
  (SELECT MIN(seq) FROM changelog) AS minSeq,
  COALESCE((SELECT snapshot_seq FROM initial_import), 0) AS snapshotSeq`;

export async function getChangelogBounds(db: D1Database): Promise<{
	lastSeq: number;
	minSeq: number | null;
  snapshotSeq: number;
}> {
	const rows = await queryRows<{ lastSeq: number | null; minSeq: number | null; snapshotSeq: number }>(
		db.prepare(CHANGELOG_BOUNDS_SQL),
	);
	return {
		lastSeq: rows[0]?.lastSeq ?? 0,
		minSeq: rows[0]?.minSeq ?? null,
    snapshotSeq: rows[0]?.snapshotSeq ?? 0,
	};
}
