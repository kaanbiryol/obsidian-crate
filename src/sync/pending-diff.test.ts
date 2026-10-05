import { describe, expect, it, vi } from 'vitest';
import { loadPendingDiff } from './pending-diff';
import { loadRemotePendingBase } from './pending-baseline';
import type { FileEntry } from '../protocol/sync-types';
import { computeHash } from './hasher';

vi.mock('obsidian', () => ({ Platform: { isWin: false } }));

function setup(local: string | null = 'new', remote: string | null = 'old', fixturePath = 'note.md') {
    const encode = (text: string) => new TextEncoder().encode(text).buffer;
    const adapter = {
        stat: vi.fn(async () => local === null ? null : { type: 'file' as const, size: encode(local).byteLength, ctime: 0, mtime: 0 }),
        readBinary: vi.fn(async () => encode(local ?? '')),
    };
    const baseline: FileEntry | undefined = remote === null ? undefined : { size: encode(remote).byteLength, hash: 'hash', modified: '' };
    const readBase = vi.fn(async (): Promise<ArrayBuffer | null> => encode(remote ?? ''));
    return { adapter, baseline, readBase, load: (deleted = false, path = fixturePath) => loadPendingDiff(adapter, baseline, readBase, path, deleted) };
}

describe('pending file previews', () => {
    it('recognizes unchanged files using the last-synced hash without reading the base cache', async () => {
        const h = setup('same', 'same');
        const hash = await computeHash(new TextEncoder().encode('same').buffer);
        h.baseline!.hash = hash;
        expect(await h.load()).toMatchObject({ unchanged: true, before: 'same', after: 'same' });
        expect(h.readBase).not.toHaveBeenCalled();
    });
    it('compares the cached last-synced copy with local content', async () => {
        const h = setup();
        expect(await h.load()).toEqual({ before: 'old', after: 'new', beforeSize: 3, afterSize: 3, kind: 'modified' });
        expect(h.readBase).toHaveBeenCalledWith('note.md', 'hash');
    });
    it('preserves BOMs in both sides of a pending diff', async () => {
        expect(await setup('\uFEFFnew', '\uFEFFold').load()).toMatchObject({ before: '\uFEFFold', after: '\uFEFFnew' });
    });
    it('does not substitute replacement characters for invalid UTF-8 bytes', async () => {
        const h = setup();
        h.adapter.readBinary.mockResolvedValue(new Uint8Array([0xff]).buffer);
        const result = await h.load();
        expect(result.unavailable).toContain('text preview');
        expect(result.before).toBeUndefined();
        expect(result.after).toBeUndefined();
    });
    it('previews additions without a baseline', async () => {
        const h = setup('new', null);
        expect(await h.load()).toMatchObject({ before: '', after: 'new', kind: 'added' });
        expect(h.readBase).not.toHaveBeenCalled();
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
    it('reports a missing cached baseline without treating an existing file as new', async () => {
        const h = setup();
        h.readBase.mockResolvedValue(null);
        expect(await h.load()).toMatchObject({ kind: 'modified', baselineUnavailable: true });
        expect((await h.load()).before).toBeUndefined();
    });
    it('reports unavailable deleted contents when no baseline exists', async () => {
        const h = setup(null, null);
        expect(await h.load(true)).toMatchObject({ kind: 'deleted', baselineUnavailable: true });
        expect(h.readBase).not.toHaveBeenCalled();
    });
    it('skips content reads when metadata exceeds the preview limit', async () => {
        const h = setup('a'.repeat(256_001));
        expect((await h.load()).unavailable).toContain('too large');
        expect(h.adapter.readBinary).not.toHaveBeenCalled();
        expect(h.readBase).not.toHaveBeenCalled();
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
            expect(h.readBase).not.toHaveBeenCalled();
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
        expect(h.readBase).not.toHaveBeenCalled();
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
        expect(h.readBase).not.toHaveBeenCalled();
    });
});

describe('remote pending comparison baselines', () => {
    async function remoteSetup() {
        const content = new TextEncoder().encode('{"theme":"old"}').buffer;
        const baseline = { hash: await computeHash(content), size: content.byteLength, modified: '' };
        const path = '.obsidian/plugins/obsidian-minimal-settings/data.json';
        const version = { ...baseline, path, storage_key: 'retained', created_at: '2026-09-30T10:00:00Z', expires_at: 1, reason: 'replaced' as const };
        const api = {
            getFileMetadata: vi.fn(async (): Promise<{ files: Record<string, FileEntry> }> => ({ files: { [path]: baseline } })),
            downloadFile: vi.fn(async () => ({ content, contentType: 'application/json', size: content.byteLength, hash: baseline.hash })),
            listFileVersions: vi.fn(async () => ({ versions: [version], hasMore: false, nextCursor: undefined as string | undefined })),
            previewFileVersion: vi.fn(async () => content),
        };
        return { api, content, baseline, path, version, load: () => loadRemotePendingBase(api, path, baseline, 256_000) };
    }

    it('uses the current server copy when its contents still match the last sync', async () => {
        const h = await remoteSetup();
        expect(await h.load()).toEqual(h.content);
        expect(h.api.downloadFile).toHaveBeenCalledWith(h.path);
        expect(h.api.listFileVersions).not.toHaveBeenCalled();
    });

    it.each(['changed', 'deleted'])('finds the exact retained contents after the server file was %s', async state => {
        const h = await remoteSetup();
        h.api.getFileMetadata.mockResolvedValue({ files: state === 'deleted' ? {} : { [h.path]: { ...h.baseline, hash: 'new hash' } } });
        h.api.listFileVersions.mockResolvedValueOnce({ versions: [{ ...h.version, hash: 'different' }], hasMore: true, nextCursor: 'older' });
        expect(await h.load()).toEqual(h.content);
        expect(h.api.listFileVersions).toHaveBeenNthCalledWith(2, { path: h.path, cursor: 'older' });
        expect(h.api.previewFileVersion).toHaveBeenCalledWith(h.version);
        expect(h.api.downloadFile).not.toHaveBeenCalled();
    });

    it('does not compare a newer server file when the last-synced version has expired', async () => {
        const h = await remoteSetup();
        h.api.getFileMetadata.mockResolvedValue({ files: {} });
        h.api.listFileVersions.mockResolvedValue({ versions: [], hasMore: false, nextCursor: undefined });
        await expect(h.load()).rejects.toThrow('no longer available');
        expect(h.api.downloadFile).not.toHaveBeenCalled();
        expect(h.api.previewFileVersion).not.toHaveBeenCalled();
    });

    it.each(['current', 'retained'])('verifies actual %s bytes instead of trusting metadata', async source => {
        const h = await remoteSetup();
        const corrupt = new TextEncoder().encode('{"theme":"new"}').buffer;
        if (source === 'retained') h.api.getFileMetadata.mockResolvedValue({ files: {} });
        h.api.downloadFile.mockResolvedValue({ content: corrupt, contentType: 'application/json', size: h.baseline.size, hash: h.baseline.hash });
        h.api.previewFileVersion.mockResolvedValue(corrupt);
        await expect(h.load()).rejects.toThrow('could not be verified');
    });

    it('rejects oversized current metadata before downloading contents', async () => {
        const h = await remoteSetup();
        h.api.getFileMetadata.mockResolvedValue({ files: { [h.path]: { ...h.baseline, size: 256_001 } } });
        await expect(h.load()).rejects.toThrow('could not be verified');
        expect(h.api.downloadFile).not.toHaveBeenCalled();
    });
});
