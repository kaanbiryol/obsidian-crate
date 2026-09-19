import { describe, expect, it, vi } from 'vitest';
import { loadPendingDiff } from './pending-diff';
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
