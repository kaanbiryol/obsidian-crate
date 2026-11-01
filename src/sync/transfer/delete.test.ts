import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '../runtime/runtime-test-harness';
import { deleteRemoteFiles } from './delete';
import { createEmptySyncResult } from '../sync-result';
import { HttpError } from '../worker-api/client';
import type { ConditionalDeleteApi } from './delete-batches';
import { BATCH_DELETE_MAX_FILES } from '../../protocol/sync-limits';

const files = (count: number) => Array.from({ length: count }, (_, i) => ({ path: `old-${i}.md`, expectedHash: 'base', expectedRevision: `r${i}` }));

function harness(batchDelete: ConditionalDeleteApi['batchDelete']) {
	const context = {
		files: { batchDelete: vi.fn(batchDelete) },
		vault: { getAbstractFileByPath: () => null, adapter: { exists: async () => false } } as never,
		localManifest: { removeEntry: vi.fn(), save: vi.fn(async () => {}) },
		reportWork: vi.fn(),
	};
	return context;
}

describe('shared remote deletion', () => {
	it('batches files at the server limit with at most two requests in flight and reports completed files', async () => {
		const gates = Array.from({ length: 4 }, () => createDeferred<void>());
		let active = 0, peak = 0, dispatched = 0;
		const h = harness(async paths => {
			peak = Math.max(peak, ++active);
			await gates[dispatched++]!.promise;
			active--;
			return { success: true, deleted: paths };
		});
		const result = createEmptySyncResult();
		const count = 3 * BATCH_DELETE_MAX_FILES + 1;
		const pending = deleteRemoteFiles(h, files(count), result);
		await vi.waitFor(() => expect(h.files.batchDelete).toHaveBeenCalledTimes(2));
		gates[0]!.resolve();
		await vi.waitFor(() => expect(h.files.batchDelete).toHaveBeenCalledTimes(3));
		gates[1]!.resolve();
		await vi.waitFor(() => expect(h.files.batchDelete).toHaveBeenCalledTimes(4));
		gates[2]!.resolve(); gates[3]!.resolve();
		expect(await pending).toEqual([]);
		expect(peak).toBe(2);
		expect(h.files.batchDelete.mock.calls.map(([paths]) => paths.length)).toEqual([BATCH_DELETE_MAX_FILES, BATCH_DELETE_MAX_FILES, BATCH_DELETE_MAX_FILES, 1]);
		expect(result.deletedPaths).toEqual(files(count).map(file => file.path));
		expect(h.reportWork).toHaveBeenLastCalledWith({ phase: 'deleting', current: count, total: count });
	});

	it('drains an accepted sibling and checkpoints its acknowledgement before returning cancellation', async () => {
		const accepted = createDeferred<void>();
		const cancelled = createDeferred<void>();
		const h = harness(async paths => {
			if (paths[0] === 'old-0.md') { await accepted.promise; return { success: true, deleted: paths }; }
			await cancelled.promise;
			throw new DOMException('Cancelled', 'AbortError');
		});
		const result = createEmptySyncResult();
		const pending = deleteRemoteFiles(h, files(3 * BATCH_DELETE_MAX_FILES), result);
		const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(h.files.batchDelete).toHaveBeenCalledTimes(2));
		cancelled.resolve();
		await Promise.resolve();
		accepted.resolve();
		await assertion;
		expect(h.files.batchDelete).toHaveBeenCalledTimes(2);
		expect(result.deletedPaths).toEqual(files(BATCH_DELETE_MAX_FILES).map(file => file.path));
		expect(h.localManifest.removeEntry).toHaveBeenCalledTimes(BATCH_DELETE_MAX_FILES);
		expect(h.localManifest.save).toHaveBeenCalledOnce();
	});

	it('keeps every remote file when an earlier upload failed', async () => {
		const h = harness(async paths => ({ success: true, deleted: paths }));
		const result = createEmptySyncResult();
		result.errors.push('Upload failed');
		expect(await deleteRemoteFiles(h, files(5), result)).toHaveLength(5);
		expect(h.files.batchDelete).not.toHaveBeenCalled();
		expect(h.localManifest.removeEntry).not.toHaveBeenCalled();
	});

	it('stops undispatched batches and records each failure once when both requests fail', async () => {
		const gate = createDeferred<void>();
		const h = harness(async () => { await gate.promise; throw new HttpError('Access denied', 401); });
		const result = createEmptySyncResult();
		const count = 3 * BATCH_DELETE_MAX_FILES + 1;
		const pending = deleteRemoteFiles(h, files(count), result);
		await vi.waitFor(() => expect(h.files.batchDelete).toHaveBeenCalledTimes(2));
		gate.resolve();
		const failures = await pending;
		expect(h.files.batchDelete).toHaveBeenCalledTimes(2);
		expect(failures).toHaveLength(count);
		expect(new Set(failures.map(failure => failure.path)).size).toBe(count);
		expect(h.localManifest.removeEntry).not.toHaveBeenCalled();
	});

	it('checkpoints partial acknowledgements before a conflict retry is cancelled', async () => {
		const h = harness(async paths => ({ success: false, deleted: [paths[0]!], errors: [{ path: paths[1]!, error: 'Changed', status: 409, code: 'version_conflict' }] }));
		const result = createEmptySyncResult();
		await expect(deleteRemoteFiles(h, files(2), result, {
			onVersionConflicts: async () => {
				expect(h.localManifest.save).toHaveBeenCalledOnce();
				throw new DOMException('Cancelled', 'AbortError');
			},
		})).rejects.toMatchObject({ name: 'AbortError' });
		expect(result.deletedPaths).toEqual(['old-0.md']);
	});

	it('retains terminal failure codes without retrying them as version conflicts', async () => {
		const h = harness(async () => { throw new HttpError('Rename the conflicting folder', 409, null, 'namespace_conflict'); });
		const onVersionConflicts = vi.fn(async () => {});
		const result = createEmptySyncResult();
		expect(await deleteRemoteFiles(h, files(1), result, { onVersionConflicts })).toMatchObject([{ path: 'old-0.md', status: 409, code: 'namespace_conflict' }]);
		expect(onVersionConflicts).not.toHaveBeenCalled();
		expect(result.errors).toEqual(['old-0.md: Rename the conflicting folder']);
	});

	it('rechecks local absence at dispatch and sends changed files to reconciliation', async () => {
		const h = harness(async paths => ({ success: true, deleted: paths }));
		h.vault = { getAbstractFileByPath: () => ({ path: 'old-0.md', extension: 'md', stat: { size: 1, mtime: 1 } }) } as never;
		const onVersionConflicts = vi.fn(async () => {});
		const result = createEmptySyncResult();
		const failures = await deleteRemoteFiles(h, files(1), result, { onVersionConflicts });
		expect(failures).toMatchObject([{ path: 'old-0.md', code: 'version_conflict' }]);
		expect(h.files.batchDelete).not.toHaveBeenCalled();
		expect(onVersionConflicts).toHaveBeenCalledOnce();
		expect(result.errors).toEqual([]);
	});
});
