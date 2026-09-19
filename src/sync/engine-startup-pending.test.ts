import { describe, expect, it } from 'vitest';
import { computeHash } from './hasher';
import { createHarness, createSyncResult, spyOnConflictRecovery, spyOnIncrementalSync, toArrayBuffer } from './engine-test-harness';
import { createDeferred } from './runtime-test-harness';

async function setup() {
	const h = createHarness({ automaticSync: false, lastSync: '2026-09-19T10:00:00Z' });
	const original = toArrayBuffer('original');
	const hash = await computeHash(original);
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
	h.vault.adapter.readBinary.mockImplementation((path: string) => files.get(path));
	spyOnConflictRecovery(h.engine).mockResolvedValue();
	return h;
}

async function restore(h: Awaited<ReturnType<typeof setup>>) {
	await h.engine.initialize();
	expect(h.engine.getPendingPaths()).toEqual([]);
	h.workspace.runLayoutReady();
	await h.engine.waitForIdle();
}

describe('pending changes after restart with automatic sync off', () => {
	it('rediscovers edits, additions, hidden files, deletes and renames without syncing', async () => {
		const h = await setup();
		try {
			await restore(h);
			expect(h.engine.getPendingPaths().sort()).toEqual([
				'.hidden.md', 'added.md', 'delete:deleted.md', 'delete:old-name.md', 'edited.md', 'new-name.md',
			]);
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
			h.engine.onFileDelete({ path: 'edited.md' } as never);
			reading.resolve(toArrayBuffer('modified'));
			await h.engine.waitForIdle();
			expect(h.engine.getPendingPaths()).toContain('delete:edited.md');
			expect(h.engine.getPendingPaths()).not.toContain('edited.md');
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
			expect(h.engine.getPendingPaths()).toEqual([]);
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
		expect(h.engine.getPendingPaths()).toEqual([]);
	});
});
