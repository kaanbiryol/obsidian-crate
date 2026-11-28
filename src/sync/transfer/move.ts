import { portablePathKey } from '../../protocol/portable-path';
import { BATCH_MOVE_MAX_FILES } from '../../protocol/sync-limits';
import type { BatchMoveFile, BatchMoveResponse, FileEntry } from '../../protocol/sync-types';
import { LocalFilePresentError } from '../local/local-absence';
import type { SyncResult, SyncWork } from '../types';
import { UNVERIFIED_MODIFIED } from './applied-content';
import { createEmptySyncResult } from '../sync-result';
import { BATCH_DELETE_CONCURRENCY } from './constants';
import type { ConditionalDeleteCandidate } from './delete-batches';
import type { MoveJournal } from './move-journal';

interface RemoteMoveApi {
	batchMove(moves: BatchMoveFile[]): Promise<BatchMoveResponse>;
}

export interface MoveContext {
	files: RemoteMoveApi;
	localManifest: {
		getEntry(path: string): Readonly<FileEntry> | undefined;
		setEntry(path: string, entry: FileEntry): void;
		removeEntry(path: string): void;
		save(): Promise<void>;
	};
	journal: Pick<MoveJournal, 'pending' | 'record' | 'clear'>;
	/** Throws when the old path exists locally again, as before a delete. */
	assertLocalFileAbsent(path: string): Promise<void>;
	reportWork?(work: SyncWork): void;
}

export type MoveRemoteFiles = (moves: BatchMoveFile[], result: SyncResult) => Promise<BatchMoveFile[]>;

/** Pairs each pending delete with a new local file of the same bytes, so the server can
 * move the stored file instead of receiving it again. A rename the manifest recorded
 * pairs first; any other pair only when its hash is unique on both sides, so identical
 * files never swap. A case or Unicode-only rename keeps the delete-first flow. */
export function pairMoves(
	deletes: readonly ConditionalDeleteCandidate[],
	created: ReadonlyArray<{ path: string; hash: string }>,
	renameDestination: (path: string) => string | undefined,
): BatchMoveFile[] {
	const createdHash = new Map(created.map(file => [file.path, file.hash]));
	const used = new Set<string>();
	const moves: BatchMoveFile[] = [];
	const pair = (file: ConditionalDeleteCandidate & { expectedRevision: string }, to: string) => {
		used.add(file.path).add(to);
		moves.push({ from: file.path, to, expectedHash: file.expectedHash, expectedRevision: file.expectedRevision });
	};
	const movable = deletes.filter((file): file is ConditionalDeleteCandidate & { expectedRevision: string } => Boolean(file.expectedRevision));
	const pairable = (from: string, to: string) => !used.has(from) && !used.has(to) && portablePathKey(from) !== portablePathKey(to);
	for (const file of movable) {
		const to = renameDestination(file.path);
		if (to && createdHash.get(to) === file.expectedHash && pairable(file.path, to)) pair(file, to);
	}
	const byHash = <T>(items: readonly T[], hash: (item: T) => string) => {
		const groups = new Map<string, T[]>();
		for (const item of items) groups.set(hash(item), [...groups.get(hash(item)) ?? [], item]);
		return groups;
	};
	const deletesByHash = byHash(movable.filter(file => !used.has(file.path)), file => file.expectedHash);
	const createdByHash = byHash(created.filter(file => !used.has(file.path)), file => file.hash);
	for (const [hash, [file, ...others]] of deletesByHash) {
		const targets = createdByHash.get(hash) ?? [];
		if (file && !others.length && targets.length === 1 && pairable(file.path, targets[0]!.path)) pair(file, targets[0]!.path);
	}
	return moves;
}

/** Records an acknowledged move as an upload of its new path and a delete of its old one.
 * Returns false for an answer that does not acknowledge exactly this move. */
function recordMove(context: MoveContext, move: BatchMoveFile, answer: BatchMoveResponse['results'][number] | undefined, result: SyncResult): boolean {
	if (!answer?.success || answer.to !== move.to || answer.hash !== move.expectedHash || answer.revision !== move.expectedRevision) return false;
	const size = context.localManifest.getEntry(move.from)?.size ?? 0;
	context.localManifest.setEntry(move.to, { hash: move.expectedHash, size, modified: UNVERIFIED_MODIFIED, revision: move.expectedRevision });
	context.localManifest.removeEntry(move.from);
	result.uploadedPaths.push(move.to);
	result.deletedPaths.push(move.from);
	result.uploaded++;
	result.deleted++;
	return true;
}

/** Moves files on the server in batches, recording each acknowledged move as an upload
 * of its new path and a delete of its old one. Returns the moves the server refused or
 * this device skipped, for the caller to upload and delete instead. The moves are
 * journaled before the first request and the journal is cleared once the manifest that
 * records them is saved. A request error stops further requests and is thrown once the
 * moves already acknowledged are recorded; the journal keeps the rest for
 * `recoverRemoteMoves`, since the server may have made them. */
export async function moveRemoteFiles(context: MoveContext, moves: readonly BatchMoveFile[], result: SyncResult): Promise<BatchMoveFile[]> {
	if (!moves.length) return [];
	const sending = new Set(moves.map(move => move.from));
	await context.journal.record([...(await context.journal.pending()).filter(move => !sending.has(move.from)), ...moves]);
	const unmoved: BatchMoveFile[] = [];
	let next = 0, processed = 0;
	let failure: { error: unknown } | null = null;
	context.reportWork?.({ phase: 'uploading', current: 0, total: moves.length });

	const send = async (chunk: BatchMoveFile[]) => {
		const ready: BatchMoveFile[] = [];
		for (const move of chunk) {
			try { await context.assertLocalFileAbsent(move.from); ready.push(move); }
			catch (error) { if (error instanceof LocalFilePresentError) unmoved.push(move); else throw error; }
		}
		if (!ready.length) return;
		const response = await context.files.batchMove(ready);
		const answers = new Map(response.results.map(answer => [answer.from, answer]));
		for (const move of ready) if (!recordMove(context, move, answers.get(move.from), result)) unmoved.push(move);
	};
	const worker = async () => {
		while (!failure && next < moves.length) {
			const chunk = moves.slice(next, next + BATCH_MOVE_MAX_FILES);
			next += chunk.length;
			try { await send(chunk); }
			catch (error) { failure ??= { error }; }
			processed += chunk.length;
			context.reportWork?.({ phase: 'uploading', current: processed, total: moves.length });
		}
	};
	// Drain dispatched requests, so a failure never discards a sibling's acknowledgement.
	await Promise.all(Array.from({ length: Math.min(BATCH_DELETE_CONCURRENCY, Math.ceil(moves.length / BATCH_MOVE_MAX_FILES)) }, worker));
	if (failure) throw (failure as { error: unknown }).error;
	await context.localManifest.save();
	await context.journal.clear();
	return unmoved;
}

/** Resends journaled moves whose outcome is unknown, before anything is planned. The
 * server answers a committed move from its state, so a lost response is recorded here
 * even if the file was renamed again since; a move it never made is made now, and the next
 * sync sends whatever changed locally since. A move already recorded, or whose old path's
 * baseline changed, is dropped, as is everything once this vault cannot move files. A
 * request error keeps the journal and is thrown. */
export async function recoverRemoteMoves(context: MoveContext, canMove: boolean): Promise<void> {
	const pending = await context.journal.pending();
	if (!pending.length) return;
	const unresolved = canMove ? pending.filter(move => context.localManifest.getEntry(move.from)?.revision === move.expectedRevision) : [];
	if (unresolved.length) {
		context.reportWork?.({ phase: 'recovering', current: 0, total: unresolved.length });
		const result = createEmptySyncResult();
		for (let offset = 0; offset < unresolved.length; offset += BATCH_MOVE_MAX_FILES) {
			const chunk = unresolved.slice(offset, offset + BATCH_MOVE_MAX_FILES);
			const answers = new Map((await context.files.batchMove(chunk)).results.map(answer => [answer.from, answer]));
			for (const move of chunk) recordMove(context, move, answers.get(move.from), result);
			context.reportWork?.({ phase: 'recovering', current: Math.min(offset + chunk.length, unresolved.length), total: unresolved.length });
		}
		await context.localManifest.save();
	}
	await context.journal.clear();
}
