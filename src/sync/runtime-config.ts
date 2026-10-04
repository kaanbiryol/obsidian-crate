import type { Plugin } from "obsidian";
import type { SecretStorageService } from "../plugin/secret-storage";
import { SECRET_KEYS, type CrateSettings, type SharedSettings } from '../plugin/settings-types';
import { requireNormalizedWorkerUrl } from "./worker-url";
import type { VaultKeyBundle } from '../encryption/key-bundle';

interface ApplyInfrastructureConfigInput {
  workerUrl: string;
  authToken: string;
  encryption?: { bundle: VaultKeyBundle; recovery: string };
}

/** Caller must stop the old engine and await its checkpoint I/O first. */
export async function deleteManifestFile(plugin: Plugin, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const adapter = plugin.app.vault.adapter;
  const mainPath = `${plugin.manifest.dir}/file-manifest.json`;
  const checkpoints: Array<{ path: string; content: string; backupPath?: string }> = [];
  for (const path of [mainPath, `${mainPath}.tmp`]) {
    if (await adapter.exists(path)) {
      signal?.throwIfAborted();
      checkpoints.push({ path, content: await adapter.read(path) });
    }
    signal?.throwIfAborted();
  }
  const journalDirectory = `${plugin.manifest.dir}/pending-uploads`;
  if (await adapter.exists(journalDirectory)) {
    const listing = await adapter.list(journalDirectory);
    for (const path of listing.files) {
      signal?.throwIfAborted();
      checkpoints.push({ path, content: await adapter.read(path), backupPath: `${plugin.manifest.dir}/upload-${path.split('/').at(-1)!}` });
    }
  }
  // Preserve both generations for investigation/recovery before invalidating
  // either. These copies are never candidates for normal checkpoint recovery.
  const recoveryId = crypto.randomUUID();
  for (const checkpoint of checkpoints) {
    signal?.throwIfAborted();
    const backup = `${checkpoint.backupPath ?? checkpoint.path}.previous-${recoveryId}`;
    await adapter.write(backup, checkpoint.content);
    signal?.throwIfAborted();
    if (await adapter.read(backup) !== checkpoint.content) throw new Error('Could not verify the previous sync checkpoint backup');
  }
  for (const checkpoint of checkpoints) {
    signal?.throwIfAborted();
    await adapter.remove(checkpoint.path);
    signal?.throwIfAborted();
    if (await adapter.exists(checkpoint.path)) throw new Error('Could not invalidate the previous sync checkpoint');
  }
}

export function applyInfrastructureConfigState(
  settings: CrateSettings,
  secretStorage: SecretStorageService,
  config: ApplyInfrastructureConfigInput,
): void {
  const authToken = config.authToken.trim();
  if (!authToken) {
    throw new Error("Auth token is required");
  }

  settings.workerUrl = requireNormalizedWorkerUrl(config.workerUrl);
  secretStorage.set(SECRET_KEYS.AUTH_TOKEN, authToken);
}

export function clearSyncConfigurationState(
  settings: CrateSettings,
  secretStorage: SecretStorageService,
): void {
  for (const key of [SECRET_KEYS.ENCRYPTION_KEYS, SECRET_KEYS.ENCRYPTION_RECOVERY, SECRET_KEYS.AUTH_TOKEN]) {
    secretStorage.delete(key);
    if (secretStorage.get(key)) throw new Error('Could not remove this device’s previous sync credentials');
  }
  settings.workerUrl = "";
}

export function buildSharedSettings(settings: CrateSettings): SharedSettings {
  return {
    ignorePatterns: settings.ignorePatterns,
    syncOnStartup: settings.syncOnStartup,
    syncOnResume: settings.syncOnResume,
    syncInterval: settings.syncInterval,
    pushEnabled: settings.pushEnabled,
  };
}

export type { ApplyInfrastructureConfigInput };
