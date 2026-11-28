import { portablePathKey } from '../../../protocol/portable-path';
import { FILE_PATH_MATCH, filePathArgs } from './file-identity';
import { queryRows } from '../d1/db';
import { isSha256Hex } from '../../../platform/validation';
import { sha256Hex } from '../../../platform/sha256';
import { D1_MAX_BOUND_PARAMETERS } from '../d1/platform-limits';
import { DAY_MS, DEFAULT_HISTORY_RETENTION_DAYS } from '../../../protocol/history-retention';
import { DEFAULT_BATCH_LIMITS, SELF_HOSTED_BATCH_LIMITS } from '../../../protocol/sync-limits';
export { MAX_FILE_SIZE_BYTES as MAX_FILE_BYTES } from '../../../protocol/sync-limits';

/** This server's batch sizes: a self-hosted server has no D1 query or Worker memory limit,
 * so it accepts, and advertises, larger batches. */
export const BATCH_LIMITS = __CRATE_SELF_HOSTED__ ? SELF_HOSTED_BATCH_LIMITS : DEFAULT_BATCH_LIMITS;
export const MAX_BATCH_DELETE_FILES = BATCH_LIMITS.deleteFiles;
export const MAX_BATCH_DOWNLOAD_BYTES = BATCH_LIMITS.downloadBytes;
export const MAX_BATCH_DOWNLOAD_FILES = BATCH_LIMITS.downloadFiles;
export const MAX_BATCH_TOTAL_BYTES = BATCH_LIMITS.uploadBytes;
export const MAX_BATCH_UPLOAD_FILES = BATCH_LIMITS.uploadFiles;
/** The server's history retention in milliseconds, read in the statement that uses it. */
export const HISTORY_RETENTION_MS_SQL = `(COALESCE((SELECT history_retention_days FROM server_state WHERE id = 1), ${DEFAULT_HISTORY_RETENTION_DAYS}) * ${DAY_MS})`;
/** A retained version's `kept_at`, its commit time. Bind `Date.now()`; the database clock,
 * rounded up to the next second, wins when it is later. */
export const FILE_VERSION_KEPT_AT_SQL = `MAX(?, (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000)`;
/** `maintenance_state` key: the latest `kept_at` whose versions maintenance has started to
 * remove. A longer retention never makes those visible again. */
export const FILE_VERSION_FLOOR_KEY = 'file_version_floor';
/** Versions kept at or before this are expired: `kept_at` plus the current retention, and
 * never at or below the floor. Bind `Date.now()`. */
export const FILE_VERSION_FLOOR_SQL = `COALESCE((SELECT CAST(value AS INTEGER) FROM maintenance_state WHERE key = '${FILE_VERSION_FLOOR_KEY}'), 0)`;
export const FILE_VERSION_CUTOFF_SQL = `MAX(? - ${HISTORY_RETENTION_MS_SQL}, ${FILE_VERSION_FLOOR_SQL})`;

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
	return isSha256Hex(normalized) ? normalized : undefined;
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

export function storedObjectMatchesMetadata(
	object: { size: number; customMetadata?: Record<string, string> },
	storedFile: FileStorageRow,
): boolean {
	return (storedFile.size <= 0 || object.size === storedFile.size)
		&& (!object.customMetadata?.hash || object.customMetadata.hash === storedFile.hash);
}

export function formatMetadataCommitFailure(actionLabel: 'Upload' | 'Delete' | 'Move', metadataMessage: string): string {
	return `${actionLabel} outcome is unknown because the metadata response failed; reconcile before retrying: ${metadataMessage}`;
}

type FileRow = { hash: string; size: number; storage_key: string };
const toFileStorageRow = (row: FileRow): FileStorageRow => ({ hash: row.hash, size: row.size, storageKey: row.storage_key });

export async function getStoredFileRow(db: D1Database, path: string): Promise<FileStorageRow | null> {
	const row = await db.prepare(`SELECT hash, size, storage_key FROM files WHERE ${FILE_PATH_MATCH}`)
		.bind(...filePathArgs(path))
		.first<FileRow>();
	return row && toFileStorageRow(row);
}

/** The bytes of a stored revision, or null when R2 lacks them or they fail its size or SHA-256. */
export async function readVerifiedBytes(bucket: R2Bucket, file: FileStorageRow): Promise<ArrayBuffer | null> {
	const object = await bucket.get(file.storageKey);
	if (!object || (file.size > 0 && object.size !== file.size)) return null;
	const bytes = await object.arrayBuffer();
	return await sha256Hex(bytes) === file.hash ? bytes : null;
}

export async function loadStoredFileRows(db: D1Database, paths: string[]): Promise<Map<string, FileStorageRow>> {
	if (paths.length === 0) return new Map();
	if (paths.length > D1_MAX_BOUND_PARAMETERS) {
		throw new Error(`Cannot load more than ${D1_MAX_BOUND_PARAMETERS} file rows at once`);
	}

	const placeholders = paths.map(() => '?').join(', ');
	const rows = await queryRows<FileRow & { path: string }>(db.prepare(
		`SELECT path, hash, size, storage_key FROM files WHERE portable_path IN (${placeholders})`,
	).bind(...paths.map(portablePathKey)));
	// A portable key also matches other spellings of a path; keep exact matches only.
	return new Map(rows.filter(row => paths.includes(row.path)).map(row => [row.path, toFileStorageRow(row)]));
}

// The indexed endpoint avoids scanning the entire retained changelog. Pruning keeps the
// newest entry, an initial import records its snapshot and a reset records the floor, so
// this never decreases. Entries number above the floor, so the floor counts only while the
// changelog is empty. Both values are in the one `server_state` row.
export const LAST_SEQ_SQL = `MAX(COALESCE((SELECT MAX(seq) FROM changelog), 0),
  COALESCE((SELECT MAX(COALESCE(changelog_floor, 0), import_snapshot_seq) FROM server_state WHERE id = 1), 0))`;

/** The sequence of the changelog row a statement precedes in its batch. A row written
 * before its changelog entry takes this as its `live_from_seq` or `live_until_seq`; one
 * written after takes `LAST_SEQ_SQL`. Checkpoints fall between transactions, so any
 * sequence within its batch's range is exact for every checkpoint. */
export const NEXT_SEQ_SQL = `(${LAST_SEQ_SQL} + 1)`;

/** The `seq` of each changelog row an INSERT ... SELECT writes, numbered in `order`. The
 * subquery does not depend on the row, so SQLite evaluates it once per statement. */
export const nextChangelogSeqSql = (order: string) => `(SELECT ${LAST_SEQ_SQL}) + ROW_NUMBER() OVER (ORDER BY ${order})`;
export const CHANGELOG_BOUNDS_SQL = `SELECT ${LAST_SEQ_SQL} AS lastSeq,
  (SELECT MIN(seq) FROM changelog) AS minSeq,
  COALESCE((SELECT import_snapshot_seq FROM server_state WHERE id = 1), 0) AS snapshotSeq`;

export interface ChangelogBounds { lastSeq: number; minSeq: number | null; snapshotSeq: number }

export async function getChangelogBounds(db: D1Database): Promise<ChangelogBounds> {
	const rows = await queryRows<{ lastSeq: number | null; minSeq: number | null; snapshotSeq: number }>(
		db.prepare(CHANGELOG_BOUNDS_SQL),
	);
	return {
		lastSeq: rows[0]?.lastSeq ?? 0,
		minSeq: rows[0]?.minSeq ?? null,
		snapshotSeq: rows[0]?.snapshotSeq ?? 0,
	};
}

/** This database's random storage identity, kept in `maintenance_state`. A new or restored
 * server gets a new one, so a device can tell that its baselines describe another server
 * even when the changelog has caught up with its cursor. */
export const STORAGE_ID_SQL = "SELECT value FROM maintenance_state WHERE key = 'storage_id'";

/** The storage identity `/sync/check` reports, created by the first check that finds none.
 * `maintenance_state` is a control table, so upgrade write guards never block this. */
export async function storageIdField(db: D1Database, current: string | null): Promise<{ storageId: string }> {
	if (current) return { storageId: current };
	await db.prepare("INSERT INTO maintenance_state (key, value) VALUES ('storage_id', lower(hex(randomblob(16)))) ON CONFLICT(key) DO NOTHING").run();
	const row = await db.prepare(STORAGE_ID_SQL).first<{ value: string }>();
	if (!row) throw new Error('Could not read the storage identity');
	return { storageId: row.value };
}

/** The `since` changelog cursor of a request, or null when it is not a sequence number. */
export function parseChangelogSince(url: URL): number | null {
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	return isNaN(since) || since < 0 ? null : since;
}

/** A cursor the retained changelog cannot continue: from before the initial import
 * snapshot, or behind pruned rows. Its client must rescan so it cannot miss deletions. */
export function isChangelogCursorExpired(since: number, { lastSeq, minSeq, snapshotSeq }: ChangelogBounds): boolean {
	return since < snapshotSeq || since > 0 && since !== lastSeq && (minSeq === null || since + 1 < minSeq);
}
