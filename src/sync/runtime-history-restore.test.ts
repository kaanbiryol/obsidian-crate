import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHistoryRestore } from './runtime-history-workflow';
import { createEmptySyncResult } from './sync-result';
import type { SyncHistoryEntry } from './types';
import { normalizeCrateSettings } from '../plugin/settings';
import type { CrateSettings } from '../plugin/settings-types';

function harness(automaticSync = true) {
    const h = { settings: normalizeCrateSettings({ automaticSync }, '.obsidian'), persistSettings: vi.fn(async (_update?: Partial<CrateSettings>) => {}) };
    let current = true;
    const verify = () => { if (!current) throw new Error('Sync connection changed. Reopen history.'); };
    const entry: SyncHistoryEntry = { timestamp: '2026-09-20T10:00:00Z', type: 'sync', success: true,
        uploaded: 1, downloaded: 0, merged: 0, deleted: 0, conflictCount: 0, errorCount: 0, historyCheckpoint: 'a'.repeat(64) };
    h.settings.syncHistory.push(entry);
    const apply = vi.fn(async () => {
        expect(h.settings.automaticSync).toBe(false);
        expect(h.persistSettings).toHaveBeenCalledWith({ automaticSync: false });
    });
    const verifySynced = vi.fn(async () => {});
    const engine = {
        sync: vi.fn(async () => createEmptySyncResult()),
        updateSettings: vi.fn(),
        getPendingPaths: vi.fn(() => [] as string[]),
        syncSelected: vi.fn(async (_keys: string[]) => createEmptySyncResult()),
        createHistoryRestore: vi.fn(async (_id: string, beforeApply: () => Promise<void>) => ({
            items: [{ path: 'note.md', action: 'revert' as const }], unchangedCount: 2,
            preview: async () => ({ current: 'new', saved: 'old' }),
            restore: async () => { await beforeApply(); await apply(); }, verifySynced,
        })),
    };
    return { ...h, engine, entry, apply, verifySynced, disconnect: () => { current = false; },
        prepare: (selected: SyncHistoryEntry) => createRuntimeHistoryRestore({
            engine, settings: h.settings, verify, clearForegroundSyncTimer: vi.fn(), persistSettings: h.persistSettings,
            runSyncOperation: operation => operation(engine, () => {}),
        }, selected) };
}

describe('history restore orchestration', () => {
    it.each([true, false])('persists the pause before writes and restores the previous automatic-sync setting (%s) only after verifying sync', async automaticSync => {
        const h = harness(automaticSync);
        const review = await h.prepare(h.entry);
        expect(await review.preview('note.md')).toEqual({ current: 'new', saved: 'old' });
        expect(h.apply).not.toHaveBeenCalled();
        expect(h.persistSettings).not.toHaveBeenCalled();
        await review.restore();
        expect(h.apply).toHaveBeenCalledOnce();
        expect(h.engine.sync).toHaveBeenCalledOnce();
        expect(h.verifySynced).toHaveBeenCalledOnce();
        expect(h.settings.automaticSync).toBe(automaticSync);
    });

    it.each(['apply', 'sync', 'verify'])('keeps automatic sync off after a failed %s', async step => {
        const h = harness();
        if (step === 'apply') h.apply.mockRejectedValue(new Error('interrupted'));
        if (step === 'sync') h.engine.sync.mockResolvedValue({ ...createEmptySyncResult(), success: false, errors: ['offline'] });
        if (step === 'verify') h.verifySynced.mockRejectedValue(new Error('changed'));
        await expect((await h.prepare(h.entry)).restore()).rejects.toThrow();
        expect(h.settings.automaticSync).toBe(false);
        expect(h.persistSettings).not.toHaveBeenCalledWith({ automaticSync: true });
    });

    it('does not apply a restore when the pause cannot be persisted', async () => {
        const h = harness();
        h.persistSettings.mockRejectedValue(new Error('disk full'));
        await expect((await h.prepare(h.entry)).restore()).rejects.toThrow('disk full');
        expect(h.apply).not.toHaveBeenCalled();
    });

    it('rejects a stale review after changing sync connection', async () => {
        const h = harness();
        const review = await h.prepare(h.entry);
        h.disconnect();
        await expect(review.preview('note.md')).rejects.toThrow('connection changed');
        await expect(review.restore()).rejects.toThrow('connection changed');
        expect(h.apply).not.toHaveBeenCalled();
    });

    it('stops before changing files when the connection changes while persisting the pause', async () => {
        const h = harness();
        let release!: () => void;
        const persisted = new Promise<void>(resolve => { release = resolve; });
        h.persistSettings.mockImplementationOnce(() => persisted);
        const restoring = (await h.prepare(h.entry)).restore();
        h.disconnect();
        release();
        await expect(restoring).rejects.toThrow('connection changed');
        expect(h.apply).not.toHaveBeenCalled();
        expect(h.engine.sync).not.toHaveBeenCalled();
        expect(h.settings.automaticSync).toBe(false);
    });

    it('keeps automatic sync paused if persisting the resumed setting fails', async () => {
        const h = harness();
        h.persistSettings.mockResolvedValueOnce().mockRejectedValueOnce(new Error('disk full'));
        await expect((await h.prepare(h.entry)).restore()).rejects.toThrow('disk full');
        expect(h.verifySynced).toHaveBeenCalledOnce();
        expect(h.settings.automaticSync).toBe(false);
    });

    it('rejects legacy entries without inferring state from their path lists', async () => {
        const h = harness();
        delete h.entry.historyCheckpoint;
        await expect(h.prepare(h.entry)).rejects.toThrow('no complete vault checkpoint');
    });
});
