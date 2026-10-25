import { pendingChangeKey } from '../pending/pending-change';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import type { BatchUploadFile, FileEntry } from '../../protocol/sync-types';
import { TEST_PLUGIN_DIR } from '../../test/factories/sync-vault';
import { createPersistentEngineHarness } from './engine-persistence-test-harness';
import { arrayBufferToBase64 } from '../encoding';
import type { ApiHttpResponse, ApiHttpTransport } from '../worker-api/http';
import { formatSyncProgress } from '../../ui/activity/progress-label';
import { sha256Hex } from '../../platform/sha256';
import { Notice } from '../../test/mocks/obsidian';
import { AUTH_ERROR_MESSAGE } from '../sync-outcome';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());
const bytes = new TextEncoder().encode('local').buffer;
function response(value: unknown): ApiHttpResponse {
    const text = JSON.stringify(value);
    return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}
async function harness(paths = ['a.md', 'b.md']) {
    const hash = await sha256Hex(bytes);
    const entry = { hash, revision: 'v1', size: bytes.byteLength, modified: '2026-09-30T10:00:00Z' };
    const remote = {
        metadata: vi.fn(async (paths: string[]): Promise<{ files: Record<string, FileEntry> }> => ({ files: Object.fromEntries(paths.map(path => [path, entry])) })),
        batchUpload: vi.fn(async (files: BatchUploadFile[]) => ({ success: true, results: files.map(file => ({ path: file.path, hash: file.hash, revision: 'uploaded', success: true })) })),
        upload: vi.fn(async (path: string) => ({ path, hash, revision: 'uploaded', success: true })),
        delete: vi.fn(async (body: { path: string; expectedHash: string; expectedRevision: string }) => ({ path: body.path, success: true })),
    };
    const transport = vi.fn<ApiHttpTransport>(async request => {
        const url = new URL(request.url);
        switch (url.pathname) {
            case '/.well-known/crate': return response({ service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [], reminderOperationDay: Math.floor(Date.now() / 86_400_000) });
            case '/sync/metadata': return response(await remote.metadata((JSON.parse(request.body as string) as { paths: string[] }).paths));
            case '/sync/batch-upload': return response(await remote.batchUpload((JSON.parse(request.body as string) as { files: BatchUploadFile[] }).files));
            case '/sync/upload': return response(await remote.upload(url.searchParams.get('path')!));
            case '/sync/batch-delete': {
                const body = JSON.parse(request.body as string) as { files: Parameters<typeof remote.delete>[0][] };
                for (const file of body.files) await remote.delete(file);
                return response({ success: true, deleted: body.files.map(file => file.path) });
            }
            default: throw new Error(`Unexpected request: ${request.url}`);
        }
    });
    const h = await createPersistentEngineHarness(transport, { automaticSync: false, lastSeq: 42 });
    for (const path of paths) {
        h.disk.write(path, bytes);
        h.engine.onFileChange(h.vault.getAbstractFileByPath(path) as never);
    }
    const restart = async () => {
        h.engine.destroy(); await h.engine.waitForIdle();
        return createPersistentEngineHarness(transport, h.settings, h.disk);
    };
    return { ...h, remote, transport, entry, restart };
}

describe('selected sync with durable file operations', () => {
    it('preserves selected pending files and the cursor when metadata loading is cancelled', async () => {
        const h = await harness();
        h.remote.metadata.mockRejectedValue(new DOMException('Request cancelled', 'AbortError'));
        expect(await h.engine.syncSelected(['a.md'])).toMatchObject({ outcome: 'cancelled', success: false, errors: [] });
        expect(h.engine.getPendingKeys()).toEqual(['a.md', 'b.md']);
        expect(h.settings.lastSeq).toBe(42);
        expect(h.settings.lastSync).toBeNull();
        expect(h.engine.getState().status).toBe('idle');
    });

    it('reports revoked access with the reconnect message and keeps the selection pending', async () => {
        Notice.reset();
        const h = await harness();
        const transport = h.transport.getMockImplementation()!;
        h.transport.mockImplementation(async request => new URL(request.url).pathname === '/sync/metadata'
            ? { ...response({ error: 'Unauthorized' }), status: 401 } : transport(request));
        expect(await h.engine.syncSelected(['a.md'])).toMatchObject({ outcome: 'failed', success: false, errors: [AUTH_ERROR_MESSAGE] });
        expect(h.engine.getState()).toMatchObject({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
        expect(Notice.messages).toEqual([AUTH_ERROR_MESSAGE]);
        expect(h.engine.getPendingKeys()).toEqual(['a.md', 'b.md']);
        expect(h.settings.lastSync).toBeNull();
    });

    it('reports an upload rejected for revoked access with the reconnect message', async () => {
        Notice.reset();
        const h = await harness();
        h.remote.metadata.mockResolvedValue({ files: {} });
        const transport = h.transport.getMockImplementation()!;
        h.transport.mockImplementation(async request => new URL(request.url).pathname === '/sync/batch-upload'
            ? { ...response({ error: 'Unauthorized' }), status: 401 } : transport(request));
        const result = await h.engine.syncSelected(['a.md']);
        expect(result).toMatchObject({ outcome: 'failed', success: false });
        expect(result.errors).toContain(AUTH_ERROR_MESSAGE);
        expect(h.engine.getState()).toMatchObject({ status: 'error', lastError: AUTH_ERROR_MESSAGE });
        expect(Notice.messages).toEqual([AUTH_ERROR_MESSAGE]);
        expect(h.engine.getPendingKeys()).toEqual(['a.md', 'b.md']);
        expect(h.settings.lastSync).toBeNull();
    });

    it('selects an upload named delete:note.md separately from deleting note.md', async () => {
        const h = await harness(['note.md', 'delete:note.md']);
        h.localManifest.setEntry('note.md', h.entry); await h.localManifest.save();
        h.disk.remove('note.md'); h.engine.onFileDelete({ path: 'note.md' } as never);
        h.remote.metadata.mockImplementation(async (paths): Promise<{ files: Record<string, FileEntry> }> => ({ files: paths.includes('note.md') ? { 'note.md': h.entry } : {} }));
        const uploaded = await h.engine.syncSelected(['delete:note.md']);
        expect(uploaded.success, uploaded.errors.join('\n')).toBe(true);
        expect(uploaded.uploadedPaths).toEqual(['delete:note.md']);
        expect(h.remote.metadata).toHaveBeenCalledExactlyOnceWith(['delete:note.md']);
        expect(h.remote.delete).not.toHaveBeenCalled();
        expect(h.engine.getPendingKeys()).toEqual([pendingChangeKey('delete', 'note.md')]);
        const deleted = await h.engine.syncSelected([pendingChangeKey('delete', 'note.md')]);
        expect(deleted.success, deleted.errors.join('\n')).toBe(true);
        expect(deleted.deletedPaths).toEqual(['note.md']);
        expect(h.remote.delete).toHaveBeenCalledWith({ path: 'note.md', expectedHash: h.entry.hash, expectedRevision: 'v1' });
        expect(h.disk.text('delete:note.md')).toBe('local');
        expect(h.engine.getPendingKeys()).toEqual([]);
    });

    it('shows checking, per-file progress, and saving during selected uploads', async () => {
        const h = await harness(), labels: string[] = [];
        h.engine.setStateChangeCallback(state => labels.push(formatSyncProgress(null, state.work)));
        h.remote.metadata.mockImplementation(async () => {
            expect(labels.at(-1)).toBe('Checking for changes…');
            return { files: {} };
        });
        const upload = h.remote.batchUpload.getMockImplementation()!;
        h.remote.batchUpload.mockImplementation(async files => {
            expect(labels.at(-1)).toBe('Uploading 0 of 2 files');
            expect(h.localManifest.uploadJournal.pending().map(file => file.path)).toEqual(['a.md', 'b.md']);
            return upload(files);
        });
        const save = h.localManifest.save.bind(h.localManifest);
        vi.spyOn(h.localManifest, 'save').mockImplementation(async () => {
            expect(labels.at(-1)).toBe('Saving sync progress…');
            await save();
        });
        const result = await h.engine.syncSelected(['a.md', 'b.md']);
        expect(result.success, result.errors.join('\n')).toBe(true);
        expect(result.uploadedPaths).toEqual(['a.md', 'b.md']);
        expect(h.remote.batchUpload).toHaveBeenCalledTimes(1);
        expect(h.remote.upload).not.toHaveBeenCalled();
        expect(labels).toContain('Uploading 2 of 2 files');
        expect(labels).toContain('Applying changes: 2/2');
        expect(h.engine.getState()).toMatchObject({ status: 'idle', work: undefined });
        const restarted = await h.restart();
        expect(restarted.localManifest.getAllPaths()).toEqual(['a.md', 'b.md']);
        expect(restarted.localManifest.uploadJournal.pending()).toEqual([]);
    });
    it('settles only selected touched files, persists their baseline, and preserves the global server cursor', async () => {
        const h = await harness();
        const result = await h.engine.syncSelected(['a.md']);
        expect(result.success).toBe(true);
        expect(result.settledPaths).toEqual(['a.md']);
        expect(h.remote.metadata).toHaveBeenCalledWith(['a.md']);
        expect(h.transport).toHaveBeenCalledTimes(1);
        expect(h.engine.getPendingKeys()).toEqual(['b.md']);
        expect(h.settings.lastSeq).toBe(42);
        const restarted = await h.restart();
        expect(restarted.localManifest.getEntry('a.md')).toMatchObject({ hash: h.entry.hash, revision: 'v1' });
        expect(restarted.localManifest.hasFile('b.md')).toBe(false);
    });
    it('uploads only a selected file and checkpoints its receipt before removing the journal', async () => {
        const h = await harness(); h.remote.metadata.mockResolvedValue({ files: {} });
        const result = await h.engine.syncSelected(['a.md']);
        expect(result.success, result.errors.join('\n')).toBe(true);
        expect(result.uploadedPaths).toEqual(['a.md']);
        expect(h.engine.getPendingKeys()).toEqual(['b.md']);
        const restarted = await h.restart();
        expect(restarted.localManifest.getEntry('a.md')).toMatchObject({ hash: h.entry.hash, revision: 'uploaded' });
        expect(restarted.localManifest.uploadJournal.pending()).toEqual([]);
        expect((await h.vault.adapter.list(`${TEST_PLUGIN_DIR}/pending-uploads`)).files).toEqual([]);
    });
    it('syncs a selected deletion without touching other pending files', async () => {
        const h = await harness();
        h.localManifest.setEntry('a.md', h.entry); await h.localManifest.save();
        h.disk.remove('a.md'); h.engine.onFileDelete({ path: 'a.md' } as never);
        const result = await h.engine.syncSelected([pendingChangeKey('delete', 'a.md')]);
        expect(result.success, result.errors.join('\n')).toBe(true);
        expect(result.deletedPaths).toEqual(['a.md']);
        expect(h.remote.delete).toHaveBeenCalledWith({ path: 'a.md', expectedHash: h.entry.hash, expectedRevision: 'v1' });
        expect(h.engine.getPendingKeys()).toEqual(['b.md']);
        expect((await h.restart()).localManifest.hasFile('a.md')).toBe(false);
        expect(h.disk.text('b.md')).toBe('local');
    });
    it('retains an edit queued while its selected sync is running', async () => {
        const h = await harness(), metadata = h.remote.metadata.getMockImplementation()!;
        h.remote.metadata.mockImplementation(async paths => {
            h.engine.onFileChange(h.vault.getAbstractFileByPath('a.md') as never);
            return metadata(paths);
        });
        expect((await h.engine.syncSelected(['a.md'])).success).toBe(true);
        expect(h.engine.getPendingKeys()).toEqual(['a.md', 'b.md']);
    });
    it('does not recover unselected journal uploads as a side effect, including after restart', async () => {
        const h = await harness();
        await h.localManifest.uploadJournal.prepare([{ path: 'b.md', hash: h.entry.hash, size: bytes.byteLength, content: arrayBufferToBase64(bytes), contentType: 'text/markdown', expectedHash: null, intent: { kind: 'local' } }], Math.floor(Date.now() / 86_400_000));
        await expect(h.engine.syncSelected(['a.md'])).rejects.toThrow('recover interrupted uploads');
        const restarted = await h.restart();
        expect(restarted.localManifest.uploadJournal.pending().map(file => file.path)).toEqual(['b.md']);
        restarted.engine.onFileChange(restarted.vault.getAbstractFileByPath('a.md') as never);
        await expect(restarted.engine.syncSelected(['a.md'])).rejects.toThrow('recover interrupted uploads');
        expect(h.transport).not.toHaveBeenCalled();
    });
    it.each([{ keys: [] }, { keys: ['unknown.md'] }])('rejects an empty or stale selection: %j', async ({ keys }) => {
        const h = await harness();
        await expect(h.engine.syncSelected(keys)).rejects.toThrow('Pending files changed');
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.engine.getPendingKeys()).toEqual(['a.md', 'b.md']);
    });
    it('refuses to start while another sync is running', async () => {
        const h = await harness();
        let finish!: () => void;
        const blocked = new Promise<void>(resolve => { finish = resolve; });
        h.remote.metadata.mockImplementation(async () => { await blocked; return { files: {} }; });
        const running = h.engine.syncSelected(['b.md']);
        await vi.waitFor(() => expect(h.remote.metadata).toHaveBeenCalledWith(['b.md']));
        await expect(h.engine.syncSelected(['a.md'])).rejects.toThrow('current sync');
        expect(h.remote.metadata).toHaveBeenCalledTimes(1);
        finish();
        expect((await running).success).toBe(true);
    });
});
