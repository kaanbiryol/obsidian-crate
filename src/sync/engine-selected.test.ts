import { describe, expect, it, vi } from 'vitest';
import { createHarness, toArrayBuffer } from './engine-test-harness';
import { computeHash } from './hasher';
import { formatSyncProgress } from '../ui/activity/progress-label';

async function harness() {
    const h = createHarness({ automaticSync: false, lastSeq: 42 });
    const content = toArrayBuffer('local');
    const hash = await computeHash(content);
    h.vault.adapter.readBinary.mockResolvedValue(content);
    h.vault.getAbstractFileByPath.mockImplementation((path: string) => ({ path, extension: 'md', stat: { size: content.byteLength, mtime: 1 } }));
    const api = Object.assign(h.api, { getFileMetadata: vi.fn(async (paths: string[]) => ({ files: Object.fromEntries(paths.map(path => [path, { hash, revision: 'v1', size: content.byteLength, modified: 'now' }])) })) });
    h.engine.onFileChange({ path: 'a.md' } as never);
    h.engine.onFileChange({ path: 'b.md' } as never);
    return { ...h, api };
}

describe('selected sync', () => {
    it('shows checking, per-file progress, and saving during selected uploads', async () => {
        const h = await harness();
        const labels: string[] = [];
        h.engine.setStateChangeCallback(state => labels.push(formatSyncProgress(null, state.work)));
        h.api.getFileMetadata.mockImplementation(async () => {
            expect(labels.at(-1)).toBe('Checking for changes…');
            return { files: {} };
        });
        const batchUpload = vi.fn(async (files: Array<{ path: string; hash: string }>) => {
            expect(labels.at(-1)).toBe('Uploading 0 of 2 files');
            return { success: true, results: files.map(file => ({ ...file, success: true })) };
        });
        Object.assign(h.api, { batchUpload });
        h.localManifest.save.mockImplementation(() => {
            expect(labels.at(-1)).toBe('Saving sync progress…');
        });

        const result = await h.engine.syncSelected(['a.md', 'b.md']);

        expect(result.success).toBe(true);
        expect(result.uploadedPaths).toEqual(['a.md', 'b.md']);
        expect(h.api.batchUpload).toHaveBeenCalledTimes(1);
        expect(h.api.uploadFile).not.toHaveBeenCalled();
        expect(labels).toContain('Uploading 2 of 2 files');
        expect(labels).toContain('Applying changes: 2/2');
        expect(h.engine.getState()).toMatchObject({ status: 'idle', work: undefined });
        h.engine.destroy();
    });
    it('settles only selected touched files and preserves the global server cursor', async () => {
        const h = await harness();
        const result = await h.engine.syncSelected(['a.md']);
        expect(result.success).toBe(true);
        expect(result.settledPaths).toEqual(['a.md']);
        expect(h.api.getFileMetadata).toHaveBeenCalledWith(['a.md']);
        expect(h.api.getManifest).not.toHaveBeenCalled();
        expect(h.api.recoverUploads).not.toHaveBeenCalled();
        expect(h.engine.getPendingPaths()).toEqual(['b.md']);
        expect(h.settings.lastSeq).toBe(42);
        h.engine.destroy();
    });
    it('uploads only a selected file', async () => {
        const h = await harness();
        h.api.getFileMetadata.mockResolvedValue({ files: {} });
        h.api.uploadFile.mockResolvedValue({ path: 'a.md', success: true });
        const result = await h.engine.syncSelected(['a.md']);
        expect(result.success).toBe(true);
        expect(result.uploadedPaths).toEqual(['a.md']);
        expect(h.engine.getPendingPaths()).toEqual(['b.md']);
        h.engine.destroy();
    });
    it('syncs a selected deletion without touching other pending files', async () => {
        const h = await harness();
        const entry = (await h.api.getFileMetadata(['a.md'])).files['a.md']!;
        h.localManifest.setEntry('a.md', entry);
        h.vault.getAbstractFileByPath.mockImplementation((path: string) => path === 'a.md' ? null
            : { path, extension: 'md', stat: { size: entry.size, mtime: 1 } });
        h.api.deleteFile.mockResolvedValue({ path: 'a.md', success: true });
        h.engine.onFileDelete({ path: 'a.md' } as never);
        const result = await h.engine.syncSelected(['delete:a.md']);
        expect(result.success).toBe(true);
        expect(result.deletedPaths).toEqual(['a.md']);
        expect(h.engine.getPendingPaths()).toEqual(['b.md']);
        h.engine.destroy();
    });
    it('retains an edit queued while its selected sync is running', async () => {
        const h = await harness();
        const metadata = h.api.getFileMetadata.getMockImplementation()!;
        h.api.getFileMetadata.mockImplementation(async paths => {
            h.engine.onFileChange({ path: 'a.md' } as never);
            return metadata(paths);
        });
        expect((await h.engine.syncSelected(['a.md'])).success).toBe(true);
        expect(h.engine.getPendingPaths()).toEqual(['a.md', 'b.md']);
        h.engine.destroy();
    });
    it('does not recover unselected journal uploads as a side effect', async () => {
        const h = await harness();
        vi.spyOn(h.localManifest.uploadJournal, 'pending').mockReturnValue([{ path: 'b.md' }]);
        await expect(h.engine.syncSelected(['a.md'])).rejects.toThrow('recover interrupted uploads');
        expect(h.api.recoverUploads).not.toHaveBeenCalled();
        expect(h.api.getFileMetadata).not.toHaveBeenCalled();
        h.engine.destroy();
    });
    it.each([{ keys: [] }, { keys: ['unknown.md'] }])('rejects an empty or stale selection: %j', async ({ keys }) => {
        const h = await harness();
        await expect(h.engine.syncSelected(keys)).rejects.toThrow('Pending files changed');
        expect(h.api.getFileMetadata).not.toHaveBeenCalled();
        expect(h.engine.getPendingPaths()).toEqual(['a.md', 'b.md']);
        h.engine.destroy();
    });
    it('refuses to start while another sync is running', async () => {
        const h = await harness();
        let finish!: () => void;
        const blocked = new Promise<void>(resolve => { finish = resolve; });
        h.api.getFileMetadata.mockImplementation(async () => { await blocked; return { files: {} }; });
        const running = h.engine.syncSelected(['b.md']);
        await vi.waitFor(() => expect(h.api.getFileMetadata).toHaveBeenCalledWith(['b.md']));
        await expect(h.engine.syncSelected(['a.md'])).rejects.toThrow('current sync');
        expect(h.api.getFileMetadata).toHaveBeenCalledTimes(1);
        finish();
        expect((await running).success).toBe(true);
        h.engine.destroy();
    });
});
