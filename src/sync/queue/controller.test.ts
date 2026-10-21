import { TFolder } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingChangeKey } from '../pending/pending-change';
import { createEmptySyncResult } from '../sync-result';
import { ReconnectNotice } from '../sync-outcome';
import type { SyncResult } from '../types';
import { SyncQueueController } from './controller';

function createController(options: Partial<{
	automaticSync: boolean;
	destroyed: boolean;
	maxDebounceWaitMs: number;
}> = {}) {
	const updateState = vi.fn();
	// A flush stops at the configuration check, so its calls count flushes.
	const isConfigured = vi.fn(() => false);
	const controller = new SyncQueueController({
		finishInitialSetup: async () => {},
		uploadPreparedFiles: async () => {},
		deleteRemoteFiles: async () => [],
		automaticSyncEnabled: () => options.automaticSync ?? false,
		recoverUploads: async () => {},
		api: { isConfigured },
		getLocalManifest: () => ({ getEntry: () => undefined, save: async () => {} }),
		shouldIgnore: (path: string) => path.startsWith('.trash/'),
		updateState,
		setLastSync: vi.fn(),
		reconnectNotice: new ReconnectNotice(),
		isDestroyed: () => options.destroyed ?? false,
		currentStatus: () => 'idle',
		verifyPendingPaths: async () => [],
		prepareUploadFromPath: async () => null,
		getDebounceDelayMs: () => 25,
		maxDebounceWaitMs: options.maxDebounceWaitMs ?? 30_000,
		reconcile: async () => createEmptySyncResult(),
		onFlushResult: vi.fn(),
	});
	return {
		controller,
		updateState,
		flushes: isConfigured,
		pending: () => controller.getPendingPaths(),
		revisions: () => [...controller.snapshotPendingRevisions().keys()],
	};
}

function createSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
	return {
		...createEmptySyncResult(),
		...overrides,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('queue event handlers', () => {
	it('keeps literal delete-prefixed names independent during edits, deletes and renames', () => {
		const h = createController();
		h.controller.onFileChange({ path: 'note.md' });
		h.controller.onFileChange({ path: 'delete:note.md' });
		h.controller.onFileDelete({ path: 'note.md' });
		expect(h.pending()).toEqual(['delete:note.md', pendingChangeKey('delete', 'note.md')]);
		h.controller.onFileRename({ path: 'renamed.md' } as never, 'delete:note.md');
		expect(h.pending()).toEqual([
			pendingChangeKey('delete', 'note.md'), pendingChangeKey('delete', 'delete:note.md'), 'renamed.md',
		]);
		expect(h.revisions()).toEqual(h.pending());
	});

	it('settles the matching deletion without clearing a newer edit to a prefixed filename', () => {
		const h = createController();
		h.controller.onFileChange({ path: 'delete:note.md' });
		h.controller.onFileDelete({ path: 'note.md' });
		const revisions = h.controller.snapshotPendingRevisions();
		h.controller.onFileChange({ path: 'delete:note.md' });
		h.controller.clearSyncedPendingPaths(createSyncResult({ uploadedPaths: ['delete:note.md'], deletedPaths: ['note.md'] }), revisions);
		expect(h.pending()).toEqual(['delete:note.md']);
		expect(h.revisions()).toEqual(['delete:note.md']);
	});

	it('queues file changes for syncable paths', () => {
		const h = createController();

		h.controller.onFileChange({ path: 'notes/a.md' });

		expect(h.controller.hasPendingPath('notes/a.md')).toBe(true);
		expect(h.updateState).toHaveBeenCalledExactlyOnceWith({ pendingChanges: 1 });
	});

	it('queues delete markers for syncable paths', () => {
		const h = createController();

		h.controller.onFileDelete({ path: 'notes/a.md' });

		expect(h.controller.hasPendingPath(pendingChangeKey('delete', 'notes/a.md'))).toBe(true);
		expect(h.updateState).toHaveBeenCalledExactlyOnceWith({ pendingChanges: 1 });
	});

	it('handles rename transitions across ignored boundaries', () => {
		const h = createController();

		h.controller.onFileRename({ path: '.trash/a.md' } as never, 'notes/a.md');
		h.controller.onFileRename({ path: 'notes/b.md' } as never, '.trash/b.md');

		expect(h.controller.hasPendingPath(pendingChangeKey('delete', 'notes/a.md'))).toBe(true);
		expect(h.controller.hasPendingPath('notes/b.md')).toBe(true);
		expect(h.controller.hasPendingPath('.trash/b.md')).toBe(false);
		expect(h.updateState.mock.calls).toEqual([[{ pendingChanges: 1 }], [{ pendingChanges: 2 }]]);
	});

	it('does not queue deleted folders as files', () => {
		const h = createController({ automaticSync: true });
		const folder = Object.assign(new TFolder(), { path: 'Fake conflicts' });
		h.controller.onFileDelete(folder);
		expect(h.pending()).toEqual([]);
		expect(h.updateState).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('debounced flush', () => {
	it('triggers flush after delay and starts a new wait window afterwards', async () => {
		const h = createController({ automaticSync: true, maxDebounceWaitMs: 40 });
		h.controller.onFileChange({ path: 'notes/a.md' });

		await vi.advanceTimersByTimeAsync(24);
		expect(h.flushes).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(h.flushes).toHaveBeenCalledTimes(1);

		// The flush cleared the timer and the maximum-wait start, so later edits
		// restart the countdown rather than flushing at once.
		h.controller.onFileChange({ path: 'notes/a.md' });
		await vi.advanceTimersByTimeAsync(20);
		h.controller.onFileChange({ path: 'notes/a.md' });
		expect(h.flushes).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(25);
		expect(h.flushes).toHaveBeenCalledTimes(2);
	});

	it('no-ops when queue is destroyed', async () => {
		const h = createController({ automaticSync: true, destroyed: true });

		h.controller.onFileChange({ path: 'notes/a.md' });
		await vi.advanceTimersByTimeAsync(25);

		expect(h.flushes).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('fires immediately when max-wait is exceeded', async () => {
		const h = createController({ automaticSync: true, maxDebounceWaitMs: 50 });
		h.controller.onFileChange({ path: 'notes/a.md' });
		await vi.advanceTimersByTimeAsync(20);
		h.controller.onFileChange({ path: 'notes/a.md' });
		await vi.advanceTimersByTimeAsync(20);
		h.controller.onFileChange({ path: 'notes/a.md' });
		await vi.advanceTimersByTimeAsync(20);
		expect(h.flushes).not.toHaveBeenCalled();

		// 60ms after the first edit, past the 50ms maximum wait.
		h.controller.onFileChange({ path: 'notes/a.md' });

		expect(h.flushes).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(25);
		expect(h.flushes).toHaveBeenCalledTimes(1);
	});
});

describe('clearSyncedPendingPaths', () => {
	it('removes successful uploaded, downloaded, merged, and deleted paths from the queue', async () => {
		const h = createController({ automaticSync: true });
		h.controller.onFileChange({ path: 'notes/uploaded.md' });
		h.controller.onFileChange({ path: 'notes/downloaded.md' });
		h.controller.onFileChange({ path: 'notes/merged.md' });
		h.controller.onFileDelete({ path: 'notes/deleted.md' });
		h.updateState.mockClear();

		h.controller.clearSyncedPendingPaths(
			createSyncResult({
				uploadedPaths: ['notes/uploaded.md'],
				downloadedPaths: ['notes/downloaded.md'],
				mergedPaths: ['notes/merged.md'],
				deletedPaths: ['notes/deleted.md'],
			}),
			h.controller.snapshotPendingRevisions(),
		);

		expect(h.pending()).toEqual([]);
		expect(h.updateState).toHaveBeenCalledWith({ pendingChanges: 0 });
		// Clearing the last pending path cancels the scheduled flush.
		await vi.advanceTimersByTimeAsync(25);
		expect(h.flushes).not.toHaveBeenCalled();
	});

	it('keeps unrelated pending paths and updates the pending count', async () => {
		const h = createController({ automaticSync: true });
		h.controller.onFileChange({ path: 'notes/uploaded.md' });
		h.controller.onFileChange({ path: 'notes/still-pending.md' });
		h.updateState.mockClear();

		h.controller.clearSyncedPendingPaths(
			createSyncResult({ uploadedPaths: ['notes/uploaded.md'] }),
			h.controller.snapshotPendingRevisions(),
		);

		expect(h.pending()).toEqual(['notes/still-pending.md']);
		expect(h.updateState).toHaveBeenCalledWith({ pendingChanges: 1 });
		await vi.advanceTimersByTimeAsync(25);
		expect(h.flushes).toHaveBeenCalledTimes(1);
	});

	it('does not change the queue when the sync result failed', async () => {
		const h = createController({ automaticSync: true });
		h.controller.onFileChange({ path: 'notes/a.md' });
		h.updateState.mockClear();

		h.controller.clearSyncedPendingPaths(
			createSyncResult({ success: false, uploadedPaths: ['notes/a.md'] }),
			h.controller.snapshotPendingRevisions(),
		);

		expect(h.pending()).toEqual(['notes/a.md']);
		expect(h.updateState).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(25);
		expect(h.flushes).toHaveBeenCalledTimes(1);
	});

	it('keeps a newer event for the same path during sync reconciliation', () => {
		const h = createController();
		h.controller.onFileChange({ path: 'notes/a.md' });
		const revisions = h.controller.snapshotPendingRevisions();
		h.controller.onFileChange({ path: 'notes/a.md' });
		const newer = h.controller.snapshotPendingRevisions().get('notes/a.md');
		h.updateState.mockClear();

		h.controller.clearSyncedPendingPaths(
			createSyncResult({ uploadedPaths: ['notes/a.md'] }),
			revisions,
		);

		expect(h.pending()).toEqual(['notes/a.md']);
		expect(newer).toBeGreaterThan(revisions.get('notes/a.md')!);
		expect(h.controller.snapshotPendingRevisions().get('notes/a.md')).toBe(newer);
		expect(h.updateState).not.toHaveBeenCalled();
	});

	it('coalesces opposite upload and delete events for one path', () => {
		const h = createController();
		h.controller.onFileDelete({ path: 'notes/a.md' });
		h.controller.onFileChange({ path: 'notes/a.md' });

		expect(h.pending()).toEqual(['notes/a.md']);
		expect(h.revisions()).toEqual(['notes/a.md']);
	});
});
