import { describe, expect, it, vi } from 'vitest';
import { createHarness, getPendingPaths, setSyncStatus, toArrayBuffer } from './engine-test-harness';
import { computeHash } from './hasher';

async function harness() {
    const h = createHarness({ automaticSync: false, lastSeq: 42 });
    const content = toArrayBuffer('local');
    const hash = await computeHash(content);
    h.vault.adapter.readBinary.mockResolvedValue(content);
    h.vault.getAbstractFileByPath.mockImplementation((path: string) => ({ path, extension: 'md', stat: { size: content.byteLength, mtime: 1 } }));
    const api = Object.assign(h.api, { getFileMetadata: vi.fn(async (paths: string[]) => ({ files: Object.fromEntries(paths.map(path => [path, { hash, revision: 'v1', size: content.byteLength, modified: 'now' }])) })) });
    getPendingPaths(h.engine).add('a.md'); getPendingPaths(h.engine).add('b.md');
    return { ...h, api };
}

describe('selected sync', () => {
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
        getPendingPaths(h.engine).delete('a.md'); getPendingPaths(h.engine).add('delete:a.md');
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
        const h = await harness(); setSyncStatus(h.engine, 'syncing');
        await expect(h.engine.syncSelected(['a.md'])).rejects.toThrow('current sync');
        expect(h.api.getFileMetadata).not.toHaveBeenCalled();
        h.engine.destroy();
    });
});
