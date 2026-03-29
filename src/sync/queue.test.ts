import { afterEach, describe, expect, it, vi } from 'vitest';
import { debouncedSync, onFileChange, onFileDelete, onFileRename, onRawPathChange, processPendingChanges } from './queue';
import type { PreparedUpload, SyncState } from '../plugin/types';

type QueueState = SyncState;

function createEventContext() {
	const pendingPaths = new Set<string>();
	const triggerDebouncedSync = vi.fn();
	const shouldIgnore = vi.fn((path: string) => path.startsWith('.trash/'));
	return {
		context: { pendingPaths, shouldIgnore, triggerDebouncedSync },
		pendingPaths,
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
	const prepareUploadFromPath = vi.fn(
		overrides.prepareUploadFromPath ??
			(async () => null),
	);
	const uploadFile = vi.fn(
		overrides.uploadFile ??
			(async ({ path }) => ({ success: true, path })),
	);
	const deleteFile = vi.fn(
		overrides.deleteFile ??
			(async path => ({ success: true, path })),
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
		updateState,
		updateStateCalls,
		triggerDebouncedSync,
		prepareUploadFromPath,
		uploadFile,
		deleteFile,
		batchDelete,
		setEntry,
		removeEntry,
		save,
		getModifiedIso,
		context: {
			pendingPaths,
			inFlightPaths,
			vault: {} as never,
			api: {
				isConfigured: vi.fn(() => overrides.configured ?? true),
				uploadFile: (path: string, content: ArrayBuffer, hash: string, size: number, contentType: string) =>
					uploadFile({ path, content, hash, size, contentType }),
				deleteFile,
				batchDelete,
			},
			localManifest: {
				setEntry,
				removeEntry,
				save,
			},
			updateState,
			isDestroyed: () => false,
			currentStatus: () => state.status,
			prepareUploadFromPath,
			runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
			getModifiedIso,
			triggerDebouncedSync,
		},
	};
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

describe('onRawPathChange', () => {
	it('enqueues non-ignored paths and triggers debounced sync', () => {
		const { context, pendingPaths, triggerDebouncedSync } = createEventContext();

		onRawPathChange(context, '.obsidian/plugins/some-plugin/main.js');

		expect(pendingPaths.has('.obsidian/plugins/some-plugin/main.js')).toBe(true);
		expect(triggerDebouncedSync).toHaveBeenCalledTimes(1);
	});

	it('skips ignored paths', () => {
		const { context, pendingPaths, triggerDebouncedSync } = createEventContext();

		onRawPathChange(context, '.trash/deleted.md');

		expect(pendingPaths.size).toBe(0);
		expect(triggerDebouncedSync).not.toHaveBeenCalled();
	});

	it('ignores raw folder paths', () => {
		const { context, pendingPaths, triggerDebouncedSync } = createEventContext();

		onRawPathChange(context, '.obsidian/plugins', { kind: 'folder' });

		expect(pendingPaths.size).toBe(0);
		expect(triggerDebouncedSync).not.toHaveBeenCalled();
	});

	it('queues delete marker for missing tracked paths', () => {
		const { context, pendingPaths, triggerDebouncedSync } = createEventContext();

		onRawPathChange(context, '.obsidian/plugins/foo/main.js', { kind: 'missing', wasTracked: true });

		expect(pendingPaths.has('delete:.obsidian/plugins/foo/main.js')).toBe(true);
		expect(triggerDebouncedSync).toHaveBeenCalledTimes(1);
	});

	it('ignores missing untracked paths', () => {
		const { context, pendingPaths, triggerDebouncedSync } = createEventContext();

		onRawPathChange(context, '.obsidian/plugins/foo/main.js', { kind: 'missing', wasTracked: false });

		expect(pendingPaths.size).toBe(0);
		expect(triggerDebouncedSync).not.toHaveBeenCalled();
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

describe('processPendingChanges', () => {
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
		expect(harness.batchDelete).toHaveBeenCalledWith(['notes/old.md']);
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
	});
});
