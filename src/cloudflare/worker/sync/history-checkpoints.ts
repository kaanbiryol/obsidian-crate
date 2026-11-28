import { MAX_LISTED_CHECKPOINTS, SELF_HOSTED_SHARED_CHECKPOINTS, isCheckpointId, type SharedCheckpoint } from '../../../protocol/history-checkpoints';
import { portablePathKey } from '../../../protocol/portable-path';
import { corsHeaders, corsResponse } from '../http/cors';
import { fileTransportLimit } from '../../../encryption/file-format';
import { MAX_CONFIGURABLE_FILE_BYTES } from '../../../protocol/sync-limits';
import { DAY_MS } from '../../../protocol/history-retention';
import { FILE_VERSION_CUTOFF_SQL, FILE_VERSION_FLOOR_SQL, HISTORY_RETENTION_MS_SQL, LAST_SEQ_SQL, storedObjectMatchesMetadata } from './storage';
import { sanitizePath } from '../http/request-validation';
import { isSyncRevision } from '../../../protocol/sync-validation';
import { FILE_HASH_HEADER } from '../../../protocol/http-headers';

// Ten pages, plus a read of the moves and the versions since, rebuild a 100,000-file
// checkpoint within the Free plan's query budget.
export const CHECKPOINT_PAGE_SIZE = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const headers = { 'Cache-Control': 'private, no-store' };
const response = (value: unknown, status = 200) => corsResponse(value, status, headers);

/** A checkpoint's ID names its sequence, so it needs no stored identifier or index. */
const ID_PREFIX = '00000000-0000-4000-8000-';
export const checkpointId = (seq: number) => `${ID_PREFIX}${seq.toString(16).padStart(12, '0')}`;
function checkpointSeq(id: string | null): number | null {
	if (!isCheckpointId(id) || !id.startsWith(ID_PREFIX)) return null;
	const seq = parseInt(id.slice(ID_PREFIX.length), 16);
	return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

interface CheckpointRow { seq: number; created_at: number; file_count: number; retention: number }

/** Checkpoints still kept: within the current retention, which may have been shortened
 * since one was saved, and not before the floor. The copies a checkpoint needs were kept
 * after it, so once maintenance started removing versions kept after it (the floor), a
 * longer retention cannot bring it back. */
const visibleSql = (row = 'history_checkpoints') => `${row}.created_at + ${HISTORY_RETENTION_MS_SQL} > ? AND ${row}.created_at >= ${FILE_VERSION_FLOOR_SQL}`;
const CHECKPOINT_COLUMNS = `seq, created_at, file_count, ${HISTORY_RETENTION_MS_SQL} AS retention`;

const toCheckpoint = (row: CheckpointRow, fileCount = row.file_count): SharedCheckpoint => ({
	id: checkpointId(row.seq), sequence: row.seq, timestamp: new Date(row.created_at).toISOString(),
	expiresAt: row.created_at + row.retention, fileCount,
});

function readCheckpoint(db: D1Database, id: string | null): Promise<CheckpointRow | null> {
	const seq = checkpointSeq(id);
	if (seq === null) return Promise.resolve(null);
	return db.prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM history_checkpoints WHERE seq = ? AND ${visibleSql()}`).bind(seq, Date.now()).first<CheckpointRow>();
}

/** For clients that save checkpoints themselves: saves the vault as it is now, or returns
 * the checkpoint that already names this state. Commits save them on their own. */
export async function createSharedCheckpoint(db: D1Database): Promise<Response> {
	const state = await db.prepare(`SELECT ${LAST_SEQ_SQL} AS seq,
		COALESCE((SELECT import_state FROM server_state WHERE id = 1), 'complete') AS state,
		COALESCE((SELECT file_count FROM server_state WHERE id = 1), 0) AS files`).first<{ seq: number; state: string; files: number }>();
	if (!state || state.state !== 'complete') return response({ error: 'Finish the initial sync before creating a checkpoint.' }, 409);
	if (!state.seq || !state.files) return response({ error: 'The vault has no files to save in a checkpoint.' }, 409);
	// Nothing changed since the checkpoint at this sequence, so the current files are all
	// it needs: one hidden by retention starts again from now.
	await db.prepare(`INSERT INTO history_checkpoints (seq, created_at, file_count)
		SELECT ?, CAST(strftime('%s', 'now') AS INTEGER) * 1000, ? WHERE ? = ${LAST_SEQ_SQL}
		ON CONFLICT(seq) DO UPDATE SET created_at = excluded.created_at, file_count = excluded.file_count
			WHERE NOT (${visibleSql()})`)
		.bind(state.seq, state.files, state.seq, Date.now()).run();
	const row = await readCheckpoint(db, checkpointId(state.seq));
	if (!row) return response({ error: 'The vault changed while saving its checkpoint. Sync again to retry.' }, 409);
	return response({ checkpoint: toCheckpoint(row) });
}

export async function listSharedCheckpoints(request: Request, db: D1Database): Promise<Response> {
	const rows = await db.prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM history_checkpoints WHERE ${visibleSql()} ORDER BY seq DESC LIMIT ?`)
		.bind(Date.now(), MAX_LISTED_CHECKPOINTS).all<CheckpointRow>();
	const checkpoints = rows.results.map(row => toCheckpoint(row));
	// Clients that do not ask for the whole list refuse one longer than 100; give them the newest.
	const limit = new URL(request.url).searchParams.get('all') === '1' ? MAX_LISTED_CHECKPOINTS : SELF_HOSTED_SHARED_CHECKPOINTS;
	return response({ version: 1, checkpoints: checkpoints.slice(0, limit) });
}

const replaced = () => response({ error: 'This shared checkpoint expired or was replaced by a newer checkpoint.' }, 410);

interface RebuiltFile { path: string; hash: string; size: number; modified: string; revision: string }

/** The vault at checkpoint `seq`: the current files that were already current then, and
 * the kept copies that were. Every copy it needs was kept after the checkpoint, so the
 * `kept_at` index reads only versions kept since. A copy a server move took elsewhere since
 * is listed where its first move after the checkpoint took it from, so the server moves
 * since are read first, a key's earliest first. Pages run as the response is read, so the
 * document is never held whole. Files come first, so the checkpoint names its exact count
 * after them. */
function rebuiltDocument(db: D1Database, row: CheckpointRow): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const seen = new Set<string>();
	const movedFrom = new Map<string, string>();
	let stage: 'moves' | 'files' | 'versions' | 'done' = 'moves';
	let afterKey = '', afterSeq = 0, afterPath = '', afterKept = row.created_at, afterId = 0, count = 0, started = false;
	const encode = (file: RebuiltFile) => {
		const path = movedFrom.get(file.revision) ?? file.path;
		if (seen.has(path)) return '';
		seen.add(path);
		return `${count++ ? ',' : ''}${JSON.stringify(path)}:${JSON.stringify({ hash: file.hash, size: file.size, modified: file.modified, revision: file.revision })}`;
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let text = started ? '' : '{"version":1,"files":{';
			started = true;
			if (stage === 'moves') {
				const page = await db.prepare(`SELECT storage_key, seq, from_path FROM file_moves
					WHERE (storage_key, seq) > (?, ?) AND seq > ? ORDER BY storage_key, seq LIMIT ?`)
					.bind(afterKey, afterSeq, row.seq, CHECKPOINT_PAGE_SIZE).all<{ storage_key: string; seq: number; from_path: string }>();
				for (const move of page.results) if (!movedFrom.has(move.storage_key)) movedFrom.set(move.storage_key, move.from_path);
				if (page.results.length < CHECKPOINT_PAGE_SIZE) stage = 'files';
				else ({ storage_key: afterKey, seq: afterSeq } = page.results.at(-1)!);
			} else if (stage === 'files') {
				const page = await db.prepare(`SELECT path, portable_path, hash, size, modified, storage_key AS revision FROM files
					WHERE portable_path > ? AND live_from_seq <= ? ORDER BY portable_path LIMIT ?`)
					.bind(afterPath, row.seq, CHECKPOINT_PAGE_SIZE).all<RebuiltFile & { portable_path: string }>();
				for (const file of page.results) text += encode(file);
				if (page.results.length < CHECKPOINT_PAGE_SIZE) stage = 'versions';
				else afterPath = page.results.at(-1)!.portable_path;
			} else if (stage === 'versions') {
				const page = await db.prepare(`SELECT id, kept_at, path, hash, size, created_at AS modified, storage_key AS revision FROM file_versions
					WHERE (kept_at, id) > (?, ?) AND live_from_seq <= ? AND live_until_seq > ? ORDER BY kept_at, id LIMIT ?`)
					.bind(afterKept, afterId, row.seq, row.seq, CHECKPOINT_PAGE_SIZE).all<RebuiltFile & { id: number; kept_at: number }>();
				for (const file of page.results) text += encode(file);
				if (page.results.length < CHECKPOINT_PAGE_SIZE) stage = 'done';
				else ({ kept_at: afterKept, id: afterId } = page.results.at(-1)!);
			}
			if (stage === 'done') {
				text += `},"checkpoint":${JSON.stringify(toCheckpoint(row, count))}}`;
				controller.enqueue(encoder.encode(text));
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(text));
		},
	});
}

export async function getSharedCheckpoint(request: Request, db: D1Database): Promise<Response> {
	const id = new URL(request.url).searchParams.get('id');
	if (!isCheckpointId(id)) return response({ error: 'Invalid checkpoint ID' }, 400);
	const row = await readCheckpoint(db, id);
	if (!row) return replaced();
	return new Response(rebuiltDocument(db, row), { headers: { ...corsHeaders(), ...headers, 'Content-Type': 'application/json' } });
}

/** Vault-scoped immutable reads; validate the live checkpoint and D1 ownership.
 * The client checks the returned bytes against its verified checkpoint inventory. */
export async function downloadCheckpointFile(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const id = params.get('id'), path = sanitizePath(params.get('path') ?? ''), revision = params.get('revision');
	if (!isCheckpointId(id) || !path || !isSyncRevision(revision)) return response({ error: 'A checkpoint and file path are required' }, 400);
	if (!await readCheckpoint(db, id)) return response({ error: 'This shared checkpoint expired or was replaced.' }, 410);
	// Server moves may have taken the copy from `path` since the checkpoint; its last move
	// names where its live row is now.
	const movedFrom = 'EXISTS (SELECT 1 FROM file_moves m WHERE m.storage_key = ?3 AND m.from_path = ?2)';
	const file = await db.prepare(`SELECT hash, size FROM files WHERE portable_path = ?1 AND path = ?2 AND storage_key = ?3
        UNION ALL SELECT f.hash, f.size FROM file_moves m JOIN files f ON f.portable_path = m.to_portable AND f.storage_key = m.storage_key
          WHERE m.storage_key = ?3 AND ${movedFrom}
        UNION ALL SELECT hash, size FROM file_versions WHERE storage_key = ?3 AND (path = ?2 OR ${movedFrom})
          AND kept_at > ${FILE_VERSION_CUTOFF_SQL.replace('?', '?4')} LIMIT 1`)
		.bind(portablePathKey(path), path, revision, Date.now()).first<{ hash: string; size: number }>();
	if (!file) return response({ error: 'A file version required by this checkpoint is no longer available.', code: 'version_unavailable' }, 410);
	const object = await bucket.get(revision);
	if (!object || object.size > fileTransportLimit(object.httpMetadata?.contentType, MAX_CONFIGURABLE_FILE_BYTES) || !storedObjectMatchesMetadata(object, { hash: file.hash, size: file.size, storageKey: revision })) return response({ error: 'Checkpoint file contents are unavailable.' }, 503);
	return new Response(object.body, { headers: { ...corsHeaders(), ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size), [FILE_HASH_HEADER]: file.hash } });
}

/** Server moves one pruning pass removes, a twentieth of the daily maintenance budget. */
export const FILE_MOVE_PRUNE_BATCH = 1_000;

/** Thins checkpoints like a backup history: every one from the last day, the first of
 * each hour for a week, then the first of each day, and none past the retention or the
 * floor. A survivor stays the first of its hour or day as it ages, so thinning never
 * needs one it removed. With `moves`, the same batch then removes up to
 * `FILE_MOVE_PRUNE_BATCH` server moves no kept checkpoint precedes, since a later
 * checkpoint never needs an earlier move. The move log is keyed by stored copy, so finding
 * them scans it: maintenance asks for that once per episode, and a move kept longer only
 * costs its row. Returns false: one batch removes the checkpoints. */
export async function pruneSharedCheckpoints(db: D1Database, now = Date.now(), { moves = false } = {}): Promise<boolean> {
	await db.batch([
		db.prepare(`DELETE FROM history_checkpoints WHERE NOT (${visibleSql()}) OR seq IN (
			SELECT seq FROM (SELECT seq, ROW_NUMBER() OVER (
				PARTITION BY CASE WHEN created_at <= ?2 THEN 'd' || (created_at / ${DAY_MS}) ELSE 'h' || (created_at / ${HOUR_MS}) END
				ORDER BY seq) AS rank
			FROM history_checkpoints WHERE created_at <= ?3) WHERE rank > 1)`)
			.bind(now, now - 7 * DAY_MS, now - DAY_MS),
		...moves ? [db.prepare(`DELETE FROM file_moves WHERE (storage_key, seq) IN (
			SELECT storage_key, seq FROM file_moves WHERE seq <= COALESCE((SELECT MIN(seq) FROM history_checkpoints), seq) LIMIT ?)`)
			.bind(FILE_MOVE_PRUNE_BATCH)] : [],
	]);
	return false;
}
