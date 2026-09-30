import { expect, it, vi } from 'vitest';
import type { FileEntry } from '../protocol/sync-types';
import { createHarness, getPendingPaths, toArrayBuffer } from './engine-test-harness';
import { computeHash } from './hasher';

const path = '.obsidian/plugins/obsidian-minimal-settings/data.json';

async function setup(saved = '{"theme":"saved"}', local: string | null = '{"theme":"local"}') {
    const h = createHarness();
    const base = toArrayBuffer(saved);
    const baseline = { hash: await computeHash(base), size: base.byteLength, modified: '', revision: 'last-synced-revision' };
    const key = local === null ? `delete:${path}` : path;
    const files = new Map<string, ArrayBuffer>(local === null ? [] : [[path, toArrayBuffer(local)]]);
    const folders = new Set<string>();
    h.localManifest.setEntry(path, baseline);
    getPendingPaths(h.engine).add(key);
    h.vault.getAbstractFileByPath.mockReturnValue(null);
    h.vault.adapter.exists.mockImplementation((target: string) => files.has(target) || folders.has(target));
    h.vault.adapter.stat.mockImplementation(async target => files.has(target) ? { type: 'file', size: files.get(target)!.byteLength, mtime: 1 } : null);
    h.vault.adapter.readBinary = vi.fn(async (target: string) => {
        const bytes = files.get(target);
        if (!bytes) throw new Error('Missing file');
        return bytes;
    });
    h.vault.adapter.writeBinary.mockImplementation((target: string, content: ArrayBuffer) => { files.set(target, content); });
    h.vault.adapter.mkdir.mockImplementation((target: string) => { folders.add(target); });
    const process = vi.fn(async (target: string, update: (current: string) => string) => {
        files.set(target, toArrayBuffer(update(new TextDecoder().decode(files.get(target)))));
    });
    Object.assign(h.vault.adapter, { process });
    h.vault.createBinary.mockImplementation((target: string, content: ArrayBuffer) => {
        if (files.has(target)) throw new Error('File exists');
        files.set(target, content);
    });
    const version = { ...baseline, path, storage_key: 'retained', created_at: '2026-09-30T10:00:00Z', expires_at: 1, reason: 'replaced' as const };
    const remote = {
        getFileMetadata: vi.fn(async (): Promise<{ files: Record<string, FileEntry> }> => ({ files: { [path]: baseline } })),
        listFileVersions: vi.fn(async () => ({ versions: [version], hasMore: false })),
        previewFileVersion: vi.fn(async () => base),
        downloadFile: vi.fn(async () => ({ content: base })),
    };
    Object.assign(h.api, remote);
    h.localManifest.setEntry.mockClear();
    return { ...h, files, base, baseline, key, remote, process };
}

it.each(['current', 'retained'])('discards uncached JSON against the %s last-synced copy and preserves recovery bytes', async source => {
    const h = await setup();
    const original = h.files.get(path);
    if (source === 'retained') h.remote.getFileMetadata.mockResolvedValue({ files: { [path]: { ...h.baseline, hash: 'newer-server-version' } } });
    const review = await h.engine.createPendingDiscard([h.key]);
    expect(review.items).toEqual([{ path, action: 'restore' }]);
    expect(h.files.get(path)).toEqual(original);
    expect(h.localManifest.setEntry).not.toHaveBeenCalled();
    await review.discard();
    expect(h.files.get(path)).toEqual(h.base);
    expect([...h.files.entries()].find(([name]) => name.endsWith('/original'))?.[1]).toEqual(original);
    expect(h.localManifest.getEntry(path)).toMatchObject({ hash: h.baseline.hash, revision: h.baseline.revision });
    expect(h.engine.getPendingPaths()).not.toContain(h.key);
    expect(h.api.uploadFile).not.toHaveBeenCalled();
    expect(h.api.getChanges).not.toHaveBeenCalled();
    if (source === 'retained') {
        expect(h.remote.previewFileVersion).toHaveBeenCalledTimes(2);
        expect(h.remote.downloadFile).not.toHaveBeenCalled();
    }
});

it('restores a locally deleted JSON file from its verified server copy', async () => {
    const h = await setup('{"theme":"saved"}', null);
    await (await h.engine.createPendingDiscard([h.key])).discard();
    expect(h.files.get(path)).toEqual(h.base);
    expect(h.engine.getPendingPaths()).not.toContain(h.key);
});

it('does not apply the text preview limit to discarding a current server file', async () => {
    const h = await setup(JSON.stringify({ text: 'a'.repeat(256_001) }));
    await (await h.engine.createPendingDiscard([h.key])).discard();
    expect(h.files.get(path)).toEqual(h.base);
});

it.each(['offline', 'corrupt', 'expired'])('keeps local JSON and its pending change when its baseline is %s', async failure => {
    const h = await setup();
    const original = h.files.get(path);
    if (failure === 'offline') h.remote.getFileMetadata.mockRejectedValue(new Error('Offline'));
    if (failure === 'corrupt') h.remote.downloadFile.mockResolvedValue({ content: toArrayBuffer('wrong bytes') });
    if (failure === 'expired') {
        h.remote.getFileMetadata.mockResolvedValue({ files: {} });
        h.remote.listFileVersions.mockResolvedValue({ versions: [], hasMore: false });
    }
    await expect(h.engine.createPendingDiscard([h.key])).rejects.toThrow();
    expect(h.files.get(path)).toEqual(original);
    expect(h.engine.getPendingPaths()).toContain(h.key);
    expect(h.process).not.toHaveBeenCalled();
    expect(h.vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(h.localManifest.setEntry).not.toHaveBeenCalled();
});

it('keeps an edit made while downloading the confirmed replacement', async () => {
    const h = await setup();
    const review = await h.engine.createPendingDiscard([h.key]);
    h.remote.downloadFile.mockImplementation(async () => {
        h.files.set(path, toArrayBuffer('new edit while downloading'));
        return { content: h.base };
    });
    await expect(review.discard()).rejects.toThrow('changed');
    expect(h.files.get(path)).toEqual(toArrayBuffer('new edit while downloading'));
    expect(h.engine.getPendingPaths()).toContain(h.key);
    expect(h.process).not.toHaveBeenCalled();
});

it('rejects changed server bytes after confirmation without overwriting the local file', async () => {
    const h = await setup();
    const original = h.files.get(path);
    const review = await h.engine.createPendingDiscard([h.key]);
    h.remote.downloadFile.mockResolvedValue({ content: toArrayBuffer('different server version') });
    await expect(review.discard()).rejects.toThrow('could not be verified');
    expect(h.files.get(path)).toEqual(original);
    expect(h.engine.getPendingPaths()).toContain(h.key);
    expect(h.process).not.toHaveBeenCalled();
    expect(h.vault.adapter.writeBinary).not.toHaveBeenCalled();
});
