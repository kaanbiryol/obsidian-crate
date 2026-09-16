import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHarness, toArrayBuffer, type Harness } from './engine-test-harness';
import { createDeferred } from './runtime-test-harness';
import { computeHash } from './hasher';

let harness: Harness;
const path = '.vault-config/plugins/example/data.json';
const fileStat = { type: 'file', size: 10, mtime: 1 };

beforeEach(() => {
	harness = createHarness({ automaticSync: false });
	harness.vault.adapter.stat.mockResolvedValue(fileStat);
});
afterEach(() => harness.engine.destroy());

it.each([path, '.vault-config/plugins/example/main.js', '.vault-config/app.json', '.hidden/file.txt'])(
	'queues an unindexed file change: %s', async changedPath => {
		const stateChanged = vi.fn();
		harness.engine.setStateChangeCallback(stateChanged);
		await harness.engine.onRawFileChange(changedPath);
		expect(harness.engine.getPendingPaths()).toEqual([changedPath]);
		expect(stateChanged).toHaveBeenLastCalledWith(expect.objectContaining({ pendingChanges: 1 }));
	},
);

it('queues configuration files in a custom non-hidden configuration folder', async () => {
	Object.assign(harness.vault, { configDir: 'custom-config' });
	await harness.engine.onRawFileChange('custom-config/plugins/example/data.json');
	expect(harness.engine.getPendingPaths()).toEqual(['custom-config/plugins/example/data.json']);
});

it.each(['notes/note.md', '.trash/file.json', '.vault-config/plugins/crate/data.json', '.hidden/file.tmp'])(
	'leaves indexed and ignored paths out of the raw queue: %s', async ignoredPath => {
		await harness.engine.onRawFileChange(ignoredPath);
		expect(harness.vault.adapter.stat).not.toHaveBeenCalled();
		expect(harness.engine.getPendingPaths()).toEqual([]);
	},
);

it('queues deletion and replaces it when the file is recreated', async () => {
	harness.vault.adapter.stat.mockResolvedValueOnce(null);
	await harness.engine.onRawFileChange(path);
	expect(harness.engine.getPendingPaths()).toEqual([`delete:${path}`]);
	await harness.engine.onRawFileChange(path);
	expect(harness.engine.getPendingPaths()).toEqual([path]);
});

it('does not queue existing folders', async () => {
	harness.vault.adapter.stat.mockResolvedValue({ ...fileStat, type: 'folder' });
	await harness.engine.onRawFileChange('.vault-config/plugins');
	expect(harness.engine.getPendingPaths()).toEqual([]);
});

it('discards an older inspection that completes after a newer event', async () => {
	const old = createDeferred<typeof fileStat | null>();
	harness.vault.adapter.stat.mockReturnValueOnce(old.promise);
	const pending = harness.engine.onRawFileChange(path);
	await harness.engine.onRawFileChange(path);
	old.resolve(null);
	await pending;
	expect(harness.engine.getPendingPaths()).toEqual([path]);
});

it('does not queue an inspection that completes after unload', async () => {
	const pendingStat = createDeferred<typeof fileStat | null>();
	harness.vault.adapter.stat.mockReturnValueOnce(pendingStat.promise);
	const pending = harness.engine.onRawFileChange(path);
	harness.engine.destroy();
	pendingStat.resolve(fileStat);
	await pending;
	expect(harness.engine.getPendingPaths()).toEqual([]);
});

it('keeps touched configuration files visible even when their contents match the last sync', async () => {
	const bytes = toArrayBuffer('same bytes');
	harness.localManifest.getEntry.mockReturnValue({ hash: await computeHash(bytes), size: bytes.byteLength, modified: new Date(0).toISOString() });
	harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: bytes.byteLength, mtime: 50 });
	harness.vault.adapter.readBinary.mockResolvedValue(bytes);
	await harness.engine.onRawFileChange(path);
	expect(harness.engine.getPendingPaths()).toEqual([path]);
	expect(harness.engine.getState().pendingChanges).toBe(1);
	expect(harness.api.uploadFile).not.toHaveBeenCalled();
});
