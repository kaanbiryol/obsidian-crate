import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', () => ({ TFile: class { constructor(public path: string, public extension = 'md') {} } }));
import { TFile } from 'obsidian';
import { createConflictReview } from './conflict-review';
import type { ConflictRecord } from './types';

function fixture() {
    const original = Object.assign(new TFile(), { path: 'Note.md', extension: 'md' });
    const saved = Object.assign(new TFile(), { path: 'Note (conflict).md', extension: 'md' });
    const encode = (text: string) => new TextEncoder().encode(text).buffer;
    const files = new Map<string, ArrayBuffer>([[original.path, encode('Current')], [saved.path, encode('Saved')]]);
    const resolved = vi.fn(async () => {});
    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => files.has(path) ? path === original.path ? original : saved : null,
            readBinary: async (file: TFile) => files.get(file.path)!,
            process: async (file: TFile, fn: (value: string) => string) => { files.set(file.path, encode(fn(new TextDecoder().decode(files.get(file.path))))); },
            modifyBinary: async (file: TFile, bytes: ArrayBuffer) => { files.set(file.path, bytes); },
            createBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => { if (files.has(path)) throw new Error('Exists'); files.set(path, bytes); }),
            adapter: {
                exists: async (path: string) => files.has(path), mkdir: async () => {},
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
