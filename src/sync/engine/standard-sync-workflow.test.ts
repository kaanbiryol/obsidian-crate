import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff, SyncResult } from '../types';
import type { FileEntry } from '../../protocol/sync-types';
import { runSyncWorkflow, type SyncWorkflowContext } from './standard-sync-workflow';
import { AUTH_ERROR_MESSAGE, ReconnectNotice } from '../sync-outcome';
import { recordSyncError } from '../issues';
import { Notice } from '../../test/mocks/obsidian';

function createContext(options: {
	prepareFullSyncUpload?: SyncWorkflowContext['prepareFullSyncUpload'];
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
		cause: 'local-edited',
	};
	const spies = {
		apiConfigured: vi.fn(() => true),
		finishInitialSetup: vi.fn(async () => {}),
		recoverUploads: vi.fn(async () => {}),
		getStatus: vi.fn((): ReturnType<SyncWorkflowContext['getStatus']> => 'idle'),
		updateState: vi.fn(),
		getManifest: vi.fn(async () => ({ files: {}, lastSeq: 9 })),
		incrementalSync: vi.fn(async () => null),
		throwIfDestroyed: vi.fn(),
		createFullSyncPlan: vi.fn(async () => ({
			localFiles,
			diffs: [uploadDiff],
			uploadDiffs: [uploadDiff],
			downloadDiffs: [],
			remainingDiffs: [],
			errors: [],
		})),
		deleteRemoteFiles: vi.fn<SyncWorkflowContext['deleteRemoteFiles']>(async () => []),
		processDiff: vi.fn(async () => ({ status: 'applied' as const })),
		prepareFullSyncUpload: vi.fn(options.prepareFullSyncUpload ?? (async () => ({ path: 'notes/a.md', content: new ArrayBuffer(5), hash: 'local-hash', size: 5 }))),
		uploadPreparedFiles: vi.fn<SyncWorkflowContext['uploadPreparedFiles']>(async () => {}),
		parallelDownloadAndSaveFiles: vi.fn(async () => {}),
		getLocalManifestEntry: vi.fn((path: string) => localFiles[path]),
		setLocalManifestEntry: vi.fn(),
		saveLocalManifest: vi.fn(async () => {}),
		setLastSync: vi.fn(),
		setLastSeq: vi.fn(),
	};

	const context: SyncWorkflowContext = {
		apiConfigured: spies.apiConfigured,
		recoverUploads: spies.recoverUploads,
		finishInitialSetup: spies.finishInitialSetup,
		getStatus: spies.getStatus,
		updateState: spies.updateState,
		getManifest: spies.getManifest,
		incrementalSync: spies.incrementalSync,
		throwIfDestroyed: spies.throwIfDestroyed,
		createFullSyncPlan: spies.createFullSyncPlan,
		processDiff: spies.processDiff,
		deleteRemoteFiles: spies.deleteRemoteFiles,
		parallelDownloadAndSaveFiles: spies.parallelDownloadAndSaveFiles,
		prepareFullSyncUpload: spies.prepareFullSyncUpload,
		uploadPreparedFiles: spies.uploadPreparedFiles,
		getLocalManifestEntry: spies.getLocalManifestEntry,
		setLocalManifestEntry: spies.setLocalManifestEntry,
		saveLocalManifest: spies.saveLocalManifest,
		setLastSync: spies.setLastSync,
		setLastSeq: spies.setLastSeq,
		reconnectNotice: new ReconnectNotice(),
	};

	return { context, localFiles, spies, uploadDiff };
}

describe('runSyncWorkflow', () => {
	it.each([[true, true], [false, false]])('reuses unchanged hashes in a fallback full sync only with a cursor (%s)', async (cursor, reuse) => {
		const { context, spies } = createContext();
		context.hasSyncCursor = () => cursor;
		await runSyncWorkflow(context);
		expect(spies.createFullSyncPlan).toHaveBeenCalledWith({}, expect.any(Number), { reuseUnchangedHashes: reuse });
	});

	it('retains acknowledged uploads and prior issues when a later transfer is cancelled', async () => {
		const { context, spies } = createContext();
		spies.uploadPreparedFiles.mockImplementation(async (_uploads, result) => {
			result.uploaded = 1;
			result.uploadedPaths.push('saved.md');
			result.errors.push('earlier.md: unreadable');
			throw new DOMException('Transfer cancelled', 'AbortError');
		});
		expect(await runSyncWorkflow(context)).toMatchObject({
			outcome: 'cancelled', success: false, uploaded: 1, uploadedPaths: ['saved.md'], errors: ['earlier.md: unreadable'],
		});
		expect(spies.setLastSync).not.toHaveBeenCalled();
		expect(spies.setLastSeq).not.toHaveBeenCalled();
		expect(spies.finishInitialSetup).not.toHaveBeenCalled();
		expect(spies.updateState).toHaveBeenLastCalledWith({ status: 'idle' });
	});

	it('reports a vanished upload and leaves scanned state unconfirmed', async () => {
		const { context, spies } = createContext({ prepareFullSyncUpload: async () => null });
		const progress = vi.fn();
		const result = await runSyncWorkflow(context, progress);
		expect(result.errors).toEqual(['notes/a.md: Local file changed or disappeared while preparing the upload']);
		expect(spies.uploadPreparedFiles).not.toHaveBeenCalled();
		expect(spies.setLocalManifestEntry).not.toHaveBeenCalled();
		expect(spies.setLastSeq).not.toHaveBeenCalled();
		expect(progress).toHaveBeenLastCalledWith(1, 1);
	});
	it('does not bulk-promote scanned local manifest entries after full-sync errors', async () => {
		const { context, spies } = createContext({
			prepareFullSyncUpload: vi.fn(async () => {
				throw new Error('quota exceeded');
			}),
		});

		const result = await runSyncWorkflow(context);

		expect(result.success).toBe(false);
		expect(result.outcome).toBe('failed');
		expect(result.errors).toEqual(['notes/a.md: quota exceeded']);
		expect(spies.setLocalManifestEntry).not.toHaveBeenCalled();
		expect(spies.saveLocalManifest).toHaveBeenCalledTimes(1);
		expect(spies.setLastSync).not.toHaveBeenCalled();
		expect(spies.setLastSeq).not.toHaveBeenCalled();
		expect(spies.updateState).toHaveBeenLastCalledWith({
			status: 'error',
			lastError: 'notes/a.md: quota exceeded',
			lastIssues: [{ path: 'notes/a.md', message: 'quota exceeded' }],
		});
	});

	it('bulk-promotes scanned local manifest entries after an error-free full sync', async () => {
		const { context, localFiles, spies } = createContext();

		const result = await runSyncWorkflow(context);

		expect(result.success).toBe(true);
		expect(result.outcome).toBe('completed');
		expect(spies.setLocalManifestEntry).toHaveBeenCalledWith('notes/a.md', localFiles['notes/a.md']);
		expect(spies.setLastSync).toHaveBeenCalledWith(expect.any(String));
		expect(spies.setLastSeq).toHaveBeenCalledWith(9);
	});

	it('records an edit/delete conflict after the remote edit is restored', async () => {
		const { context } = createContext();
		const path = 'notes/restored.md';
		const remoteContent = new TextEncoder().encode('remote edit').buffer;
		const downloadDiff: FileDiff = {
			path,
			action: 'download',
			remoteHash: 'remote-hash',
			cause: 'local-deleted',
		};
		context.getManifest = vi.fn(async () => ({
			files: {
				[path]: { hash: 'remote-hash', size: remoteContent.byteLength, modified: 'now' },
			},
			lastSeq: 9,
		}));
		context.createFullSyncPlan = vi.fn(async () => ({
			localFiles: {},
			diffs: [downloadDiff],
			uploadDiffs: [],
			downloadDiffs: [downloadDiff],
			remainingDiffs: [],
			errors: [],
		}));
		context.parallelDownloadAndSaveFiles = vi.fn(async (_requests: unknown, result: SyncResult) => {
			result.downloaded++;
			result.downloadedPaths.push(path);
		});
		context.getLocalManifestEntry = vi.fn(() => ({
			hash: 'remote-hash',
			size: remoteContent.byteLength,
			modified: 'now',
		}));

		const result = await runSyncWorkflow(context);

		expect(result.conflicts).toEqual([]);
		expect(result.resolvedRaces).toContainEqual({ path, resolution: 'kept-remote-edit' });
		expect(result.downloadedPaths).toContain(path);
	});
	describe('per-file authorization failures in a full sync', () => {
		beforeEach(() => Notice.reset());

		function expectReconnect(result: SyncResult, spies: ReturnType<typeof createContext>['spies']) {
			expect(result).toMatchObject({ outcome: 'failed', success: false });
			expect(result.errors).toContain(AUTH_ERROR_MESSAGE);
			expect(spies.updateState).toHaveBeenLastCalledWith({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
			expect(Notice.messages).toEqual([AUTH_ERROR_MESSAGE]);
			expect(spies.setLastSync).not.toHaveBeenCalled();
			expect(spies.setLastSeq).not.toHaveBeenCalled();
		}

		it('reports a rejected upload with the reconnect message', async () => {
			const { context, spies } = createContext();
			spies.uploadPreparedFiles.mockImplementation(async (prepared, result, options) => {
				for (const upload of prepared) {
					recordSyncError(result, 'Unauthorized', upload.path);
					options.onFailure?.({ path: upload.path, error: 'Unauthorized', status: 401 });
				}
			});
			expectReconnect(await runSyncWorkflow(context), spies);
		});

		it('reports a rejected remote deletion with the reconnect message', async () => {
			const { context, spies } = createContext();
			const deleteDiff: FileDiff = { path: 'notes/old.md', action: 'delete', remoteHash: 'remote-hash', cause: 'local-deleted' };
			context.createFullSyncPlan = vi.fn(async () => ({
				localFiles: {}, diffs: [deleteDiff], uploadDiffs: [], downloadDiffs: [], remainingDiffs: [deleteDiff], errors: [],
			}));
			spies.deleteRemoteFiles.mockImplementation(async (files, result) => files.map(file => {
				recordSyncError(result, 'Unauthorized', file.path);
				return { path: file.path, error: 'Unauthorized', status: 401 };
			}));
			expectReconnect(await runSyncWorkflow(context), spies);
		});
	});
});
