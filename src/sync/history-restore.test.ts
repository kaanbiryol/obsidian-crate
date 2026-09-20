import { describe, expect, it, vi } from 'vitest';
import type { FileEntry, RemoteFileVersion } from '../protocol/sync-types';
import { createHistoryRestore } from './history-restore';
import { HistoryCheckpoints } from './history-checkpoint';
import { computeHash } from './hasher';

vi.mock('./file-discovery', async importOriginal => ({
    ...await importOriginal<typeof import('./file-discovery')>(),
    getAllVaultFiles: async (vault: { getFiles(): Array<{ path: string }> }, ignore: (path: string) => boolean) => vault.getFiles().filter(file => !ignore(file.path)),
}));
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
async function metadata(source: Record<string, string>): Promise<Record<string, FileEntry>> {
    return Object.fromEntries(await Promise.all(Object.entries(source).map(async ([path, text]) => [path,
        { hash: await computeHash(bytes(text)), revision: `revision-${text}`, size: bytes(text).byteLength, modified: '2026-09-20' }] as const)));
}
async function harness(initial: Record<string, string>, historical: Record<string, string>, server = initial) {
    const files = new Map(Object.entries(initial).map(([path, text]) => [path, bytes(text)]));
    const folders = new Set<string>();
    const identities = new Map(Object.keys(initial).map(path => [path, { path, extension: path.split('.').at(-1) }]));
    const process = vi.fn(async (path: string, update: (text: string) => string) => { files.set(path, bytes(update(new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.get(path))))); });
    const trash = vi.fn(async (path: string) => { files.set(`.trash/${path}`, files.get(path)!); files.delete(path); });
    const adapter = {
        stat: vi.fn(async (path: string) => files.has(path) ? { type: 'file', size: files.get(path)!.byteLength, mtime: 1, ctime: 1 } : folders.has(path) ? { type: 'folder' } : null),
        exists: vi.fn(async (path: string) => files.has(path) || folders.has(path)),
        readBinary: vi.fn(async (path: string) => { if (!files.has(path)) throw new Error(`Missing ${path}`); return files.get(path)!; }),
        read: vi.fn(async (path: string) => new TextDecoder().decode(files.get(path))),
        writeBinary: vi.fn(async (path: string, content: ArrayBuffer) => { files.set(path, content); }),
        write: vi.fn(async (path: string, text: string) => { files.set(path, bytes(text)); }),
        mkdir: vi.fn(async (path: string) => { folders.add(path); }),
        list: vi.fn(async () => ({ files: [], folders: [] })),
        rmdir: vi.fn(async (path: string) => { folders.delete(path); }),
        process, trashLocal: trash,
    };
    const vault = {
        adapter,
        getFiles: () => [...files.keys()].map(path => ({ path })),
        getAbstractFileByPath: (path: string) => files.has(path) && !path.startsWith('.') ? identities.get(path) ?? null : null,
        createFolder: adapter.mkdir,
        process: (file: { path: string }, update: (text: string) => string) => process(file.path, update),
        createBinary: vi.fn(async (path: string, content: ArrayBuffer) => { if (files.has(path)) throw new Error('File exists'); files.set(path, content); }),
        trash: (file: { path: string }) => trash(file.path),
    };
    const remote = await metadata(server), target = await metadata(historical);
    const versions: RemoteFileVersion[] = Object.entries(target).map(([path, file]) => ({ ...file, path, storage_key: `retained/${path}`, created_at: '2026-09-20', expires_at: 9999999999, reason: 'replaced' }));
    const api = {
        getManifest: vi.fn(async () => ({ version: 1, files: remote })),
        listFileVersions: vi.fn(async ({ path }: { path?: string }) => ({ versions: versions.filter(v => v.path === path), hasMore: false })),
        previewFileVersion: vi.fn(async (version: RemoteFileVersion) => bytes(historical[version.path]!)),
        downloadFile: vi.fn(async (path: string) => ({ content: bytes(server[path]!), contentType: 'text/plain', ...remote[path]! })),
    };
    const context = { vault: vault as never, api, target, baseline: structuredClone(remote), recoveryRoot: '.crate/state-recovery',
        shouldIgnore: (path: string) => path.startsWith('.crate/') || path.startsWith('.trash/') || path.startsWith('excluded/'),
        verify: vi.fn(), beforeApply: vi.fn(async () => {}), applied: vi.fn() };
    return { context, files, adapter, vault, api, versions, remote, target, process, trash };
}

describe('whole synced vault restore', () => {
    it('previews and restores edits, deletions, later additions and renames, preserving exclusions and originals', async () => {
        const h = await harness({ 'edit.md': 'new', 'same.md': 'same', 'later.md': 'added', 'renamed.md': 'moved', 'excluded/keep.md': 'private' },
            { 'edit.md': 'old', 'same.md': 'same', 'deleted.md': 'restored', 'original.md': 'moved' });
        const review = await createHistoryRestore(h.context);
        expect(review.items).toEqual([
            { path: 'deleted.md', action: 'restore' }, { path: 'edit.md', action: 'revert' }, { path: 'later.md', action: 'remove' },
            { path: 'original.md', action: 'restore' }, { path: 'renamed.md', action: 'remove' },
        ]);
        expect(review.unchangedCount).toBe(1);
        expect(h.adapter.writeBinary).not.toHaveBeenCalled();
        await review.restore();
        expect(h.files.get('edit.md')).toEqual(bytes('old'));
        expect(h.files.get('deleted.md')).toEqual(bytes('restored'));
        expect(h.files.get('original.md')).toEqual(bytes('moved'));
        expect(h.files.has('later.md')).toBe(false);
        expect(h.files.has('renamed.md')).toBe(false);
        expect(h.files.get('excluded/keep.md')).toEqual(bytes('private'));
        expect([...h.files].some(([path, content]) => path.endsWith('.original') && new TextDecoder().decode(content) === 'new')).toBe(true);
        expect(h.context.beforeApply).toHaveBeenCalledOnce();
        await expect(review.restore()).rejects.toThrow('Review the restore again');
    });

    it.each(['note.md', '.obsidian/app.json', 'image.png', '__proto__', 'constructor'])('restores exact bytes for %s', async path => {
        const h = await harness({ [path]: '\uFEFFnew\r\n' }, { [path]: '\uFEFFold\r\n' });
        await (await createHistoryRestore(h.context)).restore();
        expect(h.files.get(path)).toEqual(bytes('\uFEFFold\r\n'));
    });

    it('removes later files with names inherited from Object.prototype', async () => {
        const h = await harness({ constructor: 'later' }, {});
        await (await createHistoryRestore(h.context)).restore();
        expect(h.files.has('constructor')).toBe(false);
    });

    it('requires current server changes to be synced before previewing', async () => {
        const h = await harness({ 'a.md': 'current' }, { 'a.md': 'old' });
        h.context.baseline['a.md']!.revision = 'old-revision';
        await expect(createHistoryRestore(h.context)).rejects.toThrow('Run Sync now');
        expect(h.trash).not.toHaveBeenCalled();
    });

    it.each(['local edit', 'new local file', 'remote revision'])('rejects a stale preview after a %s', async change => {
        const h = await harness({ 'a.md': 'current', 'same.md': 'same' }, { 'a.md': 'old', 'same.md': 'same' });
        const review = await createHistoryRestore(h.context);
        if (change === 'local edit') h.files.set('same.md', bytes('edited'));
        else if (change === 'new local file') h.files.set('new.md', bytes('created'));
        else h.remote['same.md']!.revision = 'recreated-with-same-content';
        await expect(review.restore()).rejects.toThrow('Files changed');
        expect(h.context.beforeApply).not.toHaveBeenCalled();
        expect(h.files.get('a.md')).toEqual(bytes('current'));
    });

    it('fails the entire preview if any required version expired', async () => {
        const h = await harness({ 'a.md': 'current', 'later.md': 'new' }, { 'a.md': 'old' });
        h.versions.length = 0;
        await expect(createHistoryRestore(h.context)).rejects.toThrow('no longer available');
        expect(h.trash).not.toHaveBeenCalled();
    });

    it('stages every version before deleting or replacing any file', async () => {
        const h = await harness({ 'a.md': 'current', 'later.md': 'new' }, { 'a.md': 'old', 'b.md': 'deleted' });
        const review = await createHistoryRestore(h.context);
        h.api.previewFileVersion.mockRejectedValueOnce(new Error('Offline'));
        await expect(review.restore()).rejects.toThrow('Offline');
        expect(h.trash).not.toHaveBeenCalled();
        expect(h.process).not.toHaveBeenCalled();
        expect(h.context.beforeApply).not.toHaveBeenCalled();
    });

    it('refuses corrupt downloaded bytes before applying anything', async () => {
        const h = await harness({ 'a.md': 'current' }, { 'a.md': 'old' });
        h.api.previewFileVersion.mockResolvedValue(bytes('wrong'));
        await expect((await createHistoryRestore(h.context)).restore()).rejects.toThrow('damaged');
        expect(h.process).not.toHaveBeenCalled();
    });

    it('preserves an edit that arrives inside the atomic write', async () => {
        const h = await harness({ 'a.md': 'current' }, { 'a.md': 'old' });
        h.process.mockImplementationOnce(async (path, update) => { h.files.set(path, bytes('new edit')); update('new edit'); });
        await expect((await createHistoryRestore(h.context)).restore()).rejects.toThrow('Automatic sync is off');
        expect(h.files.get('a.md')).toEqual(bytes('new edit'));
    });

    it('checks the entire local and remote result after syncing', async () => {
        const h = await harness({ 'a.md': 'current' }, { 'a.md': 'old' });
        const review = await createHistoryRestore(h.context);
        await review.restore();
        await expect(review.verifySynced()).rejects.toThrow('final sync');
        Object.assign(h.remote, h.target);
        await review.verifySynced();
    });

    it('can restore an empty checkpoint', async () => {
        const h = await harness({ 'later.md': 'new' }, {});
        await (await createHistoryRestore(h.context)).restore();
        expect(h.files.has('later.md')).toBe(false);
    });

    it('includes a later server addition already deleted locally so the deletion still syncs', async () => {
        const h = await harness({}, {}, { 'later.md': 'new' });
        const review = await createHistoryRestore(h.context);
        expect(review.items).toEqual([{ path: 'later.md', action: 'remove' }]);
        await review.restore();
        expect(h.context.applied).toHaveBeenCalledWith('later.md', true);
    });

    it('uses matching local bytes when the remote target version has expired', async () => {
        const h = await harness({ 'a.md': 'old' }, { 'a.md': 'old' }, { 'a.md': 'new' });
        h.versions.length = 0;
        const review = await createHistoryRestore(h.context);
        expect(review.items).toEqual([{ path: 'a.md', action: 'revert' }]);
        await review.restore();
        expect(h.api.previewFileVersion).not.toHaveBeenCalled();
        expect(h.files.get('a.md')).toEqual(bytes('old'));
    });
});

describe('history checkpoints', () => {
    it('round trips a complete inventory, bound to its server and exclusions', async () => {
        const h = await harness({}, {});
        const checkpoints = new HistoryCheckpoints(h.adapter as never, '.crate/checkpoints', 'https://one.test');
        const files = await metadata({ 'a.md': 'one', '__proto__.md': 'two' });
        const id = await checkpoints.save(files, ['excluded/']);
        expect((await checkpoints.load(id, ['excluded/'])).files).toEqual(files);
        await expect(checkpoints.load(id, [])).rejects.toThrow('exclusions');
        await expect(new HistoryCheckpoints(h.adapter as never, '.crate/checkpoints', 'https://two.test').load(id, ['excluded/'])).rejects.toThrow('different sync');
        h.files.set(`.crate/checkpoints/${id}.json`, bytes('{}'));
        await expect(checkpoints.load(id, ['excluded/'])).rejects.toThrow('damaged');
    });

    it('rejects missing checkpoints and path traversal', async () => {
        const h = await harness({}, {});
        const checkpoints = new HistoryCheckpoints(h.adapter as never, '.crate/checkpoints', 'https://one.test');
        await expect(checkpoints.load('a'.repeat(64), [])).rejects.toThrow('no longer available');
        await expect(checkpoints.load('../secret', [])).rejects.toThrow('no complete');
    });
});
