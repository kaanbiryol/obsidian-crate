import { pendingChangeKey } from '../pending/pending-change';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHarness, createSyncResult, spyOnIncrementalSync, toArrayBuffer, type Harness } from './engine-test-harness';
import { createDeferred } from '../runtime/runtime-test-harness';
import { sha256Hex } from '../../platform/sha256';

let harness: Harness;
const path = '.vault-config/plugins/example/data.json';
const fileStat = { type: 'file', size: 10, mtime: 1 };

beforeEach(() => {
	harness = createHarness({ automaticSync: false });
	harness.vault.adapter.stat.mockResolvedValue(fileStat);
});
afterEach(() => harness.engine.destroy());

async function trackedFile(candidate = path, bytes = toArrayBuffer('same bytes')) {
	harness.localManifest.setEntry(candidate, {
		hash: await sha256Hex(bytes), size: bytes.byteLength, modified: new Date(1).toISOString(),
	});
	harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: bytes.byteLength, mtime: 1 });
	harness.vault.adapter.readBinary.mockResolvedValue(bytes);
	return bytes;
}

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
	expect(harness.engine.getPendingPaths()).toEqual([pendingChangeKey('delete', path)]);
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

it('never publishes touched configuration files when their contents match the last sync', async () => {
	vi.useFakeTimers();
	try {
		const bytes = toArrayBuffer('same bytes');
		harness.localManifest.setEntry(path, { hash: await sha256Hex(bytes), size: bytes.byteLength, modified: new Date(0).toISOString() });
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: bytes.byteLength, mtime: 50 });
		harness.vault.adapter.readBinary.mockResolvedValue(bytes);
		const stateChanged = vi.fn();
		harness.engine.setStateChangeCallback(stateChanged);
		for (let i = 0; i < 3; i++) {
			await harness.engine.onRawFileChange(path);
			expect(harness.engine.getPendingPaths()).toEqual([]);
			expect(harness.engine.getState().pendingChanges).toBe(0);
		}
		await vi.advanceTimersByTimeAsync(250);
		await harness.engine.waitForIdle();
		expect(harness.engine.getPendingPaths()).toEqual([]);
		expect(harness.engine.getState().pendingChanges).toBe(0);
		expect(stateChanged).not.toHaveBeenCalled();
		expect(harness.localManifest.getEntry(path)?.modified).toBe(new Date(50).toISOString());
		expect(harness.localManifest.save).toHaveBeenCalledOnce();
		expect(harness.api.uploadFile).not.toHaveBeenCalled();
	} finally { vi.useRealTimers(); }
});

it('checks settings and binary theme assets without publishing startup noise', async () => {
	const paths = ['.vault-config/app.json', '.vault-config/themes/example/theme.css', '.hidden/image.png'];
	for (const candidate of paths) await trackedFile(candidate, new Uint8Array([255, 0, 128]).buffer);
	const stateChanged = vi.fn();
	harness.engine.setStateChangeCallback(stateChanged);
	await Promise.all(paths.map(candidate => harness.engine.onRawFileChange(candidate)));
	expect(harness.engine.getPendingPaths()).toEqual([]);
	expect(stateChanged).not.toHaveBeenCalled();
	expect(harness.vault.adapter.readBinary).toHaveBeenCalledTimes(paths.length);
	expect(harness.api.getManifest).not.toHaveBeenCalled();
	expect(harness.api.getChanges).not.toHaveBeenCalled();
});

it('publishes a real settings edit even when its size and timestamp match the checkpoint', async () => {
	await trackedFile();
	harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('new! bytes'));
	await harness.engine.onRawFileChange(path);
	expect(harness.engine.getPendingPaths()).toEqual([path]);
	expect(harness.engine.getState().pendingChanges).toBe(1);
});

it.each(['read', 'save'])('keeps a configuration change pending after a verification %s failure', async operation => {
	await trackedFile();
	if (operation === 'read') harness.vault.adapter.readBinary.mockRejectedValue(new Error('read failed'));
	else {
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 10, mtime: 2 });
		harness.localManifest.save.mockRejectedValue(new Error('save failed'));
	}
	await harness.engine.onRawFileChange(path);
	expect(harness.engine.getPendingPaths()).toEqual([path]);
});

it('preserves a deletion arriving while an older settings notification is being verified', async () => {
	const bytes = await trackedFile();
	const started = createDeferred<void>();
	const reading = createDeferred<ArrayBuffer>();
	harness.vault.adapter.readBinary.mockImplementationOnce(() => { started.resolve(); return reading.promise; });
	const previous = harness.engine.onRawFileChange(path);
	await started.promise;
	harness.vault.adapter.stat.mockResolvedValue(null);
	await harness.engine.onRawFileChange(path);
	reading.resolve(bytes);
	await previous;
	expect(harness.engine.getPendingPaths()).toEqual([pendingChangeKey('delete', path)]);
});

it('preserves a newer edit while serializing settings verification', async () => {
	const bytes = await trackedFile();
	const started = createDeferred<void>();
	const reading = createDeferred<ArrayBuffer>();
	harness.vault.adapter.readBinary.mockImplementationOnce(() => { started.resolve(); return reading.promise; });
	const previous = harness.engine.onRawFileChange(path);
	await started.promise;
	harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('new! bytes'));
	const next = harness.engine.onRawFileChange(path);
	reading.resolve(bytes);
	await Promise.all([previous, next]);
	expect(harness.engine.getPendingPaths()).toEqual([path]);
});

it('does not accept an old hash check when a manual sync ran during verification', async () => {
	const bytes = await trackedFile();
	const started = createDeferred<void>();
	const reading = createDeferred<ArrayBuffer>();
	harness.vault.adapter.readBinary.mockImplementationOnce(() => { started.resolve(); return reading.promise; });
	const notification = harness.engine.onRawFileChange(path);
	await started.promise;
	spyOnIncrementalSync(harness.engine, createSyncResult());
	await harness.engine.sync();
	reading.resolve(bytes);
	await notification;
	expect(harness.engine.getPendingPaths()).toEqual([path]);
});

it('leaves settings pending while a durable restore needs reconciliation', async () => {
	await trackedFile();
	harness.api.getPendingRestores.mockReturnValue([{ path }]);
	await harness.engine.onRawFileChange(path);
	expect(harness.engine.getPendingPaths()).toEqual([path]);
	expect(harness.vault.adapter.readBinary).not.toHaveBeenCalled();
});

it('drains a settings timestamp checkpoint on unload without publishing a late pending entry', async () => {
	await trackedFile();
	harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 10, mtime: 2 });
	const saving = createDeferred<void>();
	const release = createDeferred<void>();
	harness.localManifest.save.mockImplementationOnce(() => { saving.resolve(); return release.promise; });
	const notification = harness.engine.onRawFileChange(path);
	await saving.promise;
	harness.engine.destroy();
	const drained = vi.fn();
	const stopping = harness.engine.waitForIdle().then(drained);
	try {
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(drained).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await Promise.all([notification, stopping]);
	}
	expect(harness.engine.getPendingPaths()).toEqual([]);
});
