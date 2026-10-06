import { expect, it, vi } from 'vitest';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { createHarness, toArrayBuffer } from './engine-test-harness';
import { createDeferred } from './runtime-test-harness';
import { TEST_PLUGIN_DIR } from '../test/factories/sync-vault';
import { computeHash } from './hasher';

const unexpectedRequest = vi.fn(async (): Promise<never> => { throw new Error('Unexpected network request'); });

it('drains an accepted conflict write before a replacement engine opens the store', async () => {
	const { engine, vault, disk } = await createPersistentEngineHarness(unexpectedRequest);
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	const oldPath = 'old (conflict 2026-01-02 03-04-05 ab12).md';
	const newPath = 'new (conflict 2026-01-02 03-04-05 cd34).md';
	disk.write(oldPath, 'old copy');
	const write = vault.adapter.write.bind(vault.adapter);
	let held = false;
	vi.spyOn(vault.adapter, 'write').mockImplementation(async (path, text) => {
		if (!held && path === `${TEST_PLUGIN_DIR}/conflicts.json.tmp`) {
			held = true;
			started.resolve();
			await release.promise;
		}
		await write(path, text);
	});
	engine.onFileChange({ path: oldPath } as never);
	await started.promise;
	engine.destroy();
	const drained = vi.fn();
	const stopping = engine.waitForIdle().then(drained);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(drained).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await stopping;
	}

	const replacement = await createPersistentEngineHarness(unexpectedRequest, {}, disk);
	expect(replacement.engine.getActiveConflicts()).toMatchObject([{ conflictPath: oldPath }]);
	disk.write(newPath, 'new copy');
	replacement.engine.onFileChange({ path: newPath } as never);
	await replacement.engine.waitForIdle();
	engine.onFileDelete({ path: newPath } as never);
	await engine.waitForIdle();
	expect(JSON.parse(disk.text(`${TEST_PLUGIN_DIR}/conflicts.json`))).toEqual({ version: 1, conflicts: [
		expect.objectContaining({ conflictPath: oldPath, status: 'active' }),
		expect.objectContaining({ conflictPath: newPath, status: 'active' }),
	] });
});

it('finishes accepted conflict metadata when a synchronous callback stops the engine before awaited I/O', async () => {
	const { engine, disk } = await createPersistentEngineHarness(unexpectedRequest);
	const path = 'note (conflict 2026-01-02 03-04-05 ab12).md';
	disk.write(path, 'copy');
	engine.onFileChange({ path } as never);
	await engine.waitForIdle();
	const release = createDeferred<void>();
	const operation = engine.runConflictResolution(async () => {
		engine.destroy();
		await release.promise;
		await engine.markConflictResolved(path);
	});
	const drained = vi.fn();
	const stopping = engine.waitForIdle().then(drained);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(drained).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await operation;
		await stopping;
	}
	expect(JSON.parse(disk.text(`${TEST_PLUGIN_DIR}/conflicts.json`))).toEqual({ version: 1, conflicts: [
		expect.objectContaining({ conflictPath: path, status: 'resolved' }),
	] });
});

it('drains an in-flight conflict discovery read without publishing its cancelled scan', async () => {
	const { engine, vault, workspace } = createHarness();
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	vault.getFiles.mockReturnValue([]);
	vault.adapter.list.mockImplementation(async path => {
		if (path === '') { started.resolve(); await release.promise; }
		return { files: [], folders: [] };
	});
	await engine.initialize();
	workspace.runLayoutReady();
	await started.promise;
	engine.destroy();
	const drained = vi.fn();
	const stopping = engine.waitForIdle().then(drained);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(drained).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await stopping;
	}
	expect(vault.adapter.write).not.toHaveBeenCalled();
});

it('drains a cache seed write already dispatched during initialization', async () => {
	const { engine, vault, localManifest } = createHarness();
	const content = toArrayBuffer('unchanged markdown');
	const hash = await computeHash(content);
	localManifest.load.mockResolvedValue();
	localManifest.setEntry('note.md', { hash, size: content.byteLength, modified: new Date(0).toISOString() });
	vault.adapter.readBinary.mockResolvedValue(content);
	vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	vault.adapter.writeBinary.mockImplementation(async () => { started.resolve(); await release.promise; });
	await engine.initialize();
	await started.promise;
	engine.destroy();
	const drained = vi.fn();
	const stopping = engine.waitForIdle().then(drained);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(drained).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await stopping;
	}
	expect(vault.adapter.writeBinary).toHaveBeenCalledExactlyOnceWith(
		`.vault-config/plugins/crate/markdown-base-cache/${hash}.md`, content,
	);
});

it('drains a cache prune already dispatched by background seeding', async () => {
	const { engine, vault } = createHarness();
	const stalePath = `.vault-config/plugins/crate/markdown-base-cache/${'a'.repeat(64)}.md`;
	vault.adapter.list.mockResolvedValue({ files: [stalePath], folders: [] });
	const started = createDeferred<void>();
	const release = createDeferred<void>();
	vault.adapter.remove.mockImplementation(async path => {
		if (path === stalePath) { started.resolve(); await release.promise; }
	});
	await engine.initialize();
	await started.promise;
	engine.destroy();
	const drained = vi.fn();
	const stopping = engine.waitForIdle().then(drained);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(drained).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await stopping;
	}
	expect(vault.adapter.remove).toHaveBeenCalledExactlyOnceWith(stalePath);
});
