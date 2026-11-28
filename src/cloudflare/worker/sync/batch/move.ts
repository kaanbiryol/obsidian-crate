import { corsResponse } from '../../http/cors';
import { parseJsonObject, parseOptionalString, sanitizePath } from '../../http/request-validation';
import { portablePathKey } from '../../../../protocol/portable-path';
import { BATCH_MOVE_MAX_FILES } from '../../../../protocol/sync-limits';
import type { BatchMoveResponse } from '../../../../protocol/sync-types';
import { COMMIT_CONTEXT_COLUMNS, parseCommitContext, type CommitContextRow } from '../mutations';
import { createsNotificationWork } from '../staging/commit-context';
import { commitFileMoves, type FileMoveInput } from '../file-move';
import { formatMetadataCommitFailure, formatMutationError, loadStoredFileRows, parseExpectedFileHash, type FileStorageRow } from '../storage';

type MoveResult = BatchMoveResponse['results'][number];
interface RequestedMove { from: string; to: string; expectedHash: string; expectedRevision: string }

/** Moves plaintext files to new paths without their bytes: each keeps its stored object
 * and revision. Runs under the coordinator lock, so the snapshot read here stays current
 * until the commit, whose statements still check every guard themselves. A move this
 * server cannot make, such as one into or out of the reminder or Reading folder, fails
 * with `move_unsupported`, and the client uploads and deletes instead. */
export async function handleBatchMove(request: Request, db: D1Database): Promise<Response> {
	const parsed = await parseJsonObject(request);
	if (!parsed.ok) return parsed.response;
	const rawMoves = parsed.value.moves;
	if (!Array.isArray(rawMoves) || rawMoves.length === 0 || rawMoves.length > BATCH_MOVE_MAX_FILES) {
		return corsResponse({ error: `moves array required (maximum ${BATCH_MOVE_MAX_FILES})` }, 400);
	}

	const results = Array.from<MoveResult | undefined>({ length: rawMoves.length });
	const requested: Array<{ index: number; move: RequestedMove }> = [];
	const named = new Set<string>();
	rawMoves.forEach((raw: unknown, index) => {
		const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
		const from = typeof value.from === 'string' ? sanitizePath(value.from) : null;
		const to = typeof value.to === 'string' ? sanitizePath(value.to) : null;
		const label = { from: from ?? (typeof value.from === 'string' ? value.from : ''), to: to ?? (typeof value.to === 'string' ? value.to : '') };
		const expectedHash = parseExpectedFileHash(value.expectedHash);
		const expectedRevision = parseOptionalString(value.expectedRevision, 1024);
		const invalid = !from || !to ? 'Invalid path'
			: portablePathKey(from) === portablePathKey(to) ? 'A move must change the portable path; delete and upload instead'
				: named.has(portablePathKey(from)) || named.has(portablePathKey(to)) ? 'Each path may appear once in a batch'
					: !expectedHash ? 'Valid expectedHash required'
						: !expectedRevision ? 'expectedRevision required' : null;
		if (invalid || !from || !to || !expectedHash || !expectedRevision) {
			results[index] = { ...label, success: false, error: invalid ?? 'Invalid move', code: 'validation', status: 400 };
			return;
		}
		named.add(portablePathKey(from)).add(portablePathKey(to));
		requested.push({ index, move: { from, to, expectedHash, expectedRevision } });
	});

	let rows = new Map<string, FileStorageRow>();
	let context: ReturnType<typeof parseCommitContext> = {};
	try {
		if (requested.length) {
			rows = await loadStoredFileRows(db, requested.flatMap(({ move }) => [move.from, move.to]));
			context = parseCommitContext(await db.prepare(`SELECT ${COMMIT_CONTEXT_COLUMNS}`).first<CommitContextRow>());
		}
	} catch (error: unknown) {
		return storageFailure(rawMoves.length, results, requested, error);
	}
	if (context.encryptionState) {
		for (const { index, move } of requested) results[index] = failure(move, 'move_unsupported', 409, 'An encrypted vault moves files by upload and delete');
		return respond(results);
	}

	const folders = { reminderFolder: context.reminderFolder ?? null, readingPolicy: context.readingPolicy ?? null };
	const pending: Array<{ index: number; move: RequestedMove; input: FileMoveInput }> = [];
	for (const { index, move } of requested) {
		const source = rows.get(move.from);
		const destination = rows.get(move.to);
		if (!source && destination?.storageKey === move.expectedRevision && destination.hash === move.expectedHash) {
			// Keys are never reused, so the key at the destination proves this move committed.
			results[index] = { from: move.from, to: move.to, success: true, hash: destination.hash, revision: destination.storageKey };
		} else if (!source || source.hash !== move.expectedHash || source.storageKey !== move.expectedRevision) {
			results[index] = failure(move, 'version_conflict', 409, 'Remote file changed since it was read', source?.hash ?? null);
		} else if (destination) {
			results[index] = failure(move, 'version_conflict', 409, 'A file already exists at the destination', destination.hash);
		} else if (createsNotificationWork([move.from, move.to], folders)) {
			results[index] = failure(move, 'move_unsupported', 409, 'Moves into, out of or within the reminder or Reading folder need the file uploaded');
		} else {
			pending.push({ index, move, input: { from: move.from, to: move.to, hash: source.hash, size: source.size, storageKey: source.storageKey } });
		}
	}

	try {
		const applied = await commitFileMoves(db, pending.map(entry => entry.input));
		pending.forEach(({ index, move, input }, position) => {
			results[index] = applied[position]
				? { from: move.from, to: move.to, success: true, hash: input.hash, revision: input.storageKey }
				: failure(move, 'move_unsupported', 409, 'This file cannot move on the server now; upload and delete it instead');
		});
	} catch (error: unknown) {
		return storageFailure(rawMoves.length, results, pending, error);
	}
	return respond(results);
}

function failure(move: RequestedMove, code: NonNullable<MoveResult['code']>, status: number, error: string, currentHash?: string | null): MoveResult {
	return { from: move.from, to: move.to, success: false, error, code, status, ...(currentHash === undefined ? {} : { currentHash }) };
}

function respond(results: Array<MoveResult | undefined>): Response {
	const complete = results.filter((result): result is MoveResult => result !== undefined);
	return corsResponse({ success: complete.every(result => result.success), results: complete } satisfies BatchMoveResponse, 200);
}

/** The outcome of `uncertain` is unknown; a retry answers from the server's state. */
function storageFailure(size: number, results: Array<MoveResult | undefined>, uncertain: ReadonlyArray<{ index: number; move: RequestedMove }>, error: unknown): Response {
	const message = formatMetadataCommitFailure('Move', formatMutationError(error));
	for (const { index, move } of uncertain) results[index] = failure(move, 'storage', 503, message);
	return corsResponse({ success: false, results: results.slice(0, size).filter((result): result is MoveResult => result !== undefined) } satisfies BatchMoveResponse, 503);
}
