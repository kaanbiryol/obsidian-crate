import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({ Platform: { isWin: false, isDesktopApp: false }, FileSystemAdapter: class {}, TFile: class { constructor(public path: string, public extension = 'md') {} } }));
import { TFile } from 'obsidian';
import { createConflictReview } from './conflict-review';
import type { ConflictRecord } from './types';

function fixture(hidden = false) {
    const original = Object.assign(new TFile(), { path: hidden ? '.obsidian/daily-notes.json' : 'Note.md', extension: hidden ? 'json' : 'md' });
    const saved = Object.assign(new TFile(), { path: hidden ? '.obsidian/daily-notes (conflict).json' : 'Note (conflict).md', extension: hidden ? 'json' : 'md' });
    const encode = (text: string) => new TextEncoder().encode(text).buffer;
    const files = new Map<string, ArrayBuffer>([[original.path, encode('Current')], [saved.path, encode('Saved')]]);
    const resolved = vi.fn(async () => {});
    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => !hidden && files.has(path) ? path === original.path ? original : saved : null,
            readBinary: async (file: TFile) => files.get(file.path)!,
            process: async (file: TFile, fn: (value: string) => string) => { files.set(file.path, encode(fn(new TextDecoder().decode(files.get(file.path))))); },
            modifyBinary: async (file: TFile, bytes: ArrayBuffer) => { files.set(file.path, bytes); },
            createBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => { if (files.has(path)) throw new Error('Exists'); files.set(path, bytes); }),
            adapter: {
                exists: async (path: string) => files.has(path), mkdir: async () => {},
                stat: async (path: string) => files.has(path) ? { type: 'file', size: files.get(path)!.byteLength } : null,
                process: vi.fn(async (path: string, update: (current: string) => string) => { files.set(path, encode(update(new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.get(path))))); }),
                trashLocal: vi.fn(async (path: string) => { files.delete(path); }),
                writeBinary: async (path: string, bytes: ArrayBuffer) => { files.set(path, bytes); },
                readBinary: async (path: string) => files.get(path)!, write: async () => {},
            },
        },
        fileManager: { trashFile: vi.fn(async (file: TFile) => { files.delete(file.path); }) },
        workspace: { getLeaf: () => ({ openFile: async () => {} }) },
    };
    const record: ConflictRecord = { originalPath: original.path, conflictPath: saved.path, createdAt: '', cause: 'concurrent-edit', status: 'active' };
    return { app, files, resolved, record, encode, open: () => createConflictReview(app as never, '.obsidian/plugins/crate', record, () => false, resolved) };
}

describe('conflict review resolution', () => {
    it.each(['current', 'saved', 'manual', 'both'] as const)('backs up both versions before resolving with %s', async choice => {
        const h = fixture();
        const review = await h.open();
        const folder = await review.resolve(choice, 'Combined');
        expect(new TextDecoder().decode(h.files.get(`${folder}/current`))).toBe('Current');
        expect(new TextDecoder().decode(h.files.get(`${folder}/saved`))).toBe('Saved');
        expect(new TextDecoder().decode(h.files.get('Note.md'))).toBe(choice === 'manual' ? 'Combined' : choice === 'saved' ? 'Saved' : 'Current');
        expect(h.files.has(h.record.conflictPath)).toBe(false);
        expect(h.resolved).toHaveBeenCalledOnce();
        if (choice === 'both') expect(h.app.vault.createBinary).toHaveBeenCalledOnce();
    });
    it('refuses changed files without replacing or trashing them', async () => {
        const h = fixture(), review = await h.open();
        h.files.set('Note.md', h.encode('New edit'));
        await expect(review.resolve('saved')).rejects.toThrow('changed');
        expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(h.resolved).not.toHaveBeenCalled();
    });
    it('leaves the conflict unresolved if recovery copies cannot be verified', async () => {
        const h = fixture(), review = await h.open();
        h.app.vault.adapter.readBinary = async () => h.encode('Corrupt');
        await expect(review.resolve('saved')).rejects.toThrow('verify recovery');
        expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(h.resolved).not.toHaveBeenCalled();
    });
});


describe('hidden configuration conflict review', () => {
    it.each(['current', 'saved', 'manual', 'both'] as const)('previews and safely resolves unindexed JSON with %s', async choice => {
        const h = fixture(true);
        const current = '{"folder":"Daily"}', saved = '{"folder":"Journal"}', combined = '{"folder":"Combined"}';
        h.files.set(h.record.originalPath, h.encode(current));
        h.files.set(h.record.conflictPath, h.encode(saved));
        const review = await h.open();
        expect(review.currentText).toBe(current);
        expect(review.savedText).toBe(saved);
        const folder = await review.resolve(choice, combined);
        const read = (path: string) => new TextDecoder().decode(h.files.get(path));
        expect(read(`${folder}/current`)).toBe(current);
        expect(read(`${folder}/saved`)).toBe(saved);
        expect(read(h.record.originalPath)).toBe(choice === 'saved' ? saved : choice === 'manual' ? combined : current);
        expect(h.files.has(h.record.conflictPath)).toBe(false);
        expect(h.app.vault.adapter.trashLocal).toHaveBeenCalledWith(h.record.conflictPath);
        expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
        expect(h.resolved).toHaveBeenCalledOnce();
        if (choice === 'both') {
            const kept = [...h.files.keys()].find(path => path.startsWith('.obsidian/daily-notes (saved copy '));
            expect(kept).toBeDefined();
            expect(read(kept!)).toBe(saved);
        }
    });

    it.each(['originalPath', 'conflictPath'] as const)('preserves changes made during review to %s', async key => {
        const h = fixture(true), review = await h.open();
        h.files.set(h.record[key], h.encode('New edit'));
        await expect(review.resolve('saved')).rejects.toThrow('changed');
        expect(h.app.vault.adapter.trashLocal).not.toHaveBeenCalled();
        expect(h.resolved).not.toHaveBeenCalled();
    });

    it('checks for concurrent configuration changes inside the atomic write', async () => {
        const h = fixture(true), review = await h.open();
        h.app.vault.adapter.process.mockImplementation(async (path, update) => {
            h.files.set(path, h.encode('Concurrent edit'));
            h.files.set(path, h.encode(update('Concurrent edit')));
        });
        await expect(review.resolve('saved')).rejects.toThrow('changed');
        expect(new TextDecoder().decode(h.files.get(h.record.originalPath))).toBe('Concurrent edit');
        expect(h.app.vault.adapter.trashLocal).not.toHaveBeenCalled();
    });

    it.each(['originalPath', 'conflictPath'] as const)('reports a genuinely missing %s', async key => {
        const h = fixture(true);
        h.files.delete(h.record[key]);
        await expect(h.open()).rejects.toThrow('File unavailable');
    });

    it('preserves UTF-8 BOM bytes when choosing saved text', async () => {
        const h = fixture(true);
        h.files.set(h.record.originalPath, h.encode('\uFEFF{"folder":"Daily"}'));
        h.files.set(h.record.conflictPath, h.encode('\uFEFF{"folder":"Journal"}'));
        const review = await h.open();
        await review.resolve('saved');
        expect(h.files.get(h.record.originalPath)).toEqual(h.encode('\uFEFF{"folder":"Journal"}'));
    });

    it('does not decode invalid UTF-8 as editable configuration', async () => {
        const h = fixture(true);
        h.files.set(h.record.conflictPath, new Uint8Array([255, 0, 1]).buffer);
        const review = await h.open();
        expect(review.currentText).toBeUndefined();
        expect(review.savedText).toBeUndefined();
        await review.resolve('saved');
        expect(h.files.get(h.record.originalPath)).toEqual(new Uint8Array([255, 0, 1]).buffer);
    });

    it('does not claim hidden files can be opened as an Obsidian note on mobile', async () => {
        const h = fixture(true), review = await h.open();
        await expect(review.openVersion('current')).rejects.toThrow('Use the comparison below');
    });
});
