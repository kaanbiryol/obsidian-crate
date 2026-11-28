import { describe, expect, it, vi } from 'vitest';
import type { BatchMoveFile, BatchMoveResponse, FileEntry } from '../../protocol/sync-types';
import { BATCH_MOVE_MAX_FILES } from '../../protocol/sync-limits';
import { createEmptySyncResult } from '../sync-result';
import { LocalFilePresentError } from '../local/local-absence';
import { HttpError } from '../worker-api/http';
import { moveRemoteFiles, pairMoves, recoverRemoteMoves } from './move';

const hash = (letter: string) => letter.repeat(64);
const deleted = (path: string, letter: string) => ({ path, expectedHash: hash(letter), expectedRevision: `rev-${path}` });
const accept = async (moves: BatchMoveFile[]): Promise<BatchMoveResponse> => ({ success: true, results: moves.map(entry => ({ from: entry.from, to: entry.to, success: true, hash: entry.expectedHash, revision: entry.expectedRevision })) });

describe('pairMoves', () => {
	it('pairs a recorded rename, then any other unique hash, and never a case-only rename', () => {
		const moves = pairMoves(
			[deleted('a.md', 'a'), deleted('b.md', 'b'), deleted('todo.md', 'c'), deleted('dup-1.md', 'd'), deleted('dup-2.md', 'd'), { path: 'none.md', expectedHash: hash('e') }],
			[{ path: 'x/a.md', hash: hash('a') }, { path: 'y/b.md', hash: hash('b') }, { path: 'TODO.md', hash: hash('c') },
				{ path: 'copy.md', hash: hash('d') }, { path: 'none-new.md', hash: hash('e') }],
			path => path === 'a.md' ? 'x/a.md' : undefined,
		);
		expect(moves).toEqual([
			{ from: 'a.md', to: 'x/a.md', expectedHash: hash('a'), expectedRevision: 'rev-a.md' },
			{ from: 'b.md', to: 'y/b.md', expectedHash: hash('b'), expectedRevision: 'rev-b.md' },
		]);
	});

	it('does not pair a recorded rename whose new file has other bytes', () => {
		expect(pairMoves([deleted('a.md', 'a')], [{ path: 'b.md', hash: hash('f') }], () => 'b.md')).toEqual([]);
	});
});

describe('moveRemoteFiles', () => {
	function harness(batchMove: (moves: BatchMoveFile[]) => Promise<BatchMoveResponse>, present: string[] = []) {
		const entries = new Map<string, FileEntry>();
		const removed = new Set<string>();
		let journaled: BatchMoveFile[] = [];
		const context = {
			files: { batchMove: vi.fn(batchMove) },
			localManifest: {
				getEntry: (path: string) => removed.has(path) ? undefined : entries.get(path) ?? { hash: hash('a'), size: 3, modified: 'm', revision: `rev-${path}` },
				setEntry: vi.fn((path: string, entry: FileEntry) => { entries.set(path, entry); }),
				removeEntry: vi.fn((path: string) => { removed.add(path); }),
				save: vi.fn(async () => {}),
			},
			journal: {
				pending: async () => journaled,
				record: vi.fn(async (moves: readonly BatchMoveFile[]) => { journaled = [...moves]; }),
				clear: vi.fn(async () => { journaled = []; }),
			},
			journaled: () => journaled,
			assertLocalFileAbsent: async (path: string) => { if (present.includes(path)) throw new LocalFilePresentError(path); },
		};
		return context;
	}
	const move = (index: number): BatchMoveFile => ({ from: `old/${index}.md`, to: `new/${index}.md`, expectedHash: hash('a'), expectedRevision: `rev-old/${index}.md` });

	it('records acknowledged moves and returns refused, mismatched and reappeared ones', async () => {
		const context = harness(async moves => ({ success: false, results: [
			{ from: moves[0]!.from, to: moves[0]!.to, success: true, hash: moves[0]!.expectedHash, revision: moves[0]!.expectedRevision },
			{ from: moves[1]!.from, to: moves[1]!.to, success: false, code: 'move_unsupported', status: 409, error: 'no' },
			{ from: moves[2]!.from, to: moves[2]!.to, success: true, hash: hash('b'), revision: moves[2]!.expectedRevision },
		] }), ['old/3.md']);
		const result = createEmptySyncResult();
		const unmoved = await moveRemoteFiles(context, [move(0), move(1), move(2), move(3)], result);
		expect(context.files.batchMove).toHaveBeenCalledExactlyOnceWith([move(0), move(1), move(2)]);
		expect(unmoved.map(entry => entry.from)).toEqual(['old/3.md', 'old/1.md', 'old/2.md']);
		expect(result).toMatchObject({ uploaded: 1, deleted: 1, uploadedPaths: ['new/0.md'], deletedPaths: ['old/0.md'] });
		expect(context.localManifest.setEntry).toHaveBeenCalledExactlyOnceWith('new/0.md', { hash: hash('a'), size: 3, modified: 'unverified', revision: 'rev-old/0.md' });
		expect(context.localManifest.removeEntry).toHaveBeenCalledExactlyOnceWith('old/0.md');
	});

	it('records sibling acknowledgements before throwing a failed request', async () => {
		let calls = 0;
		const context = harness(async moves => { if (calls++ === 1) throw new HttpError('Storage unavailable', 503); return accept(moves); });
		const result = createEmptySyncResult();
		const moves = Array.from({ length: BATCH_MOVE_MAX_FILES * 2 }, (_, index) => move(index));
		await expect(moveRemoteFiles(context, moves, result)).rejects.toThrow('Storage unavailable');
		expect(result.uploadedPaths).toHaveLength(BATCH_MOVE_MAX_FILES);
		expect(context.localManifest.removeEntry).toHaveBeenCalledTimes(BATCH_MOVE_MAX_FILES);
		// The journal keeps every move until a saved manifest records them.
		expect(context.journaled()).toEqual(moves);
		expect(context.journal.clear).not.toHaveBeenCalled();
	});

	it('journals moves before the first request and clears them once the manifest is saved', async () => {
		const order: string[] = [];
		const context = harness(async moves => { order.push('request'); return accept(moves); });
		context.journal.record.mockImplementation(async () => { order.push('record'); });
		context.localManifest.save.mockImplementation(async () => { order.push('save'); });
		context.journal.clear.mockImplementation(async () => { order.push('clear'); });
		await moveRemoteFiles(context, [move(0)], createEmptySyncResult());
		expect(order).toEqual(['record', 'request', 'save', 'clear']);
		expect(context.journal.record).toHaveBeenCalledExactlyOnceWith([move(0)]);
	});
});

describe('recoverRemoteMoves', () => {
	function recovery(journaled: BatchMoveFile[], batchMove: (moves: BatchMoveFile[]) => Promise<BatchMoveResponse>, recorded: string[] = []) {
		const entries = new Map<string, FileEntry>();
		let pending = [...journaled];
		return {
			files: { batchMove: vi.fn(batchMove) },
			localManifest: {
				getEntry: (path: string) => entries.get(path) ?? (recorded.includes(path) || path.startsWith('new/') ? undefined : { hash: hash('a'), size: 3, modified: 'm', revision: `rev-${path}` }),
				setEntry: vi.fn((path: string, entry: FileEntry) => { entries.set(path, entry); }),
				removeEntry: vi.fn(),
				save: vi.fn(async () => {}),
			},
			journal: { pending: async () => pending, record: async () => {}, clear: vi.fn(async () => { pending = []; }) },
			assertLocalFileAbsent: async () => {},
		};
	}
	const move = (index: number): BatchMoveFile => ({ from: `old/${index}.md`, to: `new/${index}.md`, expectedHash: hash('a'), expectedRevision: `rev-old/${index}.md` });

	it('resends unrecorded moves, records what the server acknowledges and clears the journal', async () => {
		const context = recovery([move(0), move(1), move(2)], async moves => ({ success: false, results: [
			{ from: moves[0]!.from, to: moves[0]!.to, success: true, hash: moves[0]!.expectedHash, revision: moves[0]!.expectedRevision },
			{ from: moves[1]!.from, to: moves[1]!.to, success: false, code: 'version_conflict', status: 409, error: 'changed' },
		] }), ['old/2.md']);
		await recoverRemoteMoves(context, true);
		// old/2.md is already recorded, so only the others are asked about.
		expect(context.files.batchMove).toHaveBeenCalledExactlyOnceWith([move(0), move(1)]);
		expect(context.localManifest.setEntry).toHaveBeenCalledExactlyOnceWith('new/0.md', { hash: hash('a'), size: 3, modified: 'unverified', revision: 'rev-old/0.md' });
		expect(context.localManifest.removeEntry).toHaveBeenCalledExactlyOnceWith('old/0.md');
		expect(context.localManifest.save).toHaveBeenCalledOnce();
		expect(context.journal.clear).toHaveBeenCalledOnce();
	});

	it('keeps the journal when the server cannot be reached, and drops it once moves are impossible', async () => {
		const unreachable = recovery([move(0)], async () => { throw new HttpError('Storage unavailable', 503); });
		await expect(recoverRemoteMoves(unreachable, true)).rejects.toThrow('Storage unavailable');
		expect(unreachable.journal.clear).not.toHaveBeenCalled();

		const encrypted = recovery([move(0)], accept);
		await recoverRemoteMoves(encrypted, false);
		expect(encrypted.files.batchMove).not.toHaveBeenCalled();
		expect(encrypted.journal.clear).toHaveBeenCalledOnce();
	});
});
