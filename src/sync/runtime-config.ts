import type { Plugin } from "obsidian";
import type { SecretStorageService } from "../plugin/secret-storage";
import { SECRET_KEYS, type CrateSettings, type SharedSettings } from "../plugin/types";
import { requireNormalizedWorkerUrl } from "./worker-url";

interface ApplyInfrastructureConfigInput {
  workerUrl: string;
  authToken: string;
}

export async function deleteManifestFile(plugin: Plugin): Promise<void> {
  const path = `${plugin.manifest.dir}/file-manifest.json`;
  const adapter = plugin.app.vault.adapter;
  try {
    if (await adapter.exists(path)) {
      await adapter.remove(path);
    }
  } catch {
    // best effort
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
  secretStorage.delete(SECRET_KEYS.AUTH_TOKEN);
  settings.workerUrl = "";
}

export function buildSharedSettings(settings: CrateSettings): SharedSettings {
  return {
    ignorePatterns: settings.ignorePatterns,
    syncOnStartup: settings.syncOnStartup,
    syncOnResume: settings.syncOnResume,
    syncInterval: settings.syncInterval,
    showStatusBar: settings.showStatusBar,
    pushEnabled: settings.pushEnabled,
  };
}

export type { ApplyInfrastructureConfigInput };
