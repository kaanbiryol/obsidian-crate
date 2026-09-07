import { describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest, Vault } from 'obsidian';
import type { FileEntry } from '../protocol/sync-types';
import { LocalManifest } from './manifest';
import { createFullSyncPlan } from './planner-full';
import type { FullSyncPlannerContext } from './planner-types';
import { classifyPaths } from './reconciliation';
import { reconcileQueuePaths, type TargetedReconcileContext } from './reconcile-paths';

const paths = ['__proto__', 'constructor', 'toString'];
const entry: FileEntry = { hash: 'file-hash', size: 1, modified: 'now', revision: 'r1' };

function createPlanner(localPaths: string[] = []) {
	const files = localPaths.map(path => ({ path, extension: '', stat: { size: 1, mtime: 1 } }));
	const readBinary = vi.fn(async () => new Uint8Array([1]).buffer);
	const vault = {
		getFiles: () => files,
		getAbstractFileByPath: (path: string) => files.find(file => file.path === path) ?? null,
		adapter: { list: async () => ({ files: [], folders: [] }), readBinary },
	} as unknown as Vault;
	const localManifest = new LocalManifest({ vault } as App, { dir: '.obsidian/plugins/crate' } as PluginManifest);
	const context: FullSyncPlannerContext = {
		vault, localManifest, shouldIgnore: () => false,
		runConcurrent: async tasks => Promise.all(tasks.map(task => task())),
	};
	return { context, readBinary, localManifest };
}

describe('literal path names in reconciliation', () => {
	it.each(paths)('hashes and uploads a new local %s file', async path => {
		const { context, readBinary } = createPlanner([path]);
		const plan = await createFullSyncPlan(context, {}, 1);
		expect(readBinary).toHaveBeenCalledWith(path);
		expect(Object.keys(plan.localFiles)).toEqual([path]);
		expect(plan.diffs).toEqual([{
			path, action: 'upload', localHash: plan.localFiles[path]!.hash, cause: 'local-created',
		}]);
	});

	it.each(paths)('downloads a new remote %s file and recognizes a subsequent local delete', async path => {
		const { context, localManifest } = createPlanner();
		const remote = { [path]: entry };
		const firstPlan = await createFullSyncPlan(context, remote, 1);
		expect(firstPlan.diffs).toEqual([{ path, action: 'download', remoteHash: entry.hash, cause: 'remote-created' }]);
		localManifest.setEntry(path, entry);
		const deletedPlan = await createFullSyncPlan(context, remote, 1);
		expect(deletedPlan.diffs).toEqual([{
			path, action: 'delete', remoteHash: entry.hash, remoteRevision: entry.revision, cause: 'local-deleted',
		}]);
	});

	it.each(paths)('classifies a remote deletion of %s from plain JSON records', path => {
		const files = { [path]: entry };
		expect(classifyPaths(files, {}, files)).toEqual([{
			path, action: 'delete-local', localHash: entry.hash, cause: 'remote-deleted',
		}]);
		expect(classifyPaths({}, {}, files)).toEqual([]);
		expect(classifyPaths(files, { [path]: { ...entry, hash: 'remote-edit' } }, {})).toEqual([{
			path, action: 'conflict', localHash: entry.hash, remoteHash: 'remote-edit', cause: 'concurrent-create',
		}]);
	});

	it.each(paths)('refreshes %s metadata after losing a targeted reconciliation race', async path => {
		const { context } = createPlanner([path]);
		vi.spyOn(context.localManifest, 'save').mockResolvedValue();
		const getRemoteEntries = vi.fn<TargetedReconcileContext['getRemoteEntries']>()
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({ [path]: entry });
		const processDiff = vi.fn<TargetedReconcileContext['processDiff']>()
			.mockResolvedValueOnce({ status: 'deferred', reason: 'Remote changed' })
			.mockResolvedValueOnce({ status: 'applied' });
		const result = await reconcileQueuePaths({ ...context, getRemoteEntries, processDiff }, [path]);
		expect(processDiff.mock.calls.map(([diff]) => diff.action)).toEqual(['upload', 'conflict']);
		expect(processDiff.mock.calls[1]![0]).toMatchObject({ remoteHash: entry.hash });
		expect(Object.keys(processDiff.mock.calls[1]![1])).toEqual([path]);
		expect(result.success).toBe(true);
		expect(result.settledPaths).toEqual([path]);
	});
});
