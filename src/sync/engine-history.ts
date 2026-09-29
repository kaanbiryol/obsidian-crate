import type { Vault } from 'obsidian';
import type { CrateSettings } from '../plugin/settings-types';
import type { FileManifest } from '../protocol/sync-types';
import type { SyncApiClient } from './api';
import { HistoryCheckpoints } from './history-checkpoint';
import type { HistorySnapshot } from './history-comparison';
import { createHistoryRestore } from './history-restore';
import { findHistorySource } from './history-source';
import { normalizeWorkerUrl } from './worker-url';

interface EngineHistoryContext {
  vault: Vault;
  api: SyncApiClient;
  pluginDir: string;
  getSettings(): Pick<CrateSettings, 'workerUrl' | 'ignorePatterns'>;
  getManifest(): FileManifest;
  shouldIgnore: (path: string) => boolean;
  assertActive(): void;
  hasPendingMutations(): boolean;
  canCheckpoint(): boolean;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  applied: (path: string, removed: boolean) => void;
}

/** Checkpoint and restore policy; the engine retains operation/lifecycle authority. */
export function createEngineHistory(context: EngineHistoryContext) {
  const checkpoints = () => new HistoryCheckpoints(context.vault.adapter, `${context.pluginDir}/history-checkpoints`, normalizeWorkerUrl(context.getSettings().workerUrl));
  const load = (id: string, shared: boolean) => shared
    ? context.api.sharedHistory.load(id) : checkpoints().load(id, context.getSettings().ignorePatterns);
  return {
    prune: (retained: string[]) => checkpoints().prune(retained),
    async saveShared() {
      if (!context.canCheckpoint() || context.hasPendingMutations()) return undefined;
      return context.api.sharedHistory.save();
    },
    async saveLocal(): Promise<string | undefined> {
      if (!context.canCheckpoint() || context.hasPendingMutations()) return undefined;
      // Clone synchronously, before another sync can advance the baseline.
      const files = Object.fromEntries(Object.entries(context.getManifest().files)
        .filter(([path]) => !context.shouldIgnore(path)).map(([path, entry]) => [path, { ...entry }]));
      return checkpoints().save(files, [...context.getSettings().ignorePatterns]);
    },
    async loadSnapshot(checkpoint: string, shared: boolean): Promise<HistorySnapshot> {
      context.assertActive();
      const snapshot = await load(checkpoint, shared);
      context.assertActive();
      return { files: snapshot.files, read: async (path, file) => {
        context.assertActive();
        if (snapshot.files[path] !== file) throw new Error('This file is not in the selected sync.');
        const bytes = shared ? await context.api.sharedHistory.download(checkpoint, path, file)
          : await (await findHistorySource(context.api, path, file, (await context.api.getManifest()).files[path]))();
        context.assertActive();
        return bytes;
      } };
    },
    prepareRestore(checkpoint: string, beforeApply: () => Promise<void>, shared: boolean) {
      return context.runExclusive(async () => {
        const scope = JSON.stringify(context.getSettings().ignorePatterns);
        const verify = () => {
          context.assertActive();
          if (scope !== JSON.stringify(context.getSettings().ignorePatterns)) throw new Error('Sync exclusions changed. Review the restore again.');
          if (context.hasPendingMutations()) throw new Error('Finish pending uploads, file restores, and conflict reviews before returning to this state.');
        };
        verify();
        const snapshot = await load(checkpoint, shared);
        const review = await createHistoryRestore({
          vault: context.vault, api: context.api, target: snapshot.files, baseline: context.getManifest().files,
          ...(shared ? { readTarget: (path, file) => context.api.sharedHistory.download(checkpoint, path, file) } : {}),
          recoveryRoot: `${context.pluginDir}/state-recovery`, shouldIgnore: context.shouldIgnore,
          verify, beforeApply, applied: context.applied,
        });
        return { ...review,
          restore: () => context.runExclusive(() => review.restore()),
          verifySynced: () => context.runExclusive(() => review.verifySynced()),
        };
      });
    },
  };
}
