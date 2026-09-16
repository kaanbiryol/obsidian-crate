import { expect, it, vi } from 'vitest';
import { ConflictStore } from './conflict-store';
import { getIncomingConflictFileName } from './conflict';
import { computeHash } from './hasher';
import { downloadAndSaveFile, parallelDownloadAndSaveFiles } from './transfer-download';
import { createTransferHarness, emptyResult } from './transfer-test-harness';

const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

function harness() {
    const h = createTransferHarness();
    const files = new Map<string, ArrayBuffer>();
    const adapter = {
        ...h.adapter,
        read: vi.fn(async (path: string) => new TextDecoder().decode(files.get(path))),
        write: vi.fn(async (path: string, value: string) => { files.set(path, encode(value)); }),
    };
    adapter.exists.mockImplementation(async (path: string) => files.has(path));
    adapter.stat.mockImplementation(async (path: string) => files.has(path) ? { type: 'file' } : null);
    adapter.readBinary.mockImplementation(async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error('File missing');
        return bytes;
    });
    adapter.remove.mockImplementation(async (path: string) => { files.delete(path); });
    h.vault.adapter = adapter;
    h.vault.getAbstractFileByPath.mockReturnValue(null);
    h.vault.createBinary.mockImplementation(async (path: string, content: ArrayBuffer) => {
        // Hidden files are created, but have no indexed TFile to return.
        if (await adapter.exists(path)) throw new Error('File already exists');
        files.set(path, content);
        return null;
    });
    const counts: number[] = [];
    const store = new ConflictStore({ vault: h.vault } as never, { dir: '.obsidian/plugins/crate' } as never, count => counts.push(count));
    const context = { ...h.context, conflictStore: store };
    return { ...h, adapter, context, files, store, counts };
}

for (const mode of ['single', 'batch', 'fallback'] as const) {
    it.each([false, true])(`${mode}: installs missing hidden files (previous review copies: %s)`, async withCopies => {
        const h = harness();
        const remote = new Map([
            ['.obsidian/plugins/omnisearch/data.json', encode('{"setting":true}')],
            ['.obsidian/plugins/omnisearch/main.js', encode('console.log("plugin");')],
            ['.obsidian/themes/Minimal/manifest.json', encode('{"name":"Minimal"}')],
            ['.obsidian/themes/Minimal/theme.css', encode('\uFEFFbody { color: red; }\r\n')],
            ['notes/.assets/icon.png', new Uint8Array([137, 80, 78, 71, 255, 0]).buffer],
        ]);
        const requests = await Promise.all([...remote].map(async ([path, content]) => ({
            path, expectedLocalHash: null, expectedRemoteHash: await computeHash(content), remoteSize: content.byteLength,
        })));
        await h.store.load();
        for (const request of requests) {
            if (!withCopies) continue;
            const copy = getIncomingConflictFileName(request.path, request.expectedRemoteHash);
            h.files.set(copy, remote.get(request.path)!);
            await h.store.record({
                originalPath: request.path, conflictPath: copy, cause: 'incoming-review', copySide: 'remote',
                localHash: '', remoteHash: request.expectedRemoteHash,
            });
        }
        h.api.downloadFile.mockImplementation(async (path: string) => ({
            content: remote.get(path)!, hash: await computeHash(remote.get(path)!), size: remote.get(path)!.byteLength, revision: '1',
        }));
        h.api.batchDownload.mockImplementation(async (paths: string[]) => ({ files: await Promise.all(paths.map(async path => ({
            path, content: Buffer.from(remote.get(path)!).toString('base64'), hash: await computeHash(remote.get(path)!),
            size: remote.get(path)!.byteLength, revision: '1',
        }))) }));
        if (mode === 'fallback') h.api.batchDownload.mockRejectedValue(new Error('Batch unavailable'));
        const result = emptyResult();
        if (mode === 'single') {
            for (const request of requests) expect(await downloadAndSaveFile(h.context, request, result)).toEqual({ status: 'applied' });
        } else {
            await parallelDownloadAndSaveFiles(h.context, requests, result, 2);
        }
        expect(result.downloaded).toBe(remote.size);
        expect(result.errors).toEqual([]);
        expect(h.store.getActiveConflicts()).toEqual([]);
        expect(h.counts.at(-1)).toBe(0);
        for (const request of requests) {
            expect(h.files.get(request.path)).toEqual(remote.get(request.path));
            expect(h.localManifest.setEntry).toHaveBeenCalledWith(request.path, expect.objectContaining({ hash: request.expectedRemoteHash, revision: '1' }));
            const copy = getIncomingConflictFileName(request.path, request.expectedRemoteHash);
            expect(h.files.get(copy)).toEqual(withCopies ? remote.get(request.path) : undefined);
        }
        await h.store.load();
        expect(h.store.getActiveConflicts()).toEqual([]);
    });
}

it.each(['edited-copy', 'changed-original', 'missing-copy', 'unreadable-copy', 'existing-local', 'different-remote', 'real-conflict'] as const)(
    'keeps an incoming review active when it is not a verified first-sync duplicate: %s', async scenario => {
        const h = harness();
        const path = '.obsidian/plugins/omnisearch/data.json';
        const content = encode('remote');
        const hash = await computeHash(content);
        const copy = getIncomingConflictFileName(path, hash);
        h.files.set(path, scenario === 'changed-original' ? encode('local edit') : content);
        if (scenario !== 'missing-copy') h.files.set(copy, scenario === 'edited-copy' ? encode('edited recovery copy') : content);
        await h.store.record({
            originalPath: path, conflictPath: copy, cause: scenario === 'real-conflict' ? 'concurrent-create' : 'incoming-review',
            copySide: 'remote', localHash: scenario === 'existing-local' ? 'local-hash' : '',
            remoteHash: scenario === 'different-remote' ? 'another-hash' : hash,
        });
        if (scenario === 'unreadable-copy') h.adapter.readBinary.mockRejectedValue(new Error('Permission denied'));
        await h.store.resolveAppliedIncoming(path, hash);
        expect(h.store.getActiveConflicts()).toHaveLength(1);
        expect(h.adapter.remove).not.toHaveBeenCalledWith(copy);
    },
);

it('keeps a previous review active when the host rejects creation during a retry', async () => {
    const h = harness();
    const path = '.obsidian/plugins/omnisearch/data.json';
    const content = encode('remote');
    const hash = await computeHash(content);
    const copy = getIncomingConflictFileName(path, hash);
    h.files.set(copy, content);
    await h.store.record({ originalPath: path, conflictPath: copy, cause: 'incoming-review', copySide: 'remote', localHash: '', remoteHash: hash });
    h.api.downloadFile.mockResolvedValue({ content, size: content.byteLength, hash });
    h.vault.createBinary.mockImplementation(async () => {
        h.files.set(path, encode('created locally'));
        throw new Error('File already exists');
    });
    const result = emptyResult();
    await expect(downloadAndSaveFile(h.context, { path, expectedLocalHash: null, expectedRemoteHash: hash, remoteSize: content.byteLength }, result))
        .rejects.toThrow('File already exists');
    expect(h.files.get(path)).toEqual(encode('created locally'));
    expect(h.files.get(copy)).toEqual(content);
    expect(h.store.getActiveConflicts()).toHaveLength(1);
    expect(result.downloaded).toBe(0);
    expect(h.localManifest.setEntry).not.toHaveBeenCalled();
});
