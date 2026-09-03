import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createHarness,
	createSyncResult,
	flushPendingChanges,
	getPendingPaths,
	spyOnDebouncedSync,
	spyOnIncrementalSync,
	toArrayBuffer,
	type Harness,
} from './engine-test-harness';

describe('SyncEngine event queue behavior', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 1, mtime: 1700000000000 });
	});

	it('queues remote delete when renaming from syncable path into ignored path', () => {
		const debouncedSync = spyOnDebouncedSync(harness.engine);

		harness.engine.onFileRename({ path: '.trash/note.md' } as never, 'notes/note.md');

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has('delete:notes/note.md')).toBe(true);
		expect(pendingPaths.has('.trash/note.md')).toBe(false);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
	});

	it('queues upload when renaming from ignored path into syncable path', () => {
		const debouncedSync = spyOnDebouncedSync(harness.engine);

		harness.engine.onFileRename({ path: 'notes/note.md' } as never, '.trash/note.md');

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has('delete:.trash/note.md')).toBe(false);
		expect(pendingPaths.has('notes/note.md')).toBe(true);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
	});

	it('emits idle state after flush with no pending paths left', async () => {
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.api.uploadFile.mockResolvedValue({ success: true, path: 'notes/a.md' });

		const idlePendingCounts: number[] = [];
		harness.engine.setStateChangeCallback((state) => {
			if (state.status === 'idle') {
				idlePendingCounts.push(harness.engine.getPendingPaths().length);
			}
		});

		getPendingPaths(harness.engine).add('notes/a.md');
		await flushPendingChanges(harness.engine);

		expect(idlePendingCounts.at(-1)).toBe(0);
	});

	it('reports successful automatic uploads for sync activity history', async () => {
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.api.uploadFile.mockResolvedValue({ success: true, path: 'notes/a.md' });
		const onQueueSyncResult = vi.fn(async () => {});
		harness.engine.setQueueSyncResultCallback(onQueueSyncResult);

		getPendingPaths(harness.engine).add('notes/a.md');
		await flushPendingChanges(harness.engine);

		expect(onQueueSyncResult).toHaveBeenCalledWith(expect.objectContaining({
			success: true,
			uploaded: 1,
			uploadedPaths: ['notes/a.md'],
		}));
	});

	it('keeps new paths queued when they arrive during pending flush', async () => {
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'notes/a.md') {
				return {
					path,
					extension: 'md',
					stat: { size: 1, mtime: 1700000000000 },
				};
			}
			return null;
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		const debouncedSync = spyOnDebouncedSync(harness.engine);
		harness.api.uploadFile.mockImplementation(async () => {
			getPendingPaths(harness.engine).add('notes/b.md');
			return { success: true, path: 'notes/a.md' };
		});

		getPendingPaths(harness.engine).add('notes/a.md');
		await flushPendingChanges(harness.engine);

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has('notes/a.md')).toBe(false);
		expect(pendingPaths.has('notes/b.md')).toBe(true);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
	});

	it('re-queues pending path when upload returns success false', async () => {
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		spyOnDebouncedSync(harness.engine);
		harness.api.uploadFile.mockResolvedValue({
			success: false,
			path: 'notes/a.md',
			error: 'quota exceeded',
		});

		getPendingPaths(harness.engine).add('notes/a.md');
		await flushPendingChanges(harness.engine);

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.engine.getState().status).toBe('error');
		expect(harness.engine.getState().lastError).toContain('quota exceeded');
	});
});
describe('SyncEngine explicit sync queue reconciliation', () => {
	it('clears queued paths that were handled by an explicit sync result', async () => {
		const harness = createHarness();
		const result = createSyncResult();
		result.uploaded = 1;
		result.downloaded = 1;
		result.deleted = 1;
		result.uploadedPaths.push('notes/uploaded.md');
		result.downloadedPaths.push('notes/downloaded.md');
		result.deletedPaths.push('notes/deleted.md');
		spyOnIncrementalSync(harness.engine, result);

		const pendingPaths = getPendingPaths(harness.engine);
		pendingPaths.add('notes/uploaded.md');
		pendingPaths.add('notes/downloaded.md');
		pendingPaths.add('delete:notes/deleted.md');
		pendingPaths.add('notes/still-pending.md');

		const syncResult = await harness.engine.sync();

		expect(syncResult).toBe(result);
		expect(pendingPaths.has('notes/uploaded.md')).toBe(false);
		expect(pendingPaths.has('notes/downloaded.md')).toBe(false);
		expect(pendingPaths.has('delete:notes/deleted.md')).toBe(false);
		expect(pendingPaths.has('notes/still-pending.md')).toBe(true);
		expect(harness.engine.getState().pendingChanges).toBe(1);
	});

	it('clears pending state immediately when explicit sync handled all queued paths', async () => {
		const harness = createHarness();
		const result = createSyncResult();
		result.uploaded = 1;
		result.uploadedPaths.push('notes/a.md');
		spyOnIncrementalSync(harness.engine, result);

		const pendingPaths = getPendingPaths(harness.engine);
		pendingPaths.add('notes/a.md');

		await harness.engine.sync();

		expect(pendingPaths.size).toBe(0);
		expect(harness.engine.getPendingPaths()).toEqual([]);
		expect(harness.engine.getState().pendingChanges).toBe(0);
	});
});
