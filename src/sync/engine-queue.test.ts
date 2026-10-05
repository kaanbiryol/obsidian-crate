import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from './runtime-test-harness';
import {
	createHarness,
	createSyncResult,
	spyOnIncrementalSync,
	toArrayBuffer,
	type Harness,
} from './engine-test-harness';

describe('SyncEngine event queue behavior', () => {
	let harness: Harness;

	beforeEach(() => {
		vi.useFakeTimers();
		harness = createHarness();
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 1, mtime: 1700000000000 });
	});

	afterEach(() => {
		harness.engine.destroy();
		vi.useRealTimers();
	});

	it('does not flush queued edits after automatic sync is disabled', async () => {
		harness.engine.onFileChange({ path: 'notes/a.md' } as never);
		harness.engine.updateSettings({ ...harness.settings, automaticSync: false });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.api.uploadFile).not.toHaveBeenCalled();
		expect(harness.engine.getPendingPaths()).toContain('notes/a.md');
	});

	it('queues remote delete when renaming from syncable path into ignored path', () => {
		harness.engine.onFileRename({ path: '.trash/note.md' } as never, 'notes/note.md');

		const pendingPaths = harness.engine.getPendingPaths();
		expect(pendingPaths.includes('delete:notes/note.md')).toBe(true);
		expect(pendingPaths.includes('.trash/note.md')).toBe(false);
	});

	it('queues upload when renaming from ignored path into syncable path', () => {
		harness.engine.onFileRename({ path: 'notes/note.md' } as never, '.trash/note.md');

		const pendingPaths = harness.engine.getPendingPaths();
		expect(pendingPaths.includes('delete:.trash/note.md')).toBe(false);
		expect(pendingPaths.includes('notes/note.md')).toBe(true);
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

		harness.engine.onFileChange({ path: 'notes/a.md' } as never);
		await vi.advanceTimersByTimeAsync(5000);
		await harness.engine.waitForIdle();

		expect(idlePendingCounts.at(-1)).toBe(0);
	});

	it.each(['failed', 'pending'])('reports successful automatic uploads while reminder settings are %s', async status => {
		const pending = createDeferred<void>();
		const prepare = vi.fn(() => status === 'failed' ? Promise.reject(new Error('settings unavailable')) : pending.promise);
		harness.engine.setReminderScopePreparation(prepare);
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.api.uploadFile.mockResolvedValue({ success: true, path: 'notes/a.md' });
		const onQueueSyncResult = vi.fn(async () => {});
		harness.engine.setAutomaticSyncResultCallback(onQueueSyncResult);

		harness.engine.onFileChange({ path: 'notes/a.md' } as never);
		await vi.advanceTimersByTimeAsync(5000);
		await harness.engine.waitForIdle();

		expect(onQueueSyncResult).toHaveBeenCalledWith(expect.objectContaining({
			success: true,
			uploaded: 1,
			uploadedPaths: ['notes/a.md'],
		}));
		expect(prepare).toHaveBeenCalledOnce();
		pending.resolve();
		harness.engine.destroy();
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
		harness.api.uploadFile.mockImplementation(async () => {
			harness.engine.onFileChange({ path: 'notes/b.md' } as never);
			return { success: true, path: 'notes/a.md' };
		});

		harness.engine.onFileChange({ path: 'notes/a.md' } as never);
		await vi.advanceTimersByTimeAsync(5000);
		await harness.engine.waitForIdle();

		const pendingPaths = harness.engine.getPendingPaths();
		expect(pendingPaths.includes('notes/a.md')).toBe(false);
		expect(pendingPaths.includes('notes/b.md')).toBe(true);
	});

	it('re-queues pending path when upload returns success false', async () => {
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.api.uploadFile.mockResolvedValue({
			success: false,
			path: 'notes/a.md',
			error: 'quota exceeded',
		});

		harness.engine.onFileChange({ path: 'notes/a.md' } as never);
		await vi.advanceTimersByTimeAsync(5000);
		await harness.engine.waitForIdle();

		const pendingPaths = harness.engine.getPendingPaths();
		expect(pendingPaths.includes('notes/a.md')).toBe(true);
		expect(harness.engine.getState().status).toBe('error');
		expect(harness.engine.getState().lastError).toContain('quota exceeded');
	});
});
describe('SyncEngine explicit sync queue reconciliation', () => {
	it('clears queued paths that were handled by an explicit sync result', async () => {
		const harness = createHarness({ automaticSync: false });
		const result = createSyncResult();
		result.uploaded = 1;
		result.downloaded = 1;
		result.deleted = 1;
		result.uploadedPaths.push('notes/uploaded.md');
		result.downloadedPaths.push('notes/downloaded.md');
		result.deletedPaths.push('notes/deleted.md');
		spyOnIncrementalSync(harness.engine, result);

		harness.engine.onFileChange({ path: 'notes/uploaded.md' } as never);
		harness.engine.onFileChange({ path: 'notes/downloaded.md' } as never);
		harness.engine.onFileDelete({ path: 'notes/deleted.md' } as never);
		harness.engine.onFileChange({ path: 'notes/still-pending.md' } as never);

		const syncResult = await harness.engine.sync();

		const pendingPaths = harness.engine.getPendingPaths();
		expect(syncResult).toBe(result);
		expect(pendingPaths.includes('notes/uploaded.md')).toBe(false);
		expect(pendingPaths.includes('notes/downloaded.md')).toBe(false);
		expect(pendingPaths.includes('delete:notes/deleted.md')).toBe(false);
		expect(pendingPaths.includes('notes/still-pending.md')).toBe(true);
		expect(harness.engine.getState().pendingChanges).toBe(1);
		harness.engine.destroy();
	});

	it('clears pending state immediately when explicit sync handled all queued paths', async () => {
		const harness = createHarness({ automaticSync: false });
		const result = createSyncResult();
		result.uploaded = 1;
		result.uploadedPaths.push('notes/a.md');
		spyOnIncrementalSync(harness.engine, result);

		harness.engine.onFileChange({ path: 'notes/a.md' } as never);

		await harness.engine.sync();

		expect(harness.engine.getPendingPaths()).toEqual([]);
		expect(harness.engine.getState().pendingChanges).toBe(0);
		harness.engine.destroy();
	});
});
