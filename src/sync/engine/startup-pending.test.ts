import { pendingChangeKey } from '../pending/pending-change';
import type { TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { createHarness, createSyncResult, runPeriodicCheck, spyOnConflictRecovery, spyOnIncrementalSync, toArrayBuffer } from './engine-test-harness';
import { createDeferred } from '../runtime/runtime-test-harness';
import { normalizeCrateSettings } from '../../plugin/settings';
import { VERIFICATION_FILE_BUDGET } from './content-verifier';
import { LOCAL_CONTENT_CHECK_INTERVAL_MS } from './lifecycle';
import { sha256Hex } from '../../platform/sha256';

async function setup() {
	const h = createHarness({ automaticSync: false, lastSync: '2026-09-19T10:00:00Z' });
	const original = toArrayBuffer('original');
	const hash = await sha256Hex(original);
	for (const path of ['edited.md', 'unchanged.md', 'deleted.md', 'old-name.md']) {
		h.localManifest.setEntry(path, { hash, size: original.byteLength, modified: new Date(1000).toISOString() });
	}
	const files = new Map([
		['edited.md', toArrayBuffer('modified')], // Same size and timestamp as the checkpoint.
		['unchanged.md', original],
		['added.md', original],
		['new-name.md', original],
		['.hidden.md', original],
	]);
	h.vault.getFiles.mockReturnValue([...files.keys()].filter(path => !path.startsWith('.')).map(path => ({
		path, extension: 'md', stat: { size: original.byteLength, mtime: path === 'unchanged.md' ? 2000 : 1000 },
	})));
	h.vault.adapter.list.mockResolvedValue({ files: ['.hidden.md'], folders: [] });
	h.vault.adapter.stat.mockResolvedValue({ type: 'file', size: original.byteLength, mtime: 1000 });
	h.vault.adapter.exists.mockImplementation((path: string) => files.has(path));
	h.vault.adapter.readBinary.mockImplementation(async (path: string) => {
		const content = files.get(path);
		if (!content) throw new Error(`Missing file: ${path}`);
		return content;
	});
	spyOnConflictRecovery(h.engine).mockResolvedValue();
	return h;
}

async function restore(h: Awaited<ReturnType<typeof setup>>) {
	await h.engine.initialize();
	expect(h.engine.getState().initializing).toBe(true);
	expect(h.engine.getPendingKeys()).toEqual([]);
	h.workspace.runLayoutReady();
	await h.engine.waitForIdle();
	expect(h.engine.getState().initializing).toBe(false);
}

describe('pending changes after restart with automatic sync off', () => {
	it('rebuilds separate entries for delete-prefixed files and neighboring deletions', async () => {
		const h = await setup();
		const original = toArrayBuffer('original');
		h.localManifest.setEntry('note.md', { hash: await sha256Hex(original), size: original.byteLength, modified: new Date(1000).toISOString() });
		const files = h.vault.getFiles() as TFile[];
		h.vault.getFiles.mockReturnValue([...files, { path: 'delete:note.md', extension: 'md', stat: { size: original.byteLength, mtime: 1000 } }]);
		try {
			await restore(h);
			expect(h.engine.getPendingKeys()).toContain('delete:note.md');
			expect(h.engine.getPendingKeys()).toContain(pendingChangeKey('delete', 'note.md'));
		} finally { h.engine.destroy(); }
	});

	it('keeps fresh-install files pending without transfers after discovery, edits, and periodic checks', async () => {
		vi.useFakeTimers();
		const h = createHarness(normalizeCrateSettings(undefined, '.vault-config'));
		const files = [{ path: 'existing.md', extension: 'md', stat: { size: 8, mtime: 1000 } }];
		h.vault.getFiles.mockImplementation(() => files);
		h.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('modified'));
		h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		const recovery = spyOnConflictRecovery(h.engine).mockResolvedValue();
		try {
			expect(h.settings.automaticSync).toBe(false);
			await restore(h);
			files.push({ path: 'edited.md', extension: 'md', stat: { size: 8, mtime: 1000 } });
			h.engine.onFileChange({ path: 'edited.md' } as never);
			await vi.advanceTimersByTimeAsync(h.settings.syncInterval * 2 * 1000);
			await h.engine.waitForIdle();
			await runPeriodicCheck(h.engine);

			expect(h.engine.getPendingKeys().sort()).toEqual(['edited.md', 'existing.md']);
			expect(h.engine.getState()).toMatchObject({ status: 'idle', lastSync: null, pendingChanges: 2 });
			for (const call of [h.api.checkForChanges, h.api.getChanges, h.api.getManifest, h.api.uploadFile, h.api.batchUpload, h.api.batchDownload, h.api.batchDelete, h.api.recoverUploads]) {
				expect(call).not.toHaveBeenCalled();
			}
		} finally {
			h.engine.destroy();
			recovery.mockRestore();
			vi.useRealTimers();
		}
	});

	it('rediscovers edits, additions, hidden files, deletes and renames without syncing', async () => {
		const h = await setup();
		try {
			await restore(h);
			expect(h.engine.getPendingKeys().sort()).toEqual([
				'.hidden.md', 'added.md', pendingChangeKey('delete', 'deleted.md'), pendingChangeKey('delete', 'old-name.md'), 'edited.md', 'new-name.md',
			].sort());
			expect(h.engine.getState()).toMatchObject({ status: 'idle', pendingChanges: 6, lastSync: h.settings.lastSync });
			for (const call of [h.api.getChanges, h.api.getManifest, h.api.uploadFile, h.api.batchUpload, h.api.batchDownload, h.api.batchDelete, h.api.recoverUploads]) {
				expect(call).not.toHaveBeenCalled();
			}
		} finally { h.engine.destroy(); }
	});

	it('preserves a newer delete event while the startup scan is reading', async () => {
		const h = await setup();
		const reading = createDeferred<ArrayBuffer>();
		h.vault.adapter.readBinary.mockReturnValue(reading.promise);
		try {
			await h.engine.initialize();
			h.workspace.runLayoutReady();
			expect(h.engine.getState().initializing).toBe(true);
			h.engine.onFileDelete({ path: 'edited.md' } as never);
			reading.resolve(toArrayBuffer('modified'));
			await h.engine.waitForIdle();
			expect(h.engine.getPendingKeys()).toContain(pendingChangeKey('delete', 'edited.md'));
			expect(h.engine.getPendingKeys()).not.toContain('edited.md');
		} finally { h.engine.destroy(); }
	});

	it('discards an outdated scan when a manual sync runs', async () => {
		const h = await setup();
		const reading = createDeferred<ArrayBuffer>();
		h.vault.adapter.readBinary.mockReturnValue(reading.promise);
		try {
			await h.engine.initialize();
			h.workspace.runLayoutReady();
			spyOnIncrementalSync(h.engine, createSyncResult());
			await h.engine.sync();
			reading.resolve(toArrayBuffer('modified'));
			await h.engine.waitForIdle();
			expect(h.engine.getPendingKeys()).toEqual([]);
		} finally { h.engine.destroy(); }
	});

	it('reports scan failures instead of silently declaring no pending changes', async () => {
		const h = await setup();
		h.vault.adapter.list.mockRejectedValue(new Error('disk unavailable'));
		try {
			await restore(h);
			expect(h.engine.getState().status).toBe('error');
			expect(h.engine.getState().lastError).toContain('disk unavailable');
		} finally { h.engine.destroy(); }
	});

	it('does not restore pending paths after the engine is destroyed', async () => {
		const h = await setup();
		await h.engine.initialize();
		h.engine.destroy();
		h.workspace.runLayoutReady();
		await h.engine.waitForIdle();
		expect(h.engine.getPendingKeys()).toEqual([]);
	});
});

describe('startup pending scan cost', () => {
	async function largeVault(count: number) {
		const h = createHarness({ automaticSync: false, lastSync: '2026-09-19T10:00:00Z' });
		const original = toArrayBuffer('original');
		const hash = await sha256Hex(original);
		const paths = Array.from({ length: count }, (_, i) => `notes/${i.toString().padStart(4, '0')}.md`);
		const disk = new Map(paths.map(path => [path, original]));
		const mtimes = new Map(paths.map(path => [path, 1000]));
		for (const path of paths) h.localManifest.setEntry(path, { hash, size: original.byteLength, modified: new Date(1000).toISOString() });
		h.vault.getFiles.mockImplementation(() => [...disk.keys()].map(path => ({
			path, extension: 'md', stat: { size: disk.get(path)!.byteLength, mtime: mtimes.get(path)! },
		})));
		// An already seeded Markdown base cache keeps its reads out of these counts.
		h.vault.adapter.list.mockImplementation(async (dir: string) => dir.endsWith('/markdown-base-cache')
			? { files: [`${dir}/${hash}.md`], folders: [] } : { files: [], folders: [] });
		h.vault.adapter.exists.mockImplementation((path: string) => disk.has(path));
		h.vault.adapter.stat.mockImplementation(async (path: string) => disk.has(path)
			? { type: 'file', size: disk.get(path)!.byteLength, mtime: mtimes.get(path)! } : null);
		h.vault.adapter.readBinary.mockImplementation(async (path: string) => {
			const content = disk.get(path);
			if (!content) throw new Error(`Missing file: ${path}`);
			return content;
		});
		const recovery = spyOnConflictRecovery(h.engine).mockResolvedValue();
		const reads = () => h.vault.adapter.readBinary.mock.calls.filter(([path]) => path.startsWith('notes/')).length;
		return { h, paths, disk, mtimes, recovery, reads };
	}

	it('reads only changed files plus one rotation instead of hashing every tracked file', async () => {
		const { h, paths, disk, mtimes, recovery, reads } = await largeVault(200);
		disk.set(paths[150]!, toArrayBuffer('edited!!'));
		mtimes.set(paths[150]!, 2000);
		try {
			await restore(h);
			expect(h.engine.getPendingKeys()).toEqual([paths[150]]);
			// Before: 200 reads. Now: 32 rotated checks plus the one edited file.
			expect(reads()).toBe(VERIFICATION_FILE_BUDGET + 1);
		} finally { h.engine.destroy(); recovery.mockRestore(); }
	});

	it('finds same-size, same-time edits by checking tracked files locally every five minutes', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const { h, paths, disk, recovery, reads } = await largeVault(40);
		// Outside the first 32-file rotation, with unchanged size and time.
		disk.set(paths[39]!, toArrayBuffer('changed!'));
		try {
			await restore(h);
			expect(h.engine.getPendingKeys()).toEqual([]);
			const listings = h.vault.adapter.list.mock.calls.length;
			const before = reads();

			await vi.advanceTimersByTimeAsync(LOCAL_CONTENT_CHECK_INTERVAL_MS);
			await h.engine.waitForIdle();

			expect(h.engine.getPendingKeys()).toEqual([paths[39]]);
			expect(reads() - before).toBe(VERIFICATION_FILE_BUDGET);
			expect(h.vault.adapter.list.mock.calls.length).toBe(listings);
			for (const call of [h.api.checkForChanges, h.api.getChanges, h.api.getManifest, h.api.batchUpload, h.api.uploadFile]) {
				expect(call).not.toHaveBeenCalled();
			}
		} finally { h.engine.destroy(); recovery.mockRestore(); vi.useRealTimers(); }
	});
});
