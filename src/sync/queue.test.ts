import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clearSyncedPendingPaths,
	debouncedSync,
	onFileChange,
	onFileDelete,
	onFileRename,
} from './queue';
import { processPendingChanges } from './queue-flush';
import type { PreparedUpload, SyncResult, SyncState } from './types';
import { HttpError } from './api';
import { LocalFilePresentError } from './local-absence';

type QueueState = SyncState;
type UploadArgs = {
	path: string;
	content: ArrayBuffer;
	hash: string;
	size: number;
	contentType: string;
};

function createEventContext() {
	const pendingPaths = new Set<string>();
	const pendingRevisions = new Map<string, number>();
	let revision = 0;
	const triggerDebouncedSync = vi.fn();
	const shouldIgnore = vi.fn((path: string) => path.startsWith('.trash/'));
	return {
		context: {
			pendingPaths,
			shouldIgnore,
			markPending: (path: string) => pendingRevisions.set(path, ++revision),
			clearPending: (path: string) => pendingRevisions.delete(path),
			triggerDebouncedSync,
		},
		pendingPaths,
		pendingRevisions,
		triggerDebouncedSync,
	};
}

function createFlushHarness(overrides: Partial<{
	status: QueueState['status'];
	configured: boolean;
	prepareUploadFromPath: (path: string) => Promise<PreparedUpload | null>;
	uploadFile: (args: {
		path: string;
		content: ArrayBuffer;
		hash: string;
		size: number;
		contentType: string;
	}) => Promise<{ success: boolean; path: string; hash?: string; error?: string }>;
	deleteFile: (path: string) => Promise<{ success: boolean; path: string }>;
	batchDelete: (paths: string[]) => Promise<{ success: boolean; deleted: string[] }>;
}> = {}) {
	const pendingPaths = new Set<string>();
	const inFlightPaths = new Set<string>();
	const pendingRevisions = new Map<string, number>();
	const state: QueueState = {
		status: overrides.status ?? 'idle',
		lastSync: null,
		lastError: null,
		pendingChanges: 0,
		conflictCount: 0,
	};
	const updateStateCalls: Partial<QueueState>[] = [];
	const updateState = vi.fn((updates: Partial<QueueState>) => {
		updateStateCalls.push(updates);
		Object.assign(state, updates);
	});
	const triggerDebouncedSync = vi.fn();
	const requestReconciliation = vi.fn();
	const onFlushResult = vi.fn(async () => {});
	const prepareUploadFromPath = vi.fn(
		overrides.prepareUploadFromPath ??
			(async () => null),
	);
	const uploadFile = vi.fn(
		overrides.uploadFile ??
			(async ({ path }: UploadArgs) => ({ success: true, path })),
	);
	const deleteFile = vi.fn(
		overrides.deleteFile ??
			(async (path: string) => ({ success: true, path })),
	);
	const batchDelete = vi.fn(
		overrides.batchDelete ??
			(async (paths: string[]) => ({ success: true, deleted: paths })),
	);
	const setEntry = vi.fn();
	const removeEntry = vi.fn();
	const save = vi.fn(async () => {});
	const getModifiedIso = vi.fn(async () => '2026-02-15T00:00:00.000Z');

	return {
		state,
		pendingPaths,
		pendingRevisions,
		updateState,
		updateStateCalls,
		triggerDebouncedSync,
		requestReconciliation,
		onFlushResult,
		prepareUploadFromPath,
		uploadFile,
		deleteFile,
		batchDelete,
		setEntry,
		removeEntry,
		save,
		getModifiedIso,
		context: {
			recoverUploads: vi.fn(async () => {}),
			pendingPaths,
			inFlightPaths,
			pendingRevisions,
			api: {
				isConfigured: vi.fn(() => overrides.configured ?? true),
				uploadFile: (path: string, content: ArrayBuffer, hash: string, size: number, contentType: string) =>
					uploadFile({ path, content, hash, size, contentType }),
				deleteFile,
				batchDelete,
			},
			localManifest: {
				getEntry: vi.fn(() => ({
					hash: 'd'.repeat(64), revision: 'version-1',
					size: 1,
					modified: '2026-02-15T00:00:00.000Z',
				})),
				setEntry,
				removeEntry,
				save,
			},
			updateState,
			isDestroyed: () => false,
			currentStatus: () => state.status,
			prepareUploadFromPath,
			assertLocalFileAbsent: vi.fn(async () => {}),
			runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
			getModifiedIso,
			triggerDebouncedSync,
			requestReconciliation,
			onFlushResult,
		},
	};
}

function createSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		success: true,
		uploaded: 0,
		downloaded: 0,
		merged: 0,
		deleted: 0,
		conflicts: [],
		unresolvedConflicts: [],
		resolvedRaces: [],
		settledPaths: [],
		errors: [],
		uploadedPaths: [],
		downloadedPaths: [],
		mergedPaths: [],
		deletedPaths: [],
		...overrides,
	};
}

function createNamedAbortError(message = 'Sync request aborted'): Error {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

describe('queue event handlers', () => {
	it('queues file changes for syncable paths', () => {
		const { context, pendingPaths, triggerDebouncedSync } = createEventContext();

		onFileChange(context, { path: 'notes/a.md' } as never);

		expect(pendingPaths.has('notes/a.md')).toBe(true);
		expect(triggerDebouncedSync).toHaveBeenCalledTimes(1);
	});

	it('queues delete markers for syncable paths', () => {
		const { context, pendingPaths, triggerDebouncedSync } = createEventContext();

		onFileDelete(context, { path: 'notes/a.md' } as never);

		expect(pendingPaths.has('delete:notes/a.md')).toBe(true);
		expect(triggerDebouncedSync).toHaveBeenCalledTimes(1);
	});

	it('handles rename transitions across ignored boundaries', () => {
		const { context, pendingPaths, triggerDebouncedSync } = createEventContext();

		onFileRename(context, { path: '.trash/a.md' } as never, 'notes/a.md');
		onFileRename(context, { path: 'notes/b.md' } as never, '.trash/b.md');

		expect(pendingPaths.has('delete:notes/a.md')).toBe(true);
		expect(pendingPaths.has('notes/b.md')).toBe(true);
		expect(pendingPaths.has('.trash/b.md')).toBe(false);
		expect(triggerDebouncedSync).toHaveBeenCalledTimes(2);
	});
});

describe('debouncedSync', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('updates pending count and triggers flush after delay', async () => {
		vi.useFakeTimers();
		const pendingPaths = new Set(['notes/a.md']);
		let timer: ReturnType<typeof setTimeout> | null = null;
		let maxWaitStart: number | null = null;
		const updateState = vi.fn();
		const processPending = vi.fn(async () => {});

		debouncedSync(
			{
				pendingPaths,
				isDestroyed: () => false,
				getDebounceTimer: () => timer,
				setDebounceTimer: value => {
					timer = value;
				},
				getMaxWaitStart: () => maxWaitStart,
				setMaxWaitStart: value => {
					maxWaitStart = value;
				},
				updateState,
				processPendingChanges: processPending,
			},
			25,
		);

		expect(updateState).toHaveBeenCalledWith({ pendingChanges: 1 });
		expect(timer).not.toBeNull();

		await vi.advanceTimersByTimeAsync(25);

		expect(processPending).toHaveBeenCalledTimes(1);
		expect(timer).toBeNull();
		expect(maxWaitStart).toBeNull();
	});

	it('no-ops when queue is destroyed', () => {
		const updateState = vi.fn();
		const processPending = vi.fn(async () => {});

		debouncedSync(
			{
				pendingPaths: new Set(['notes/a.md']),
				isDestroyed: () => true,
				getDebounceTimer: () => null,
				setDebounceTimer: vi.fn(),
				getMaxWaitStart: () => null,
				setMaxWaitStart: vi.fn(),
				updateState,
				processPendingChanges: processPending,
			},
			25,
		);

		expect(updateState).not.toHaveBeenCalled();
		expect(processPending).not.toHaveBeenCalled();
	});

	it('fires immediately when max-wait is exceeded', () => {
		vi.useFakeTimers();
		const pendingPaths = new Set(['notes/a.md']);
		let timer: ReturnType<typeof setTimeout> | null = null;
		let maxWaitStart: number | null = Date.now() - 100; // started 100ms ago
		const updateState = vi.fn();
		const processPending = vi.fn(async () => {});

		const context = {
			pendingPaths,
			isDestroyed: () => false,
			getDebounceTimer: () => timer,
			setDebounceTimer: (value: ReturnType<typeof setTimeout> | null) => {
				timer = value;
			},
			getMaxWaitStart: () => maxWaitStart,
			setMaxWaitStart: (value: number | null) => {
				maxWaitStart = value;
			},
			updateState,
			processPendingChanges: processPending,
		};

		// Simulate an existing timer (debounce in progress)
		timer = setTimeout(() => {}, 10000);

		debouncedSync(context, 25, 50); // maxWait=50ms, but we're already 100ms in

		expect(processPending).toHaveBeenCalledTimes(1);
		expect(timer).toBeNull();
		expect(maxWaitStart).toBeNull();
	});
});

describe('clearSyncedPendingPaths', () => {
	it('removes successful uploaded, downloaded, merged, and deleted paths from the queue', () => {
		const pendingPaths = new Set([
			'notes/uploaded.md',
			'notes/downloaded.md',
			'notes/merged.md',
			'delete:notes/deleted.md',
		]);
		const clearDebounceTimer = vi.fn();
		const updateState = vi.fn();

		clearSyncedPendingPaths(
			{ pendingPaths, clearDebounceTimer, updateState },
			createSyncResult({
				uploadedPaths: ['notes/uploaded.md'],
				downloadedPaths: ['notes/downloaded.md'],
				mergedPaths: ['notes/merged.md'],
				deletedPaths: ['notes/deleted.md'],
			}),
		);

		expect(pendingPaths.size).toBe(0);
		expect(clearDebounceTimer).toHaveBeenCalledTimes(1);
		expect(updateState).toHaveBeenCalledWith({ pendingChanges: 0 });
	});

	it('keeps unrelated pending paths and updates the pending count', () => {
		const pendingPaths = new Set([
			'notes/uploaded.md',
			'notes/still-pending.md',
		]);
		const clearDebounceTimer = vi.fn();
		const updateState = vi.fn();

		clearSyncedPendingPaths(
			{ pendingPaths, clearDebounceTimer, updateState },
			createSyncResult({ uploadedPaths: ['notes/uploaded.md'] }),
		);

		expect([...pendingPaths]).toEqual(['notes/still-pending.md']);
		expect(clearDebounceTimer).not.toHaveBeenCalled();
		expect(updateState).toHaveBeenCalledWith({ pendingChanges: 1 });
	});

	it('does not change the queue when the sync result failed', () => {
		const pendingPaths = new Set(['notes/a.md']);
		const clearDebounceTimer = vi.fn();
		const updateState = vi.fn();

		clearSyncedPendingPaths(
			{ pendingPaths, clearDebounceTimer, updateState },
			createSyncResult({ success: false, uploadedPaths: ['notes/a.md'] }),
		);

		expect([...pendingPaths]).toEqual(['notes/a.md']);
		expect(clearDebounceTimer).not.toHaveBeenCalled();
		expect(updateState).not.toHaveBeenCalled();
	});

	it('keeps a newer event for the same path during sync reconciliation', () => {
		const pendingPaths = new Set(['notes/a.md']);
		const pendingRevisions = new Map([['notes/a.md', 2]]);
		const clearDebounceTimer = vi.fn();
		const updateState = vi.fn();

		clearSyncedPendingPaths(
			{ pendingPaths, pendingRevisions, clearDebounceTimer, updateState },
			createSyncResult({ uploadedPaths: ['notes/a.md'] }),
			new Map([['notes/a.md', 1]]),
		);

		expect([...pendingPaths]).toEqual(['notes/a.md']);
		expect(pendingRevisions.get('notes/a.md')).toBe(2);
		expect(updateState).not.toHaveBeenCalled();
	});

	it('coalesces opposite upload and delete events for one path', () => {
		const eventContext = createEventContext();
		onFileDelete(eventContext.context, { path: 'notes/a.md' } as never);
		onFileChange(eventContext.context, { path: 'notes/a.md' } as never);

		expect([...eventContext.pendingPaths]).toEqual(['notes/a.md']);
		expect([...eventContext.pendingRevisions.keys()]).toEqual(['notes/a.md']);
	});
});

describe('processPendingChanges', () => {
	it('uploads bounded chunks before preparing the entire queue', async () => {
		const harness = createFlushHarness({ prepareUploadFromPath: async path => ({
			path, content: new ArrayBuffer(1), size: 1, hash: 'hash', mtime: 1,
		}) });
		for (let i = 0; i < 300; i++) harness.pendingPaths.add(`image-${i}.png`);
		await processPendingChanges(harness.context, 2);
		expect(harness.uploadFile).toHaveBeenCalledTimes(300);
		expect(harness.uploadFile.mock.invocationCallOrder[0])
			.toBeLessThan(harness.prepareUploadFromPath.mock.invocationCallOrder[299]!);
		expect(harness.pendingPaths.size).toBe(0);
	});
	it('flushes uploads/deletes and updates manifest/state on success', async () => {
		const harness = createFlushHarness({
			prepareUploadFromPath: async path => ({
				path,
				content: new TextEncoder().encode('hello').buffer as ArrayBuffer,
				hash: 'abc123',
				size: 5,
				mtime: 1,
				contentType: 'text/plain',
			}),
		});
		harness.pendingPaths.add('notes/a.md');
		harness.pendingPaths.add('delete:notes/old.md');

		await processPendingChanges(harness.context, 4);

		expect(harness.uploadFile).toHaveBeenCalledTimes(1);
		expect(harness.batchDelete).toHaveBeenCalledWith(
			['notes/old.md'],
			{ 'notes/old.md': 'd'.repeat(64) },
      { 'notes/old.md': 'version-1' },
		);
		expect(harness.setEntry).toHaveBeenCalledWith(
			'notes/a.md',
			expect.objectContaining({ hash: 'abc123', size: 5, modified: '2026-02-15T00:00:00.000Z' }),
		);
		expect(harness.removeEntry).toHaveBeenCalledWith('notes/old.md');
		expect(harness.save).toHaveBeenCalledTimes(1);
		expect(harness.state.status).toBe('idle');
		expect(harness.state.lastError).toBeNull();
		expect(harness.pendingPaths.size).toBe(0);
		expect(harness.triggerDebouncedSync).not.toHaveBeenCalled();
		expect(harness.onFlushResult).toHaveBeenCalledWith(expect.objectContaining({
			success: true,
			uploaded: 1,
			deleted: 1,
			uploadedPaths: ['notes/a.md'],
			deletedPaths: ['notes/old.md'],
		}));
	});

	it('reschedules when a sync is already in progress', async () => {
		const harness = createFlushHarness({ status: 'syncing' });
		harness.pendingPaths.add('notes/a.md');

		await processPendingChanges(harness.context, 4);

		expect(harness.triggerDebouncedSync).toHaveBeenCalledTimes(1);
		expect(harness.uploadFile).not.toHaveBeenCalled();
		expect(harness.pendingPaths.has('notes/a.md')).toBe(true);
	});

	it('leaves queue pending when API is not configured', async () => {
		const harness = createFlushHarness({ configured: false });
		harness.pendingPaths.add('notes/a.md');

		await processPendingChanges(harness.context, 4);

		expect(harness.uploadFile).not.toHaveBeenCalled();
		expect(harness.pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.triggerDebouncedSync).not.toHaveBeenCalled();
	});

	it('requeues failed batch and records error state', async () => {
		const harness = createFlushHarness({
			prepareUploadFromPath: async path => ({
				path,
				content: new TextEncoder().encode('hello').buffer as ArrayBuffer,
				hash: 'abc123',
				size: 5,
				mtime: 1,
				contentType: 'text/plain',
			}),
			uploadFile: async ({ path }) => ({
				success: false,
				path,
				error: 'quota exceeded',
			}),
		});
		harness.pendingPaths.add('notes/a.md');

		await processPendingChanges(harness.context, 4);

		expect(harness.state.status).toBe('error');
		expect(harness.state.lastError).toContain('quota exceeded');
		expect(harness.pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.triggerDebouncedSync).toHaveBeenCalledTimes(1);
		expect(harness.onFlushResult).toHaveBeenCalledWith(expect.objectContaining({
			success: false,
			uploaded: 0,
			errors: ['notes/a.md: quota exceeded'],
		}));
	});

	it('runs full reconciliation after a permanent version conflict', async () => {
		const harness = createFlushHarness({
			prepareUploadFromPath: async path => ({
				path,
				content: new TextEncoder().encode('hello').buffer as ArrayBuffer,
				hash: 'abc123',
				size: 5,
				contentType: 'text/plain',
			}),
			uploadFile: async () => {
				throw new HttpError('remote changed', 409);
			},
		});
		harness.pendingPaths.add('notes/a.md');
		harness.pendingRevisions.set('notes/a.md', 1);

		await processPendingChanges(harness.context, 4);

		expect(harness.state.status).toBe('error');
		expect(harness.pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.triggerDebouncedSync).not.toHaveBeenCalled();
		expect(harness.requestReconciliation).toHaveBeenCalledTimes(1);
		expect(harness.requestReconciliation).toHaveBeenCalledWith(['notes/a.md']);
	});

	it('keeps authentication failures pending without attempting reconciliation or automatic retry', async () => {
		const harness = createFlushHarness({
			prepareUploadFromPath: async path => ({
				path,
				content: new TextEncoder().encode('hello').buffer as ArrayBuffer,
				hash: 'abc123',
				size: 5,
				contentType: 'text/plain',
			}),
			uploadFile: async () => {
				throw new HttpError('unauthorized', 401);
			},
		});
		harness.pendingPaths.add('notes/a.md');

		await processPendingChanges(harness.context, 4);

		expect(harness.pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.requestReconciliation).not.toHaveBeenCalled();
		expect(harness.triggerDebouncedSync).not.toHaveBeenCalled();
		expect(harness.state.lastError).toContain('unauthorized');
	});

	it('keeps a namespace conflict pending for explicit repair without reconciling or retrying it', async () => {
		const harness = createFlushHarness({
			prepareUploadFromPath: async path => ({ path, content: new ArrayBuffer(1), hash: 'local', size: 1 }),
			uploadFile: async () => { throw new HttpError('Rename the conflicting file or parent folder', 409, null, 'namespace_conflict'); },
		});
		harness.pendingPaths.add('Projects.md');
		await processPendingChanges(harness.context, 1);
		expect(harness.pendingPaths.has('Projects.md')).toBe(true);
		expect(harness.requestReconciliation).not.toHaveBeenCalled();
		expect(harness.triggerDebouncedSync).not.toHaveBeenCalled();
		expect(harness.state.lastError).toContain('Rename the conflicting file');
	});

	it('chunks mass deletes to the shared server limit', async () => {
		const harness = createFlushHarness();
		for (let index = 0; index < 14; index++) {
			harness.pendingPaths.add(`delete:notes/${index}.md`);
		}

		await processPendingChanges(harness.context, 4);

		expect(harness.batchDelete.mock.calls.map(([paths]) => paths.length)).toEqual([4, 4, 4, 2]);
		expect(harness.removeEntry).toHaveBeenCalledTimes(14);
		expect(harness.pendingPaths.size).toBe(0);
		expect(harness.requestReconciliation).not.toHaveBeenCalled();
	});

	it('clears completed queue revisions but preserves a newer event for the same path', async () => {
		const harness = createFlushHarness({
			prepareUploadFromPath: async path => ({
				path,
				content: new TextEncoder().encode('hello').buffer as ArrayBuffer,
				hash: 'abc123',
				size: 5,
				contentType: 'text/plain',
			}),
			uploadFile: async ({ path }) => {
				harness.pendingPaths.add(path);
				harness.pendingRevisions.set(path, 2);
				return { success: true, path, hash: 'abc123' };
			},
		});
		harness.pendingPaths.add('notes/a.md');
		harness.pendingRevisions.set('notes/a.md', 1);

		await processPendingChanges(harness.context, 4);

		expect(harness.pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.pendingRevisions.get('notes/a.md')).toBe(2);
		expect(harness.triggerDebouncedSync).toHaveBeenCalledTimes(1);
	});

	it('requeues uncertain uploads after abort without marking an error', async () => {
		const harness = createFlushHarness({
			prepareUploadFromPath: async path => ({
				path,
				content: new TextEncoder().encode('hello').buffer as ArrayBuffer,
				hash: 'abc123',
				size: 5,
				mtime: 1,
				contentType: 'text/plain',
			}),
			uploadFile: async () => {
				throw createNamedAbortError();
			},
		});
		harness.pendingPaths.add('notes/a.md');

		await processPendingChanges(harness.context, 4);

		expect(harness.state.status).not.toBe('error');
		expect(harness.pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.state.status).toBe('idle');
		expect(harness.triggerDebouncedSync).toHaveBeenCalled();
	});

	it('keeps successful deletes committed and requeues only failed remote deletes', async () => {
		const harness = createFlushHarness({
			batchDelete: async () => ({
				success: false,
				deleted: ['notes/ok.md'],
				errors: [
					{ path: 'notes/fail.md', error: 'bucket unavailable' },
				],
			}),
		});
		harness.pendingPaths.add('delete:notes/ok.md');
		harness.pendingPaths.add('delete:notes/fail.md');

		await processPendingChanges(harness.context, 4);

		expect(harness.removeEntry).toHaveBeenCalledWith('notes/ok.md');
		expect(harness.removeEntry).not.toHaveBeenCalledWith('notes/fail.md');
		expect(harness.pendingPaths.has('delete:notes/fail.md')).toBe(true);
		expect(harness.pendingPaths.has('delete:notes/ok.md')).toBe(false);
		expect(harness.state.status).toBe('error');
		expect(harness.state.lastError).toContain('notes/fail.md');
		expect(harness.save).toHaveBeenCalledTimes(1);
		expect(harness.triggerDebouncedSync).toHaveBeenCalledTimes(1);
	});
});


describe('queued deletion revalidation', () => {
	it('keeps the checkpoint and reconciles a file recreated after its delete event', async () => {
		const harness = createFlushHarness();
		harness.pendingPaths.add('delete:note.md');
		harness.context.assertLocalFileAbsent.mockRejectedValue(new LocalFilePresentError('note.md'));
		await processPendingChanges(harness.context, 2);
		expect(harness.batchDelete).not.toHaveBeenCalled();
		expect(harness.removeEntry).not.toHaveBeenCalled();
		expect(harness.pendingPaths.has('delete:note.md')).toBe(true);
		expect(harness.requestReconciliation).toHaveBeenCalledWith(['delete:note.md']);
	});

	it('preserves pending deletion when local absence cannot be checked', async () => {
		const harness = createFlushHarness();
		harness.pendingPaths.add('delete:note.md');
		harness.context.assertLocalFileAbsent.mockRejectedValue(new Error('adapter unavailable'));
		await processPendingChanges(harness.context, 2);
		expect(harness.batchDelete).not.toHaveBeenCalled();
		expect(harness.removeEntry).not.toHaveBeenCalled();
		expect(harness.pendingPaths.has('delete:note.md')).toBe(true);
		expect(harness.state.lastError).toContain('adapter unavailable');
	});
});
