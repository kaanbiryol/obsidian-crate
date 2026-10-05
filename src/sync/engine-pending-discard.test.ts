import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FileEntry } from '../protocol/sync-types';
import { TEST_PLUGIN_DIR } from '../test/factories/sync-vault';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { computeHash } from './hasher';
import type { ApiHttpResponse, ApiHttpTransport } from './worker-api/http';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const path = '.obsidian/plugins/obsidian-minimal-settings/data.json';
const toArrayBuffer = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
function response(content: unknown): ApiHttpResponse {
    const arrayBuffer = content instanceof ArrayBuffer ? content : toArrayBuffer(JSON.stringify(content));
    return { status: 200, headers: {}, arrayBuffer, text: new TextDecoder().decode(arrayBuffer) };
}

async function setup(saved = '{"theme":"saved"}', local: string | null = '{"theme":"local"}') {
    const base = toArrayBuffer(saved);
    const baseline = { hash: await computeHash(base), size: base.byteLength, modified: '2026-09-30T10:00:00Z', revision: 'last-synced-revision' };
    const key = local === null ? `delete:${path}` : path;
    const version = { ...baseline, path, storage_key: 'retained', created_at: '2026-09-30T10:00:00Z', expires_at: 1, reason: 'replaced' as const };
    const remote = {
        getFileMetadata: vi.fn(async (): Promise<{ files: Record<string, FileEntry> }> => ({ files: { [path]: baseline } })),
        listFileVersions: vi.fn(async () => ({ versions: [version], hasMore: false })),
        previewFileVersion: vi.fn(async () => base),
        downloadFile: vi.fn(async () => ({ content: base })),
    };
    const transport = vi.fn<ApiHttpTransport>(async request => {
        switch (new URL(request.url).pathname) {
            case '/sync/metadata': return response(await remote.getFileMetadata());
            case '/sync/versions': return response(await remote.listFileVersions());
            case '/sync/version-preview': return response(await remote.previewFileVersion());
            case '/sync/download': return response((await remote.downloadFile()).content);
            default: throw new Error(`Unexpected request: ${request.url}`);
        }
    });
    const h = await createPersistentEngineHarness(transport);
    await h.vault.adapter.mkdir(path.slice(0, path.lastIndexOf('/')));
    if (local !== null) h.disk.write(path, local);
    h.localManifest.setEntry(path, baseline);
    await h.localManifest.save();
    const setEntry = vi.spyOn(h.localManifest, 'setEntry');
    const process = vi.spyOn(h.vault.adapter, 'process');
    const writeBinary = vi.spyOn(h.vault.adapter, 'writeBinary');
    await h.engine.onRawFileChange(path);
    return { ...h, base, baseline, key, remote, process, writeBinary, transport, setEntry };
}

it.each(['current', 'retained'])('discards uncached JSON against the %s last-synced copy and preserves recovery bytes', async source => {
    const h = await setup();
    const original = h.disk.read(path);
    if (source === 'retained') h.remote.getFileMetadata.mockResolvedValue({ files: { [path]: { ...h.baseline, hash: 'b'.repeat(64) } } });
    const review = await h.engine.createPendingDiscard([h.key]);
    expect(review.items).toEqual([{ path, action: 'restore' }]);
    expect(h.disk.read(path)).toEqual(original);
    expect(h.setEntry).not.toHaveBeenCalled();
    await review.discard();
    expect(h.disk.read(path)).toEqual(h.base);
    const recovery = await h.vault.adapter.list(`${TEST_PLUGIN_DIR}/discard-recovery`);
    expect(recovery.folders).toHaveLength(1);
    expect(h.disk.read(`${recovery.folders[0]}/original`)).toEqual(original);
    expect(h.localManifest.getEntry(path)).toMatchObject({ hash: h.baseline.hash, revision: h.baseline.revision });
    const persisted = JSON.parse(h.disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`)) as { files: Record<string, FileEntry> };
    expect(persisted.files[path]).toMatchObject({
        hash: h.baseline.hash, revision: h.baseline.revision,
    });
    expect(h.engine.getPendingPaths()).not.toContain(h.key);
    expect(h.transport.mock.calls.every(([request]) => !/\/sync\/(upload|changes)/.test(request.url))).toBe(true);
    if (source === 'retained') {
        expect(h.remote.previewFileVersion).toHaveBeenCalledTimes(2);
        expect(h.remote.downloadFile).not.toHaveBeenCalled();
    }
});

it('restores a locally deleted JSON file from its verified server copy', async () => {
    const h = await setup('{"theme":"saved"}', null);
    await (await h.engine.createPendingDiscard([h.key])).discard();
    expect(h.disk.read(path)).toEqual(h.base);
    expect(h.engine.getPendingPaths()).not.toContain(h.key);
});

it('does not apply the text preview limit to discarding a current server file', async () => {
    const h = await setup(JSON.stringify({ text: 'a'.repeat(256_001) }));
    await (await h.engine.createPendingDiscard([h.key])).discard();
    expect(h.disk.read(path)).toEqual(h.base);
});

it.each(['offline', 'corrupt', 'expired'])('keeps local JSON and its pending change when its baseline is %s', async failure => {
    const h = await setup();
    const original = h.disk.read(path);
    if (failure === 'offline') h.remote.getFileMetadata.mockRejectedValue(new Error('Offline'));
    if (failure === 'corrupt') h.remote.downloadFile.mockResolvedValue({ content: toArrayBuffer('wrong bytes') });
    if (failure === 'expired') {
        h.remote.getFileMetadata.mockResolvedValue({ files: {} });
        h.remote.listFileVersions.mockResolvedValue({ versions: [], hasMore: false });
    }
    await expect(h.engine.createPendingDiscard([h.key])).rejects.toThrow();
    expect(h.disk.read(path)).toEqual(original);
    expect(h.engine.getPendingPaths()).toContain(h.key);
    expect(h.process).not.toHaveBeenCalled();
    expect(h.writeBinary).not.toHaveBeenCalled();
    expect(h.setEntry).not.toHaveBeenCalled();
});

it('keeps an edit made while downloading the confirmed replacement', async () => {
    const h = await setup();
    const review = await h.engine.createPendingDiscard([h.key]);
    h.remote.downloadFile.mockImplementation(async () => {
        h.disk.write(path, 'new edit while downloading');
        return { content: h.base };
    });
    await expect(review.discard()).rejects.toThrow('changed');
    expect(h.disk.read(path)).toEqual(toArrayBuffer('new edit while downloading'));
    expect(h.engine.getPendingPaths()).toContain(h.key);
    expect(h.process).not.toHaveBeenCalled();
});

it('rejects changed server bytes after confirmation without overwriting the local file', async () => {
    const h = await setup();
    const original = h.disk.read(path);
    const review = await h.engine.createPendingDiscard([h.key]);
    h.remote.downloadFile.mockResolvedValue({ content: toArrayBuffer('different server version') });
    await expect(review.discard()).rejects.toThrow('could not be verified');
    expect(h.disk.read(path)).toEqual(original);
    expect(h.engine.getPendingPaths()).toContain(h.key);
    expect(h.process).not.toHaveBeenCalled();
    expect(h.writeBinary).not.toHaveBeenCalled();
});
