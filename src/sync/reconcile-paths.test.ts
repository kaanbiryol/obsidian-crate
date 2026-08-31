import { describe, expect, it, vi } from 'vitest';
import { HttpError } from './api';
import { computeHash } from './hasher';
import { reconcileQueuePaths, type TargetedReconcileContext } from './reconcile-paths';
import type { FileEntry, FileManifest, SyncResult } from '../plugin/types';

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function createHarness(options: {
	baseHash: string;
	localText: string;
	remoteManifests: FileManifest[];
}) {
	const localContent = bytes(options.localText);
	const baseEntry: FileEntry = {
		hash: options.baseHash,
		size: 4,
		modified: '2026-02-15T00:00:00.000Z',
	};
	const adapter = {
		exists: vi.fn(async () => false),
		readBinary: vi.fn(async () => localContent),
	};
	const vault = {
		adapter,
		getAbstractFileByPath: vi.fn((path: string) => ({ path, extension: 'md' })),
	};
	let manifestIndex = 0;
	const processDiff = vi.fn<TargetedReconcileContext['processDiff']>(async (_diff, _localFiles, result: SyncResult) => {
		result.merged++;
		result.mergedPaths.push('notes/a.md');
	});
	const getRemoteManifest = vi.fn(async () =>
		options.remoteManifests[Math.min(manifestIndex++, options.remoteManifests.length - 1)]!);
	const localManifest = {
		getEntry: vi.fn(() => baseEntry),
		setEntry: vi.fn(),
		removeEntry: vi.fn(),
		save: vi.fn(async () => {}),
	};
	const context: TargetedReconcileContext = {
		vault: vault as never,
		localManifest,
		getRemoteManifest,
		shouldIgnore: vi.fn(() => false),
		getModifiedIso: vi.fn(async () => '2026-02-15T00:00:00.000Z'),
		processDiff,
	};
	return { context, processDiff, getRemoteManifest, localManifest, adapter };
}

describe('reconcileQueuePaths', () => {
	it('classifies and reconciles only the queue path that lost the version race', async () => {
		const localText = 'local edit';
		const localHash = await computeHash(bytes(localText));
		const harness = await createHarness({
			baseHash: 'base',
			localText,
			remoteManifests: [{
				version: 1,
				files: {
					'notes/a.md': { hash: 'remote-edit', size: 11, modified: 'now' },
					'notes/unrelated.md': { hash: 'other', size: 5, modified: 'now' },
				},
			}],
		});

		const result = await reconcileQueuePaths(harness.context, ['notes/a.md']);

		expect(harness.processDiff.mock.calls[0]?.[0]).toEqual({
				path: 'notes/a.md',
				action: 'conflict',
				localHash,
				remoteHash: 'remote-edit',
				cause: 'concurrent-edit',
			});
		expect(harness.processDiff.mock.calls[0]?.[1]['notes/a.md']?.hash).toBe(localHash);
		expect(harness.adapter.readBinary).toHaveBeenCalledTimes(1);
		expect(result.settledPaths).toEqual(['notes/a.md']);
		expect(result.success).toBe(true);
	});

	it('replans a path after a second compare-and-swap conflict', async () => {
		const harness = await createHarness({
			baseHash: 'base',
			localText: 'local edit',
			remoteManifests: [
				{ version: 1, files: { 'notes/a.md': { hash: 'remote-v2', size: 1, modified: 'now' } } },
				{ version: 1, files: { 'notes/a.md': { hash: 'remote-v3', size: 1, modified: 'now' } } },
			],
		});
		harness.processDiff
			.mockRejectedValueOnce(new HttpError('remote changed again', 409))
			.mockImplementationOnce(async (_diff, _localFiles, result: SyncResult) => {
				result.merged++;
				result.mergedPaths.push('notes/a.md');
			});

		const result = await reconcileQueuePaths(harness.context, ['notes/a.md']);

		expect(harness.getRemoteManifest).toHaveBeenCalledTimes(2);
		expect(harness.processDiff).toHaveBeenCalledTimes(2);
		expect(harness.processDiff.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ remoteHash: 'remote-v3' }));
		expect(result.settledPaths).toEqual(['notes/a.md']);
		expect(result.errors).toEqual([]);
	});
});
