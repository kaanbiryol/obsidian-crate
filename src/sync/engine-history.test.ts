import { expect, it, vi } from 'vitest';
import { createEngineHistory } from './engine-history';
import { computeHash } from './hasher';

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
async function harness(local: Record<string, string>, saved: Record<string, string>) {
    const files = new Map(Object.entries(local));
    const target = Object.fromEntries(await Promise.all(Object.entries(saved).map(async ([path, text]) => [path, {
        hash: await computeHash(bytes(text)), size: bytes(text).byteLength, modified: '2026-09-20',
    }] as const)));
    const adapter = {
        exists: vi.fn(async (path: string) => files.has(path)),
        stat: vi.fn(async (path: string) => files.has(path) ? { type: 'file', size: bytes(files.get(path)!).byteLength, mtime: 1, ctime: 1 } : null),
        readBinary: vi.fn(async (path: string) => {
            if (!files.has(path)) throw new Error('File missing');
            return bytes(files.get(path)!);
        }),
        list: vi.fn(async (folder: string) => {
            const prefix = folder ? folder + '/' : '';
            const paths = [...files.keys()].filter(path => path.startsWith(prefix));
            return {
                files: paths.filter(path => !path.slice(prefix.length).includes('/')),
                folders: [...new Set(paths.filter(path => path.slice(prefix.length).includes('/'))
                    .map(path => prefix + path.slice(prefix.length).split('/')[0]))],
            };
        }),
        writeBinary: vi.fn(), write: vi.fn(), mkdir: vi.fn(),
    };
    const getFiles = () => [...files].filter(([path]) => !path.split('/').some(part => part.startsWith('.')))
        .map(([path, text]) => ({ path, extension: 'md', stat: { size: bytes(text).byteLength, mtime: 1, ctime: 1 } }));
    const vault = { adapter, getFiles, getAbstractFileByPath: (path: string) => getFiles().find(file => file.path === path) ?? null };
    const api = { sharedHistory: {
        load: vi.fn(async () => ({ files: target })),
        download: vi.fn(async (_checkpoint: string, path: string) => bytes(saved[path]!)),
    } };
    const settings = { workerUrl: 'https://example.com', ignorePatterns: ['excluded/'] };
    const context = {
        vault: vault as never, api: api as never, pluginDir: '.obsidian/plugins/crate',
        getSettings: () => settings,
        // A deliberately stale sync baseline must never hide unsynced edits.
        getManifest: vi.fn(() => ({ version: 1, files: target })),
        shouldIgnore: (path: string) => path.startsWith('excluded/'),
        assertActive: vi.fn(), hasPendingMutations: () => true, canCheckpoint: () => false,
        runExclusive: vi.fn(), applied: vi.fn(),
    };
    return { files, adapter, api, settings, context, history: createEngineHistory(context) };
}

it('compares actual unsynced files and hidden configuration with the selected saved state', async () => {
    const h = await harness({ 'edit.md': 'unsynced', 'local.md': 'new', 'same.md': 'same', '.obsidian/core-plugins.json': '{"sync":false}' },
        { 'edit.md': 'saved', 'deleted.md': 'old', 'same.md': 'same', '.obsidian/core-plugins.json': '{"sync":true}' });
    const comparison = await h.history.compare('selected', true);
    expect(comparison.items).toEqual([
        { path: '.obsidian/core-plugins.json', action: 'modified' },
        { path: 'deleted.md', action: 'added' }, { path: 'edit.md', action: 'modified' }, { path: 'local.md', action: 'deleted' },
    ]);
    expect(await comparison.preview('edit.md')).toEqual({ current: 'unsynced', saved: 'saved' });
    expect(await comparison.preview('deleted.md')).toEqual({ current: '', saved: 'old' });
    expect(await comparison.preview('local.md')).toEqual({ current: 'new', saved: '' });
    expect(await comparison.preview('.obsidian/core-plugins.json')).toEqual({ current: '{"sync":false}', saved: '{"sync":true}' });
    expect(h.context.getManifest).not.toHaveBeenCalled();
    expect(h.context.runExclusive).not.toHaveBeenCalled();
    expect(h.adapter.writeBinary).not.toHaveBeenCalled();
    expect(h.adapter.write).not.toHaveBeenCalled();
    expect(h.adapter.mkdir).not.toHaveBeenCalled();
});
it('shows no differences when the current vault matches the selected state', async () => {
    const h = await harness({ 'note.md': 'same' }, { 'note.md': 'same' });
    const comparison = await h.history.compare('selected', true);
    expect(comparison.compared).toBe(true);
    expect(comparison.items).toEqual([]);
    expect(h.api.sharedHistory.download).not.toHaveBeenCalled();
});
it('excludes ignored files from both current and historical inventories', async () => {
    const h = await harness({ 'excluded/local.md': 'private' }, { 'excluded/saved.md': 'private' });
    expect((await h.history.compare('selected', true)).items).toEqual([]);
    expect(h.adapter.readBinary).not.toHaveBeenCalled();
});
it('rechecks local bytes on revisiting a file and picks up edits on a fresh comparison', async () => {
    const h = await harness({ 'note.md': 'unsynced' }, { 'note.md': 'saved' });
    const comparison = await h.history.compare('selected', true);
    expect(await comparison.preview('note.md')).toEqual({ current: 'unsynced', saved: 'saved' });
    h.files.set('note.md', 'another edit');
    await expect(comparison.preview('note.md')).rejects.toThrow('changed');
    expect(await (await h.history.compare('selected', true)).preview('note.md')).toEqual({ current: 'another edit', saved: 'saved' });
});
it('fails an incomplete local scan instead of treating missing files as additions', async () => {
    const h = await harness({ 'note.md': 'local' }, { 'note.md': 'saved' });
    h.adapter.list.mockRejectedValue(new Error('Cannot list vault'));
    await expect(h.history.compare('selected', true)).rejects.toThrow('Cannot list vault');
});
it('rejects a file disappearing during the scan', async () => {
    const h = await harness({ 'note.md': 'local' }, { 'note.md': 'saved' });
    h.adapter.readBinary.mockImplementationOnce(async path => { h.files.delete(path); throw new Error('Deleted'); });
    await expect(h.history.compare('selected', true)).rejects.toThrow('changed while checking');
});
it('rejects an expired selected checkpoint before reading local contents', async () => {
    const h = await harness({ 'note.md': 'local' }, { 'note.md': 'saved' });
    h.api.sharedHistory.load.mockRejectedValue(new Error('Checkpoint expired'));
    await expect(h.history.compare('selected', true)).rejects.toThrow('Checkpoint expired');
    expect(h.adapter.readBinary).not.toHaveBeenCalled();
});
it('rejects an exclusion change during comparison or preview', async () => {
    const h = await harness({ 'note.md': 'local' }, { 'note.md': 'saved' });
    const comparison = await h.history.compare('selected', true);
    h.settings.ignorePatterns.push('note.md');
    await expect(comparison.preview('note.md')).rejects.toThrow('exclusions changed');
    const pending = h.history.compare('selected', true);
    h.settings.ignorePatterns.push('other.md');
    await expect(pending).rejects.toThrow('exclusions changed');
});
