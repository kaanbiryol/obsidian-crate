import { describe, expect, it, vi } from 'vitest';
import type { FileDiff, FileEntry } from '../plugin/types';
import { runSyncWorkflow, type SyncWorkflowContext } from './engine-standard-sync-workflow';

function createContext(options: {
	processDiff?: SyncWorkflowContext['processDiff'];
} = {}) {
	const localFiles: Record<string, FileEntry> = {
		'notes/a.md': {
			hash: 'local-hash',
			size: 5,
			modified: '2026-02-06T12:00:00.000Z',
		},
	};
	const uploadDiff: FileDiff = {
		path: 'notes/a.md',
		action: 'upload',
		localHash: 'local-hash',
		remoteHash: 'remote-hash',
	};
	const spies = {
		apiConfigured: vi.fn(() => true),
		getStatus: vi.fn((): ReturnType<SyncWorkflowContext['getStatus']> => 'idle'),
		updateState: vi.fn(),
		getManifest: vi.fn(async () => ({ files: {}, lastSeq: 9 })),
		incrementalSync: vi.fn(async () => null),
		isAbortError: vi.fn(() => false),
		throwIfDestroyed: vi.fn(),
		createFullSyncPlan: vi.fn(async () => ({
			localFiles,
			diffs: [uploadDiff],
			uploadDiffs: [uploadDiff],
			downloadDiffs: [],
			remainingDiffs: [],
			errors: [],
		})),
		processDiff: vi.fn(options.processDiff ?? (async () => {})),
		parallelDownloadAndSaveFiles: vi.fn(async () => {}),
		readBinary: vi.fn(async () => new ArrayBuffer(0)),
		getModifiedIso: vi.fn(async () => '2026-02-06T12:00:00.000Z'),
		setLocalManifestEntry: vi.fn(),
		saveLocalManifest: vi.fn(async () => {}),
		setLastSync: vi.fn(),
		setLastSeq: vi.fn(),
	};

	const context: SyncWorkflowContext = {
		apiConfigured: spies.apiConfigured,
		getStatus: spies.getStatus,
		updateState: spies.updateState,
		getManifest: spies.getManifest,
		incrementalSync: spies.incrementalSync,
		isAbortError: spies.isAbortError,
		throwIfDestroyed: spies.throwIfDestroyed,
		createFullSyncPlan: spies.createFullSyncPlan,
		processDiff: spies.processDiff,
		parallelDownloadAndSaveFiles: spies.parallelDownloadAndSaveFiles,
		runConcurrent: async <T>(tasks: Array<() => Promise<T>>, _concurrency: number): Promise<T[]> =>
			Promise.all(tasks.map(task => task())),
		readBinary: spies.readBinary,
		getModifiedIso: spies.getModifiedIso,
		setLocalManifestEntry: spies.setLocalManifestEntry,
		saveLocalManifest: spies.saveLocalManifest,
		setLastSync: spies.setLastSync,
		setLastSeq: spies.setLastSeq,
	};

	return { context, localFiles, spies, uploadDiff };
}

describe('runSyncWorkflow', () => {
	it('does not bulk-promote scanned local manifest entries after full-sync errors', async () => {
		const { context, spies } = createContext({
			processDiff: vi.fn(async () => {
				throw new Error('quota exceeded');
			}),
		});

		const result = await runSyncWorkflow(context);

		expect(result.success).toBe(false);
		expect(result.errors).toEqual(['notes/a.md: quota exceeded']);
		expect(spies.setLocalManifestEntry).not.toHaveBeenCalled();
		expect(spies.saveLocalManifest).toHaveBeenCalledTimes(1);
		expect(spies.setLastSync).not.toHaveBeenCalled();
		expect(spies.setLastSeq).not.toHaveBeenCalled();
		expect(spies.updateState).toHaveBeenLastCalledWith({
			status: 'error',
			lastError: 'notes/a.md: quota exceeded',
			conflictCount: 0,
		});
	});

	it('bulk-promotes scanned local manifest entries after an error-free full sync', async () => {
		const { context, localFiles, spies } = createContext();

		const result = await runSyncWorkflow(context);

		expect(result.success).toBe(true);
		expect(spies.setLocalManifestEntry).toHaveBeenCalledWith('notes/a.md', localFiles['notes/a.md']);
		expect(spies.setLastSync).toHaveBeenCalledWith(expect.any(String));
		expect(spies.setLastSeq).toHaveBeenCalledWith(9);
	});
});
