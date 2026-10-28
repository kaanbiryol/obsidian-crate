import { deleteRemoteFiles } from '../transfer/delete';
import { pendingChangeKey } from '../pending/pending-change';
import { describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest, Vault } from 'obsidian';
import type { FileEntry } from '../../protocol/sync-types';
import { LocalManifest } from '../manifest/manifest';
import { assertRenamePreserved } from '../manifest/rename-dependencies';
import { reconcileQueuePaths, type TargetedReconcileContext } from './reconcile-paths';
import { sha256Hex } from '../../platform/sha256';
import { PersistentTestVault } from '../../test/factories/sync-vault';

async function harness(destinationUploaded: boolean, destinationExists = true) {
	const source = 'Dashboard.md';
	const destination = 'Upcoming.md';
	const content = new TextEncoder().encode('dashboard').buffer;
	const entry: FileEntry = {
		hash: await sha256Hex(content), size: content.byteLength,
		modified: new Date(1000).toISOString(), revision: 'v1',
	};
	const disk = new Map<string, string>();
	const adapter = {
		exists: vi.fn(async () => false),
		readBinary: vi.fn(async () => content),
		write: vi.fn(async (path: string, data: string) => { disk.set(path, data); }),
		remove: vi.fn(async (path: string) => { disk.delete(path); }),
	};
	const vault = {
		adapter,
		getAbstractFileByPath: vi.fn((path: string) => destinationExists && path === destination
			? { path, extension: 'md', stat: { size: content.byteLength, mtime: 1000 } } : null),
	} as unknown as Vault;
	const manifest = new LocalManifest({ vault } as App, { dir: '.obsidian/plugins/crate' } as PluginManifest);
	manifest.setEntry(source, entry);
	manifest.recordRename(source, destination);
	const remote: Record<string, FileEntry> = { [source]: entry };
	if (destinationUploaded) remote[destination] = { ...entry, revision: 'v2' };
	const deleted = vi.fn();
	const processDiff = vi.fn<TargetedReconcileContext['processDiff']>(async diff => {
		if (diff.action === 'upload') {
			remote[diff.path] = { ...entry, revision: 'v2' };
			manifest.setEntry(diff.path, remote[diff.path]!);
		} else if (diff.action === 'delete') {
			await assertRenamePreserved(manifest, vault, diff.path);
			// The destination receipt must be durable before deleting the source.
			if (destinationExists) expect(disk.get('.obsidian/plugins/crate/file-manifest.json')).toContain('"revision":"v2"');
			deleted(diff.path);
			delete remote[diff.path];
			manifest.removeEntry(diff.path);
		}
		return { status: 'applied' };
	});
	const getRemoteEntries = vi.fn(async (paths: string[]) => Object.fromEntries(
		paths.flatMap(path => remote[path] ? [[path, remote[path]]] : []),
	));
	const context: TargetedReconcileContext = {
		deleteRemoteFiles: (files, result, options) => deleteRemoteFiles({ vault, localManifest: manifest, files: {
		batchDelete: async paths => {
			for (const path of paths) {
				await assertRenamePreserved(manifest, vault, path);
				if (destinationExists) expect(disk.get('.obsidian/plugins/crate/file-manifest.json')).toContain('"revision":"v2"');
				deleted(path); delete remote[path];
			}
			return { success: true, deleted: paths };
		},
	} }, files, result, options),
		vault, localManifest: manifest, getRemoteEntries, processDiff, shouldIgnore: () => false,
	};
	return { source, destination, entry, remote, manifest, context, processDiff, getRemoteEntries, deleted };
}

describe('targeted rename reconciliation', () => {
	it.each([true, false])('preserves the destination before deleting the source (already uploaded: %s)', async uploaded => {
		const h = await harness(uploaded);
		const reportWork = vi.fn<NonNullable<TargetedReconcileContext['reportWork']>>();
		h.context.reportWork = reportWork;
		const result = await reconcileQueuePaths(h.context, [pendingChangeKey('delete', h.source), h.destination]);
		expect(result.success).toBe(true);
		expect(result.settledPaths).toEqual([h.destination, pendingChangeKey('delete', h.source)]);
		expect(h.deleted).toHaveBeenCalledWith(h.source);
		expect(h.remote[h.destination]?.revision).toBe('v2');
		expect(reportWork.mock.calls.map(([work]) => work)).toEqual([
			{ phase: 'server' },
			{ phase: 'applying', current: 0, total: 2 },
			{ phase: 'applying', current: 1, total: 2 },
			{ phase: 'saving' },
		]);
	});

	it('also defers deletions discovered from ordinary queue keys', async () => {
		const h = await harness(false);
		expect((await reconcileQueuePaths(h.context, [h.source, h.destination])).success).toBe(true);
		expect(h.deleted).toHaveBeenCalledWith(h.source);
	});

	it('preserves the source when the destination upload fails', async () => {
		const h = await harness(false);
		h.processDiff.mockRejectedValueOnce(new Error('Upload failed'));
		const result = await reconcileQueuePaths(h.context, [pendingChangeKey('delete', h.source), h.destination]);
		expect(result.success).toBe(false);
		expect(result.settledPaths).toEqual([]);
		expect(h.deleted).not.toHaveBeenCalled();
		expect(h.remote[h.source]).toEqual(h.entry);
	});

	it('deletes the source once its renamed copy was deleted before uploading', async () => {
		const h = await harness(false, false);
		const result = await reconcileQueuePaths(h.context, [pendingChangeKey('delete', h.source)]);
		expect(result.success).toBe(true);
		expect(h.deleted).toHaveBeenCalledWith(h.source);
		expect(h.remote[h.source]).toBeUndefined();
		expect(h.manifest.getRenameDependencies()).toEqual({});
		// Later deletions are no longer held back by the cleared dependency.
		await expect(assertRenamePreserved(h.manifest, {} as Vault, h.source)).resolves.toBeUndefined();
	});

	it.each([true, false])('deletes the old name of a case-only rename before uploading the new one (case-insensitive disk: %s)', async caseInsensitive => {
		const disk = new PersistentTestVault({ caseInsensitive });
		disk.write('todo.md', 'Groceries');
		disk.rename('todo.md', 'TODO.md');
		const entry: FileEntry = { hash: await sha256Hex(disk.read('TODO.md')), size: 9, modified: new Date(1).toISOString(), revision: 'v1' };
		const calls: string[] = [];
		const result = await reconcileQueuePaths({
			vault: disk.vault,
			localManifest: { getEntry: path => path === 'todo.md' ? entry : undefined, setEntry: vi.fn(), removeEntry: vi.fn(), save: async () => {} },
			getRemoteEntries: async paths => Object.fromEntries(paths.includes('todo.md') ? [['todo.md', entry]] : []),
			shouldIgnore: () => false,
			processDiff: vi.fn(),
			deleteRemoteFiles: async (files, syncResult) => {
				for (const file of files) { calls.push(`delete ${file.path}`); syncResult.deletedPaths.push(file.path); }
				return [];
			},
			uploadDiffs: async (diffs, syncResult) => {
				for (const diff of diffs) { calls.push(`upload ${diff.path}`); syncResult.uploadedPaths.push(diff.path); }
				return [];
			},
		}, [pendingChangeKey('delete', 'todo.md'), 'TODO.md']);
		expect(result.success).toBe(true);
		expect(calls).toEqual(['delete todo.md', 'upload TODO.md']);
		expect(result.settledPaths).toEqual([pendingChangeKey('delete', 'todo.md'), 'TODO.md']);
	});

	it.each(['dashboard.md', 'Dashboard.md/notes.md'])('lets the source go first when the server cannot store it beside %s', async destination => {
		const vault = {
			getAbstractFileByPath: (path: string) => ({ path, extension: 'md', stat: { size: 1, mtime: 1 } }),
			adapter: { readBinary: async () => new ArrayBuffer(1) },
		} as unknown as Vault;
		const manifest = new LocalManifest({ vault } as App, { dir: '.obsidian/plugins/crate' } as PluginManifest);
		manifest.setEntry('Dashboard.md', { hash: 'a'.repeat(64), size: 1, modified: new Date(1).toISOString(), revision: 'v1' });
		manifest.recordRename('Dashboard.md', destination);
		await expect(assertRenamePreserved(manifest, vault, 'Dashboard.md')).resolves.toBeUndefined();
		manifest.recordRename(destination, 'Elsewhere.md');
		await expect(assertRenamePreserved(manifest, vault, 'Dashboard.md')).rejects.toThrow('renamed file is uploaded');
	});

	it('does not upload an unselected destination or bypass the deletion guard', async () => {
		const h = await harness(false);
		const result = await reconcileQueuePaths(h.context, [pendingChangeKey('delete', h.source)]);
		expect(result.success).toBe(false);
		expect(result.errors.join(' ')).toContain('renamed file is uploaded');
		expect(h.getRemoteEntries).toHaveBeenCalledWith([h.source]);
		expect(h.deleted).not.toHaveBeenCalled();
		expect(h.remote[h.destination]).toBeUndefined();
	});
});
