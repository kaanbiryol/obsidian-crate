import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHarness, setSyncEngine } from './runtime-test-harness';
import { createEmptySyncResult } from './sync-result';
import type { SyncHistoryEntry } from './types';
import { normalizeCrateSettings } from '../plugin/settings';

function harness(automaticSync = true) {
    const h = createRuntimeHarness({ automaticSync });
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
        initialSync: vi.fn(async () => createEmptySyncResult()),
        forceFullSync: vi.fn(async () => createEmptySyncResult()),
        updateSettings: vi.fn(),
        saveHistoryCheckpoint: vi.fn(async () => 'b'.repeat(64)),
        createHistoryRestore: vi.fn(async (_id: string, beforeApply: () => Promise<void>) => ({
            items: [{ path: 'note.md', action: 'revert' as const }], unchangedCount: 2,
            preview: async () => ({ current: 'new', saved: 'old' }),
            restore: async () => { await beforeApply(); await apply(); }, verifySynced,
        })),
    };
    setSyncEngine(h.runtime, engine);
    return { ...h, engine, entry, apply, verifySynced };
}

describe('history restore orchestration', () => {
    it.each([true, false])('persists the pause before writes and restores the previous automatic-sync setting (%s) only after verifying sync', async automaticSync => {
        const h = harness(automaticSync);
        const review = await h.runtime.createHistoryRestore(h.entry);
        expect(await review.preview('note.md')).toEqual({ current: 'new', saved: 'old' });
        expect(h.apply).not.toHaveBeenCalled();
        expect(h.persistSettings).not.toHaveBeenCalled();
        await review.restore();
        expect(h.apply).toHaveBeenCalledOnce();
        expect(h.engine.sync).toHaveBeenCalledOnce();
        expect(h.verifySynced).toHaveBeenCalledOnce();
        expect(h.settings.automaticSync).toBe(automaticSync);
        expect(h.settings.syncHistory[0]?.historyCheckpoint).toBe('b'.repeat(64));
        expect(normalizeCrateSettings(h.settings, '.obsidian').syncHistory[0]?.historyCheckpoint).toBe('b'.repeat(64));
    });

    it.each(['apply', 'sync', 'verify'])('keeps automatic sync off after a failed %s', async step => {
        const h = harness();
        if (step === 'apply') h.apply.mockRejectedValue(new Error('interrupted'));
        if (step === 'sync') h.engine.sync.mockResolvedValue({ ...createEmptySyncResult(), success: false, errors: ['offline'] });
        if (step === 'verify') h.verifySynced.mockRejectedValue(new Error('changed'));
        await expect((await h.runtime.createHistoryRestore(h.entry)).restore()).rejects.toThrow();
        expect(h.settings.automaticSync).toBe(false);
        expect(h.persistSettings).not.toHaveBeenCalledWith({ automaticSync: true });
    });

    it('does not apply a restore when the pause cannot be persisted', async () => {
        const h = harness();
        h.persistSettings.mockRejectedValue(new Error('disk full'));
        await expect((await h.runtime.createHistoryRestore(h.entry)).restore()).rejects.toThrow('disk full');
        expect(h.apply).not.toHaveBeenCalled();
    });

    it('rejects a stale review after changing sync connection', async () => {
        const h = harness();
        const review = await h.runtime.createHistoryRestore(h.entry);
        setSyncEngine(h.runtime, { ...h.engine });
        await expect(review.preview('note.md')).rejects.toThrow('connection changed');
        await expect(review.restore()).rejects.toThrow('connection changed');
        expect(h.apply).not.toHaveBeenCalled();
    });

    it('rejects legacy entries without inferring state from their path lists', async () => {
        const h = harness();
        delete h.entry.historyCheckpoint;
        await expect(h.runtime.createHistoryRestore(h.entry)).rejects.toThrow('no complete vault checkpoint');
    });
});
