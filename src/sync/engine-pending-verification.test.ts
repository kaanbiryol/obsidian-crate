import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import { createHarness, createSyncResult, spyOnIncrementalSync, toArrayBuffer, type Harness } from './engine-test-harness';
import { createDeferred } from './runtime-test-harness';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';

let h: Harness;
const path = '.vault-config/app.json';
const original = toArrayBuffer('{"setting":true}');
const stat = { type: 'file', size: original.byteLength, mtime: 2000 };

beforeEach(async () => {
	vi.useFakeTimers();
	h = createHarness({ automaticSync: false });
	h.localManifest.setEntry(path, {
		hash: await computeHash(original), size: original.byteLength,
		modified: new Date(1000).toISOString(), revision: 'remote-revision',
	});
	h.vault.adapter.stat.mockResolvedValue(stat);
	h.vault.adapter.readBinary.mockResolvedValue(original);
	h.localManifest.setEntry.mockClear();
});

afterEach(() => { h.engine.destroy(); vi.useRealTimers(); });

function touch(candidate = path) { h.engine.onFileChange({ path: candidate } as never); }
async function startVerification() { await vi.advanceTimersByTimeAsync(250); }
async function verify() { await startVerification(); await h.engine.waitForIdle(); }
function expectNoTransfers() {
	for (const call of [h.api.getChanges, h.api.getManifest, h.api.checkForChanges, h.api.uploadFile,
		h.api.batchUpload, h.api.downloadFile, h.api.batchDownload, h.api.batchDelete, h.api.recoverUploads]) {
		expect(call).not.toHaveBeenCalled();
	}
}

it('clears unchanged events offline, refreshes only the timestamp, and leaves last sync untouched', async () => {
	const baseline = h.localManifest.getEntry(path)!;
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([]);
	expect(h.engine.getState()).toMatchObject({ pendingChanges: 0, status: 'idle', lastSync: null });
	expect(h.localManifest.getEntry(path)).toEqual({ ...baseline, modified: new Date(stat.mtime).toISOString() });
	expect(h.localManifest.save).toHaveBeenCalledOnce();
	expectNoTransfers();
});

it('coalesces repeated events and checkpoints multiple matching files once', async () => {
	h.localManifest.setEntry('note.md', h.localManifest.getEntry(path)!);
	for (let i = 0; i < 5; i++) touch();
	touch('note.md');
	await verify();
	expect(h.vault.adapter.readBinary).toHaveBeenCalledTimes(2);
	expect(h.localManifest.save).toHaveBeenCalledOnce();
	expect(h.engine.getPendingPaths()).toEqual([]);
});

it('does not transfer unchanged events when automatic sync is enabled', async () => {
	h.engine.updateSettings({ ...h.settings, automaticSync: true });
	touch();
	await verify();
	await vi.advanceTimersByTimeAsync(6000);
	expect(h.engine.getPendingPaths()).toEqual([]);
	expectNoTransfers();
});

it('keeps a real edit pending even when size and timestamp match the checkpoint', async () => {
	h.vault.adapter.stat.mockResolvedValue({ ...stat, mtime: 1000 });
	h.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('{"setting":null}'));
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expect(h.localManifest.setEntry).not.toHaveBeenCalled();
	expect(h.localManifest.save).not.toHaveBeenCalled();
	expectNoTransfers();
});

it('hashes binary files without relying on a text preview', async () => {
	const bytes = new Uint8Array([255, 0, 128]).buffer;
	h.localManifest.setEntry('image.png', { hash: await computeHash(bytes), size: 3, modified: '' });
	h.vault.adapter.stat.mockResolvedValue({ ...stat, size: 3 });
	h.vault.adapter.readBinary.mockResolvedValue(bytes);
	touch('image.png');
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([]);
});

it('keeps new files, deletions, and both sides of renames pending', async () => {
	touch('new.md');
	h.engine.onFileRename({ path: 'renamed.json' } as never, path);
	await verify();
	expect(h.engine.getPendingPaths().sort()).toEqual([`delete:${path}`, 'new.md', 'renamed.json'].sort());
	expect(h.vault.adapter.readBinary).not.toHaveBeenCalled();
	expectNoTransfers();
});

it('settles an edit that is subsequently reverted', async () => {
	h.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('edited'));
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	h.vault.adapter.readBinary.mockResolvedValue(original);
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([]);
});

it('keeps newer edits made while the old contents are being read', async () => {
	const reading = createDeferred<ArrayBuffer>();
	h.vault.adapter.readBinary.mockReturnValueOnce(reading.promise);
	touch();
	await startVerification();
	touch();
	h.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('new edit'));
	reading.resolve(original);
	await h.engine.waitForIdle();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expect(h.localManifest.setEntry).not.toHaveBeenCalled();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expect(h.vault.adapter.readBinary).toHaveBeenCalledTimes(2);
});

it('keeps a deletion arriving while the old contents are being read', async () => {
	const reading = createDeferred<ArrayBuffer>();
	h.vault.adapter.readBinary.mockReturnValueOnce(reading.promise);
	touch();
	await startVerification();
	h.engine.onFileDelete({ path } as never);
	reading.resolve(original);
	await h.engine.waitForIdle();
	expect(h.engine.getPendingPaths()).toEqual([`delete:${path}`]);
	expect(h.localManifest.setEntry).not.toHaveBeenCalled();
});

it('keeps an edit arriving while the timestamp checkpoint is being saved', async () => {
	h.localManifest.save.mockImplementationOnce(() => { touch(); });
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
});

it('does not refresh metadata when the file changes during the read without an event', async () => {
	h.vault.adapter.stat.mockResolvedValueOnce(stat).mockResolvedValue({ ...stat, mtime: 3000 });
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expect(h.localManifest.setEntry).not.toHaveBeenCalled();
});

it('does not replace a baseline advanced during verification', async () => {
	const newer = { ...h.localManifest.getEntry(path)!, hash: 'new-baseline', revision: 'new-revision' };
	h.vault.adapter.readBinary = vi.fn(async () => {
		h.localManifest.setEntry(path, newer);
		return original;
	});
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expect(h.localManifest.getEntry(path)).toEqual(newer);
	expect(h.localManifest.save).not.toHaveBeenCalled();
});

it.each(['read', 'save'])('keeps pending entries after a %s failure', async operation => {
	if (operation === 'read') h.vault.adapter.readBinary.mockRejectedValue(new Error('read failed'));
	else h.localManifest.save.mockRejectedValue(new Error('save failed'));
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expectNoTransfers();
});

it('leaves oversized files for ordinary sync error handling', async () => {
	h.vault.adapter.stat.mockResolvedValue({ ...stat, size: MAX_FILE_SIZE_BYTES + 1 });
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expect(h.vault.adapter.readBinary).not.toHaveBeenCalled();
});

it.each(['upload', 'restore'])('preserves pending work when a durable %s still needs reconciliation', async kind => {
	if (kind === 'upload') vi.spyOn(h.localManifest.uploadJournal, 'pending').mockReturnValue([{ path }]);
	else h.api.getPendingRestores.mockReturnValue([{ path }]);
	touch();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expect(h.vault.adapter.readBinary).not.toHaveBeenCalled();
});

it('cancels scheduled verification on unload', async () => {
	touch();
	h.engine.destroy();
	await verify();
	expect(h.vault.adapter.readBinary).not.toHaveBeenCalled();
});

it('ignores a read that finishes after unload', async () => {
	const reading = createDeferred<ArrayBuffer>();
	h.vault.adapter.readBinary.mockReturnValueOnce(reading.promise);
	touch();
	await startVerification();
	h.engine.destroy();
	reading.resolve(original);
	await h.engine.waitForIdle();
	expect(h.localManifest.setEntry).not.toHaveBeenCalled();
	expect(h.localManifest.save).not.toHaveBeenCalled();
});

it('discards an old verification across a manual sync and retries locally afterward', async () => {
	const reading = createDeferred<ArrayBuffer>();
	h.vault.adapter.readBinary.mockReturnValueOnce(reading.promise);
	touch();
	await startVerification();
	spyOnIncrementalSync(h.engine, createSyncResult());
	await h.engine.sync();
	h.localManifest.setEntry.mockClear();
	reading.resolve(original);
	await h.engine.waitForIdle();
	expect(h.engine.getPendingPaths()).toEqual([path]);
	expect(h.localManifest.setEntry).not.toHaveBeenCalled();
	await verify();
	expect(h.engine.getPendingPaths()).toEqual([]);
});


it('clears files created and deleted before their first sync without transfers', async () => {
 touch('temporary.md');
 h.vault.adapter.stat.mockResolvedValue(null);
 h.engine.onFileDelete({ path: 'temporary.md' } as never);
 await verify();
 expect(h.engine.getPendingPaths()).toEqual([]);
 expect(h.localManifest.save).not.toHaveBeenCalled();
 expectNoTransfers();
});

it('keeps deletion of a synced file pending', async () => {
 h.vault.adapter.stat.mockResolvedValue(null);
 h.engine.onFileDelete({ path } as never);
 await verify();
 expect(h.engine.getPendingPaths()).toEqual([`delete:${path}`]);
 expectNoTransfers();
});

it('preserves a file recreated during absent-file verification', async () => {
 h.vault.adapter.stat.mockImplementationOnce(async () => {
  touch('temporary.md');
  return null;
 });
 h.engine.onFileDelete({ path: 'temporary.md' } as never);
 await verify();
 expect(h.engine.getPendingPaths()).toEqual(['temporary.md']);
 expectNoTransfers();
});

it('keeps an untracked deletion when an upload receipt needs recovery', async () => {
 vi.spyOn(h.localManifest.uploadJournal, 'pending').mockReturnValue([{ path: 'temporary.md' }]);
 h.vault.adapter.stat.mockResolvedValue(null);
 h.engine.onFileDelete({ path: 'temporary.md' } as never);
 await verify();
 expect(h.engine.getPendingPaths()).toEqual(['delete:temporary.md']);
 expectNoTransfers();
});
