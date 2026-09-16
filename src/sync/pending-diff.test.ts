import { describe, expect, it, vi } from 'vitest';
import { loadPendingDiff } from './pending-diff';
import type { FileMetadataResponse } from '../protocol/sync-types';
import { computeHash } from './hasher';

vi.mock('obsidian', () => ({ Platform: { isWin: false } }));

function setup(local: string | null = 'new', remote: string | null = 'old', fixturePath = 'note.md') {
    const encode = (text: string) => new TextEncoder().encode(text).buffer;
    const adapter = {
        stat: vi.fn(async () => local === null ? null : { type: 'file' as const, size: encode(local).byteLength, ctime: 0, mtime: 0 }),
        readBinary: vi.fn(async () => encode(local ?? '')),
    };
    const api = {
        getFileMetadata: vi.fn(async (): Promise<FileMetadataResponse> => ({ files: remote === null ? {} : { [fixturePath]: { size: encode(remote).byteLength, hash: 'hash', revision: '1', modified: '' } } })),
        downloadFile: vi.fn(async () => ({ content: encode(remote ?? ''), hash: 'hash', revision: '1', contentType: 'text/plain', size: encode(remote ?? '').byteLength })),
    };
    return { adapter, api, load: (deleted = false, path = fixturePath) => loadPendingDiff(adapter, api, path, deleted) };
}

describe('pending file previews', () => {
    it('recognizes unchanged files using the server hash without downloading them', async () => {
        const h = setup('same', 'same');
        const hash = await computeHash(new TextEncoder().encode('same').buffer);
        h.api.getFileMetadata.mockResolvedValue({ files: { 'note.md': { hash, size: 4, modified: '' } } });
        expect(await h.load()).toMatchObject({ unchanged: true, before: 'same', after: 'same' });
        expect(h.api.downloadFile).not.toHaveBeenCalled();
    });
    it('compares the server copy with local content', async () => {
        const h = setup();
        expect(await h.load()).toEqual({ before: 'old', after: 'new', beforeSize: 3, afterSize: 3, kind: 'modified' });
        expect(h.api.getFileMetadata).toHaveBeenCalledWith(['note.md']);
    });
    it('previews additions without downloading a missing server copy', async () => {
        const h = setup('new', null);
        expect(await h.load()).toMatchObject({ before: '', after: 'new', kind: 'added' });
        expect(h.api.downloadFile).not.toHaveBeenCalled();
    });
    it('previews deletions without trying to read an absent local file', async () => {
        const h = setup(null);
        expect(await h.load(true)).toMatchObject({ before: 'old', after: '', kind: 'deleted' });
        expect(h.adapter.readBinary).not.toHaveBeenCalled();
    });
    it('does not treat a recreated or missing local file as the queued change', async () => {
        await expect(setup().load(true)).rejects.toThrow('file changed');
        await expect(setup(null).load()).rejects.toThrow('file changed');
    });
    it('rejects a server version that changed during loading', async () => {
        const h = setup();
        h.api.downloadFile.mockResolvedValue({ content: new ArrayBuffer(0), hash: 'different', revision: '2', contentType: 'text/plain', size: 0 });
        await expect(h.load()).rejects.toThrow('server copy changed');
    });
    it('propagates network failures instead of showing a new-file diff', async () => {
        const h = setup();
        h.api.getFileMetadata.mockRejectedValue(new Error('Offline'));
        await expect(h.load()).rejects.toThrow('Offline');
    });
    it('skips content reads when metadata exceeds the preview limit', async () => {
        const h = setup('a'.repeat(256_001));
        expect((await h.load()).unavailable).toContain('too large');
        expect(h.adapter.readBinary).not.toHaveBeenCalled();
        expect(h.api.downloadFile).not.toHaveBeenCalled();
    });
    it('shows metadata for binary content', async () => {
        const h = setup('\x00\x01');
        const result = await h.load();
        expect(result.unavailable).toContain('text preview');
        expect(result.afterSize).toBe(2);
    });
    it.each(['document.pdf', 'DOCUMENT.PDF', 'image.png', 'photo.jpeg', 'photo.heic', 'clip.mp4', 'audio.mp3', 'archive.zip', 'document.docx', 'font.woff2'])(
        'skips content access for known binary format %s even if its bytes are valid text', async path => {
            const h = setup('%PDF-1.7\nReadable internals', 'Earlier readable internals', path);
            const result = await h.load();
            expect(result).toMatchObject({ kind: 'modified', beforeSize: 26, afterSize: 27 });
            expect(result.unavailable).toContain('Open it to review');
            expect(result.before).toBeUndefined();
            expect(result.after).toBeUndefined();
            expect(h.adapter.readBinary).not.toHaveBeenCalled();
            expect(h.api.downloadFile).not.toHaveBeenCalled();
        },
    );
    it.each([
        { local: 'new', remote: null, kind: 'added', beforeSize: 0, afterSize: 3 },
        { local: null, remote: 'old', kind: 'deleted', beforeSize: 3, afterSize: 0 },
        { local: 'x'.repeat(256_001), remote: 'old', kind: 'modified', beforeSize: 3, afterSize: 256_001 },
    ])('preserves metadata for $kind binary files', async ({ local, remote, kind, beforeSize, afterSize }) => {
        const h = setup(local, remote, 'image.png');
        const result = await h.load(local === null);
        expect(result).toMatchObject({ kind, beforeSize, afterSize });
        expect(result.unavailable).toContain('text preview');
        expect(h.adapter.readBinary).not.toHaveBeenCalled();
        expect(h.api.downloadFile).not.toHaveBeenCalled();
    });
    it.each(['note.md', '.obsidian/settings.json', 'drawing.svg', 'README', 'notes.custom', 'document.pdf.md', 'pdf/note.txt'])(
        'continues previewing readable text in %s', async path => {
            const h = setup('new', 'old', path);
            expect(await h.load()).toMatchObject({ before: 'old', after: 'new', kind: 'modified' });
        },
    );
    it('rejects paths outside the vault before accessing storage', async () => {
        const h = setup();
        await expect(h.load(false, '../outside')).rejects.toThrow('Invalid sync path');
        expect(h.adapter.stat).not.toHaveBeenCalled();
        expect(h.api.getFileMetadata).not.toHaveBeenCalled();
    });
});
