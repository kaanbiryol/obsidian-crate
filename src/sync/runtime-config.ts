import type { Plugin } from "obsidian";
import type { SecretStorageService } from "../plugin/secret-storage";
import { SECRET_KEYS, type CrateSettings, type SharedSettings } from "../plugin/types";
import { requireNormalizedWorkerUrl } from "./worker-url";

interface ApplyInfrastructureConfigInput {
  workerUrl: string;
  authToken: string;
  workerName: string;
  bucketName: string;
  databaseId: string;
  accountId?: string;
}

interface ClearSyncConfigurationOptions {
  clearCloudflareCredentials?: boolean;
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
  settings.workerName = config.workerName.trim();
  settings.bucketName = config.bucketName.trim();
  settings.databaseId = config.databaseId.trim();
  settings.cloudflareAccountId = config.accountId?.trim() || "";
  secretStorage.set(SECRET_KEYS.AUTH_TOKEN, authToken);
}

export function clearSyncConfigurationState(
  settings: CrateSettings,
  secretStorage: SecretStorageService,
  options?: ClearSyncConfigurationOptions,
): void {
  settings.workerUrl = "";
  settings.workerName = "";
  settings.bucketName = "";
  settings.databaseId = "";
  secretStorage.delete(SECRET_KEYS.AUTH_TOKEN);

  if (options?.clearCloudflareCredentials) {
    settings.cloudflareAccountId = "";
    secretStorage.delete(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
  }
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

export type { ApplyInfrastructureConfigInput, ClearSyncConfigurationOptions };
