import { describe, expect, it, vi } from 'vitest';
import { LocalContentVerifier, VERIFICATION_FILE_BUDGET, VERIFICATION_BYTE_BUDGET } from './content-verifier';
import { LocalManifest } from './manifest';
import { computeHash } from './hasher';
import { getLocalChanges } from './planner-local';
import { createFullSyncPlan } from './planner-full';
import { createHarness, toArrayBuffer } from './engine-test-harness';
import { createDeferred } from './runtime-test-harness';
import type { VaultFile } from './file-discovery';

async function fixture(count = 1, size = 4) {
	const original = toArrayBuffer('same');
	const hash = await computeHash(original);
	const files: VaultFile[] = Array.from({ length: count }, (_, i) => ({ path: `notes/${i.toString().padStart(5, '0')}.md`, size, mtime: 1000, extension: 'md' }));
	const disk = new Map<string, string>();
	const adapter = {
		readBinary: vi.fn(async (_path: string) => original),
		read: vi.fn(async (path: string) => disk.get(path)!),
		write: vi.fn(async (path: string, data: string) => { disk.set(path, data); }),
		remove: vi.fn(async (path: string) => { disk.delete(path); }),
		exists: vi.fn(async (path: string) => disk.has(path)),
		list: vi.fn(async () => ({ files: [], folders: [] })),
	};
	const vault = { adapter, getFiles: () => files.map(file => ({ path: file.path, extension: file.extension, stat: { size: file.size, mtime: file.mtime } })) };
	const app = { vault } as never;
	const plugin = { dir: '.obsidian/plugins/crate' } as never;
	const manifest = new LocalManifest(app, plugin, 'https://server.example');
	for (const file of files) manifest.setEntry(file.path, { hash, size, modified: new Date(1000).toISOString(), revision: 'original-revision' });
	await manifest.save();
	const verifier = new LocalContentVerifier();
	const signal = new AbortController().signal;
	const verify = () => verifier.verify(vault as never, manifest, files, signal);
	const planner = {
		vault: vault as never, localManifest: manifest, shouldIgnore: () => false,
		runConcurrent: <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
	};
	return { files, adapter, manifest, hash, verify, app, plugin, planner, verifier, signal };
}

describe('content verification independent of filesystem fingerprints', () => {
	it('retains a hidden edit for the planner and after restart without advancing the ancestor', async () => {
		const h = await fixture();
		h.files[0]!.path = '.hidden.md';
		h.manifest.setEntry('.hidden.md', h.manifest.getEntry('notes/00000.md')!);
		h.adapter.readBinary.mockResolvedValue(toArrayBuffer('edit'));
		expect(await h.verify()).toBe(true);
		expect(h.manifest.getEntry('.hidden.md')).toEqual({ hash: h.hash, size: 4, modified: 'unverified', revision: 'original-revision' });
		const restarted = new LocalManifest(h.app, h.plugin, 'https://server.example');
		await restarted.load();
		expect(restarted.getEntry('.hidden.md')?.modified).toBe('unverified');
		expect(await getLocalChanges({ ...h.planner, localManifest: restarted }, 1)).toEqual([{ path: '.hidden.md', hash: await computeHash(toArrayBuffer('edit')) }]);
	});

	it('full reconciliation detects a same-size, same-time offline edit immediately', async () => {
		const h = await fixture();
		h.adapter.readBinary.mockResolvedValue(toArrayBuffer('edit'));
		const remote = structuredClone(h.manifest.getManifest().files);
		const plan = await createFullSyncPlan(h.planner, remote, 1);
		expect(plan.uploadDiffs.map(diff => diff.path)).toEqual(['notes/00000.md']);
		expect(h.manifest.getEntry('notes/00000.md')?.hash).toBe(h.hash);
	});

	it('covers 10,000 unchanged files in bounded rotations without re-reading the entire vault per check', async () => {
		const h = await fixture(10_000);
		for (let round = 0; round < Math.ceil(h.files.length / VERIFICATION_FILE_BUDGET); round++) {
			const before = h.adapter.readBinary.mock.calls.length;
			expect(await h.verify()).toBe(false);
			expect(h.adapter.readBinary.mock.calls.length - before).toBeLessThanOrEqual(VERIFICATION_FILE_BUDGET);
		}
		expect(new Set(h.adapter.readBinary.mock.calls.map(([path]) => path)).size).toBe(10_000);
	});

	it('honors the byte budget while allowing a large eligible file to progress', async () => {
		const h = await fixture(3, VERIFICATION_BYTE_BUDGET + 1);
		await h.verify();
		expect(h.adapter.readBinary).toHaveBeenCalledTimes(1);
		await h.verify();
		expect(h.adapter.readBinary.mock.calls.map(([path]) => path)).toEqual(h.files.slice(0, 2).map(file => file.path));
	});

	it('persists an already detected mismatch when a later read fails, without declaring a deletion', async () => {
		const h = await fixture(2);
		h.adapter.readBinary.mockResolvedValueOnce(toArrayBuffer('edit')).mockRejectedValueOnce(new Error('unreadable'));
		await expect(h.verify()).rejects.toThrow('unreadable');
		const restarted = new LocalManifest(h.app, h.plugin, 'https://server.example');
		await restarted.load();
		expect(restarted.getEntry('notes/00000.md')?.modified).toBe('unverified');
		expect(restarted.getEntry('notes/00001.md')?.hash).toBe(h.hash);
	});

	it('does not invalidate a newer sync ancestor or write after engine cancellation', async () => {
		for (const cancel of [false, true]) {
			const h = await fixture();
			const gate = createDeferred<ArrayBuffer>();
			h.adapter.readBinary.mockReturnValue(gate.promise);
			const controller = new AbortController();
			const checking = h.verifier.verify(h.planner.vault, h.manifest, h.files, controller.signal);
			await vi.waitFor(() => expect(h.adapter.readBinary).toHaveBeenCalled());
			const next = { hash: 'new-ancestor', size: 4, modified: new Date(1000).toISOString(), revision: 'new-revision' };
			if (cancel) controller.abort();
			else h.manifest.setEntry('notes/00000.md', next);
			gate.resolve(toArrayBuffer('edit'));
			if (cancel) await expect(checking).rejects.toMatchObject({ name: 'AbortError' });
			else expect(await checking).toBe(false);
			expect(h.manifest.getEntry('notes/00000.md')?.modified).not.toBe('unverified');
		}
	});

	it('exposes an immediate safe verification path even with a valid incremental cursor', async () => {
		const h = createHarness({ lastSeq: 42 });
		h.vault.getFiles.mockReturnValue([]);
		h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		h.api.getManifest.mockResolvedValue({ version: 1, files: {}, lastSeq: 42 });
		expect((await h.engine.sync(undefined, true)).success).toBe(true);
		expect(h.api.getManifest).toHaveBeenCalledOnce();
		expect(h.api.getChanges).not.toHaveBeenCalled();
		expect(h.api.batchDelete).not.toHaveBeenCalled();
		h.engine.destroy();
	});

	it('hands a periodic fingerprint mismatch to the real incremental upload path', async () => {
		const h = createHarness({ lastSeq: 42 });
		const path = 'notes/edit.md';
		const stat = { size: 4, mtime: 1000 };
		h.vault.getFiles.mockReturnValue([{ path, extension: 'md', stat }]);
		h.vault.getAbstractFileByPath.mockReturnValue({ path, extension: 'md', stat });
		h.vault.adapter.exists.mockResolvedValue(true);
		h.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		h.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('edit'));
		h.api.getChanges.mockResolvedValue({ changes: [], lastSeq: 42, hasMore: false });
		h.localManifest.setEntry(path, { hash: await computeHash(toArrayBuffer('same')), size: 4, modified: new Date(1000).toISOString() });
		expect(await h.engine.hasUnsyncedLocalChanges()).toBe(true);
		const result = await h.engine.sync();
		expect(result.success).toBe(true);
		expect(result.uploadedPaths).toEqual([path]);
		expect(h.api.batchUpload).toHaveBeenCalledOnce();
		h.engine.destroy();
	});
});
