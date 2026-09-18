import { describe, expect, it, vi } from 'vitest';
import type { App, PluginManifest, Vault } from 'obsidian';
import type { FileEntry } from '../protocol/sync-types';
import { computeHash } from './hasher';
import { LocalManifest } from './manifest';
import { assertRenamePreserved } from './rename-dependencies';
import { reconcileQueuePaths, type TargetedReconcileContext } from './reconcile-paths';

async function harness(destinationUploaded: boolean) {
	const source = 'Dashboard.md';
	const destination = 'Upcoming.md';
	const content = new TextEncoder().encode('dashboard').buffer;
	const entry: FileEntry = {
		hash: await computeHash(content), size: content.byteLength,
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
		getAbstractFileByPath: vi.fn((path: string) => path === destination
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
			expect(disk.get('.obsidian/plugins/crate/file-manifest.json')).toContain('"revision":"v2"');
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
		vault, localManifest: manifest, getRemoteEntries, processDiff, shouldIgnore: () => false,
	};
	return { source, destination, entry, remote, manifest, context, processDiff, getRemoteEntries, deleted };
}

describe('targeted rename reconciliation', () => {
	it.each([true, false])('preserves the destination before deleting the source (already uploaded: %s)', async uploaded => {
		const h = await harness(uploaded);
		const result = await reconcileQueuePaths(h.context, [`delete:${h.source}`, h.destination]);
		expect(result.success).toBe(true);
		expect(result.settledPaths).toEqual([h.destination, `delete:${h.source}`]);
		expect(h.deleted).toHaveBeenCalledWith(h.source);
		expect(h.remote[h.destination]?.revision).toBe('v2');
	});

	it('also defers deletions discovered from ordinary queue keys', async () => {
		const h = await harness(false);
		expect((await reconcileQueuePaths(h.context, [h.source, h.destination])).success).toBe(true);
		expect(h.deleted).toHaveBeenCalledWith(h.source);
	});

	it('preserves the source when the destination upload fails', async () => {
		const h = await harness(false);
		h.processDiff.mockRejectedValueOnce(new Error('Upload failed'));
		const result = await reconcileQueuePaths(h.context, [`delete:${h.source}`, h.destination]);
		expect(result.success).toBe(false);
		expect(result.settledPaths).toEqual([]);
		expect(h.deleted).not.toHaveBeenCalled();
		expect(h.remote[h.source]).toEqual(h.entry);
	});

	it('does not upload an unselected destination or bypass the deletion guard', async () => {
		const h = await harness(false);
		const result = await reconcileQueuePaths(h.context, [`delete:${h.source}`]);
		expect(result.success).toBe(false);
		expect(result.errors.join(' ')).toContain('renamed file is uploaded');
		expect(h.getRemoteEntries).toHaveBeenCalledWith([h.source]);
		expect(h.deleted).not.toHaveBeenCalled();
		expect(h.remote[h.destination]).toBeUndefined();
	});
});
