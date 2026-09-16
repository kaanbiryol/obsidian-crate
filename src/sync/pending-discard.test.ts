import { describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../protocol/sync-types';
import { createPendingDiscard } from './pending-discard';
import { computeHash } from './hasher';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
async function harness(initial: Record<string, ArrayBuffer>, server: Record<string, ArrayBuffer>) {
    const files = new Map(Object.entries(initial));
    const remote = new Map(Object.entries(server));
    const folders = new Set<string>();
    const identities = new Map(Object.keys(initial).map(path => [path, { path, extension: path.split('.').pop() }]));
    const process = vi.fn(async (path: string, update: (text: string) => string) => {
        files.set(path, bytes(update(new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.get(path)))));
    });
    const trash = vi.fn(async (path: string) => { files.set(`.trash/${path}`, files.get(path)!); files.delete(path); });
    const adapter = {
        stat: vi.fn(async (path: string) => files.has(path) ? { type: 'file', size: files.get(path)!.byteLength, mtime: 1, ctime: 1 } : folders.has(path) ? { type: 'folder' } : null),
        exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
        readBinary: vi.fn(async (path: string) => { if (!files.has(path)) throw new Error('Missing file'); return files.get(path)!; }),
        writeBinary: vi.fn(async (path: string, content: ArrayBuffer) => { files.set(path, content); }),
        write: vi.fn(async (path: string, text: string) => { files.set(path, bytes(text)); }),
        mkdir: vi.fn(async (path: string) => { folders.add(path); }),
        process, trashLocal: trash,
    };
    const vault = {
        adapter,
        getAbstractFileByPath: (path: string) => files.has(path) && !path.startsWith('.') ? identities.get(path) ?? null : null,
        createFolder: adapter.mkdir,
        process: (file: { path: string }, update: (text: string) => string) => process(file.path, update),
        createBinary: vi.fn(async (path: string, content: ArrayBuffer) => { if (files.has(path)) throw new Error('File exists'); files.set(path, content); }),
        trash: (file: { path: string }) => trash(file.path),
    };
    const entry = async (path: string): Promise<FileEntry> => ({ hash: await computeHash(remote.get(path)!), revision: 'v1', size: remote.get(path)!.byteLength, modified: '2026-09-16' });
    const api = {
        getFileMetadata: vi.fn(async (paths: string[]): Promise<{ files: Record<string, FileEntry> }> => ({ files: Object.fromEntries(await Promise.all(paths.filter(path => remote.has(path)).map(async path => [path, await entry(path)] as const))) })),
        downloadFile: vi.fn(async (path: string) => ({ ...await entry(path), content: remote.get(path)!, contentType: 'text/plain' })),
    };
    const applied = vi.fn(async () => {});
    const context = { vault: vault as never, api, backupRoot: '.obsidian/plugins/crate/discard-recovery', verify: vi.fn(), beforeBinaryReplace: vi.fn(async () => {}), applied };
    return { files, remote, adapter, vault, api, applied, context, trash };
}

describe('pending discard', () => {
    it('prepares actions without changing files and excludes unchanged content', async () => {
        const h = await harness({ 'new.md': bytes('new'), 'same.md': bytes('same'), 'edit.md': bytes('edit') }, { 'same.md': bytes('same'), 'edit.md': bytes('server'), 'deleted.md': bytes('restore') });
        const review = await createPendingDiscard(h.context, ['new.md', 'same.md', 'edit.md', 'delete:deleted.md']);
        expect(review.items).toEqual([{ path: 'new.md', action: 'trash' }, { path: 'edit.md', action: 'restore' }, { path: 'deleted.md', action: 'restore' }]);
        expect(review.unchangedCount).toBe(1);
        expect(h.adapter.writeBinary).not.toHaveBeenCalled();
        expect(h.trash).not.toHaveBeenCalled();
    });
    it.each(['note.md', '.obsidian/app.json'])('restores %s and keeps an exact recovery copy', async path => {
        const original = bytes('\uFEFFlocal\r\n'), remote = bytes('\uFEFFserver\r\n');
        const h = await harness({ [path]: original }, { [path]: remote });
        const review = await createPendingDiscard(h.context, [path]);
        await review.discard();
        expect(h.files.get(path)).toEqual(remote);
        expect([...h.files.entries()].find(([key]) => key.endsWith('/original'))?.[1]).toEqual(original);
        expect(h.applied).toHaveBeenCalledWith(path, expect.objectContaining({ hash: await computeHash(remote) }), remote);
        await expect(review.discard()).rejects.toThrow('Reopen discard');
    });
    it.each(['note.md', '.obsidian/app.json'])('restores a locally deleted file: %s', async path => {
        const h = await harness({}, { [path]: bytes('server') });
        await (await createPendingDiscard(h.context, [`delete:${path}`])).discard();
        expect(h.files.get(path)).toEqual(bytes('server'));
    });
    it.each(['new.md', '.hidden/new.bin'])('moves a locally added file to trash: %s', async path => {
        const h = await harness({ [path]: bytes('new') }, {});
        await (await createPendingDiscard(h.context, [path])).discard();
        expect(h.files.has(path)).toBe(false);
        expect(h.files.get(`.trash/${path}`)).toEqual(bytes('new'));
        expect(h.applied).toHaveBeenCalledWith(path, undefined, undefined);
    });
    it.each(['image.png', '.hidden/image.png'])('restores binary files with recoverable local bytes: %s', async path => {
        const original = new Uint8Array([0, 255, 1]).buffer;
        const remote = new Uint8Array([1, 255, 0]).buffer;
        const h = await harness({ [path]: original }, { [path]: remote });
        await (await createPendingDiscard(h.context, [path])).discard();
        expect(h.files.get(path)).toEqual(remote);
        expect(h.files.get(`.trash/${path}`)).toEqual(original);
    });
    it.each(['local', 'remote'])('refuses stale %s versions before changing any selected file', async side => {
        const h = await harness({ 'a.md': bytes('a'), 'b.md': bytes('b') }, { 'a.md': bytes('server a'), 'b.md': bytes('server b') });
        const review = await createPendingDiscard(h.context, ['a.md', 'b.md']);
        (side === 'local' ? h.files : h.remote).set('b.md', bytes('new edit'));
        await expect(review.discard()).rejects.toThrow('b.md changed');
        expect(h.files.get('a.md')).toEqual(bytes('a'));
        expect(h.applied).not.toHaveBeenCalled();
    });
    it('keeps a local edit arriving at the atomic write', async () => {
        const h = await harness({ '.obsidian/app.json': bytes('old') }, { '.obsidian/app.json': bytes('server') });
        const review = await createPendingDiscard(h.context, ['.obsidian/app.json']);
        h.adapter.process.mockImplementationOnce(async (path, update) => { h.files.set(path, bytes('late edit')); update('late edit'); });
        await expect(review.discard()).rejects.toThrow('changed');
        expect(h.files.get('.obsidian/app.json')).toEqual(bytes('late edit'));
        expect(h.applied).not.toHaveBeenCalled();
    });
    it('keeps originals when a recovery write fails', async () => {
        const h = await harness({ 'note.md': bytes('local') }, { 'note.md': bytes('server') });
        h.adapter.writeBinary.mockRejectedValueOnce(new Error('Disk full'));
        await expect((await createPendingDiscard(h.context, ['note.md'])).discard()).rejects.toThrow('Disk full');
        expect(h.files.get('note.md')).toEqual(bytes('local'));
        expect(h.applied).not.toHaveBeenCalled();
    });
    it('does not trash a binary file if its recovery checkpoint cannot be saved', async () => {
        const h = await harness({ 'image.png': bytes('local') }, { 'image.png': bytes('server') });
        h.context.beforeBinaryReplace.mockRejectedValueOnce(new Error('Checkpoint failed'));
        await expect((await createPendingDiscard(h.context, ['image.png'])).discard()).rejects.toThrow('Checkpoint failed');
        expect(h.files.get('image.png')).toEqual(bytes('local'));
        expect(h.trash).not.toHaveBeenCalled();
    });
    it('reports a partial failure without repeating completed files', async () => {
        const h = await harness({ 'a.md': bytes('a'), 'b.md': bytes('b') }, { 'a.md': bytes('server a'), 'b.md': bytes('server b') });
        const review = await createPendingDiscard(h.context, ['a.md', 'b.md']);
        const originalDownload = h.api.downloadFile.getMockImplementation()!;
        h.api.downloadFile.mockImplementation(async path => {
            if (path === 'b.md') throw new Error('Offline');
            return originalDownload(path);
        });
        await expect(review.discard()).rejects.toThrow('Offline');
        expect(h.files.get('a.md')).toEqual(bytes('server a'));
        expect(h.files.get('b.md')).toEqual(bytes('b'));
        expect(h.applied).toHaveBeenCalledTimes(1);
        expect((await createPendingDiscard(h.context, ['a.md', 'b.md'])).items).toEqual([{ path: 'b.md', action: 'restore' }]);
    });
    it('refuses a download whose bytes differ from its declared hash', async () => {
        const h = await harness({ 'note.md': bytes('local') }, { 'note.md': bytes('server') });
        const response = await h.api.downloadFile('note.md');
        h.api.downloadFile.mockResolvedValueOnce({ ...response, content: bytes('broken') });
        await expect((await createPendingDiscard(h.context, ['note.md'])).discard()).rejects.toThrow('hash mismatch');
        expect(h.files.get('note.md')).toEqual(bytes('local'));
    });
});
