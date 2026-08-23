import { Notice } from "obsidian";
import { SecretStorageService } from "./secret-storage";
import { createLogger, errorMessage } from "./logger";
import { CrateSettingTab } from "../ui/settings-tab";
import { openFullScreenReminderModal } from "../reminders/ui/adapters/modals";
import { initializeReminders } from "../reminders/plugin-integration";
import {
  initializeSyncManagers,
  registerSyncCommands,
  registerVaultSyncEventHandlers,
} from "../sync/plugin-integration";
import { SyncApiClient } from "../sync/api";
import { ensurePluginDeviceId } from "./deviceId";
import { SECRET_KEYS } from "./types";
import type CratePlugin from "./CratePlugin";
import {
  createCloudflareDeploymentService,
  handleCloudflareOAuthProtocol,
} from "../cloudflare/plugin-integration";

const logger = createLogger("Plugin");

export async function bootstrapPlugin(plugin: CratePlugin): Promise<void> {
  logger.info("Plugin loaded");

  const coreInitialized = await initializePluginCore(plugin);
  if (!coreInitialized) {
    return;
  }

  plugin.registerSettingsTab(new CrateSettingTab(plugin.app, plugin));
  registerVaultSyncEventHandlers(plugin);
  await initializePluginSync(plugin);
  registerPluginCommands(plugin);
  registerPluginProtocols(plugin);
  await initializePluginReminders(plugin);
}

export function shutdownPlugin(plugin: CratePlugin): void {
  plugin.syncRuntime?.destroy();
  plugin.cloudflareDeploymentService?.destroy();
  plugin.remindersVaultWatcher?.unregister();
}

async function initializePluginCore(plugin: CratePlugin): Promise<boolean> {
  try {
    plugin.secretStorage = new SecretStorageService(
      plugin.app,
      () => plugin.settings?.cloudflareDeployment?.deploymentId ?? plugin.settings?.workerUrl ?? null,
    );
    await plugin.loadSettings();
    await restoreManagedWorkerConnection(plugin);
    await migrateLegacyAuthToken(plugin);
    plugin.cloudflareDeploymentService = createCloudflareDeploymentService(plugin);
    initializeSyncManagers(plugin);
    await ensurePluginDeviceId(plugin);
    return true;
  } catch (error) {
    const message = errorMessage(error);
    logger.error("Plugin initialization failed:", message);
    new Notice(`Crate failed to initialize: ${message}`);
    return false;
  }
}

async function restoreManagedWorkerConnection(plugin: CratePlugin): Promise<void> {
  const deployment = plugin.settings?.cloudflareDeployment;
  if (
    plugin.settings?.workerUrl
    || !deployment?.workersSubdomain
    || !plugin.secretStorage.has(SECRET_KEYS.AUTH_TOKEN)
  ) {
    return;
  }

  plugin.settings.workerUrl = `https://${deployment.workerName}.${deployment.workersSubdomain}.workers.dev`;
  await plugin.saveSettings();
}

async function migrateLegacyAuthToken(plugin: CratePlugin): Promise<void> {
  const workerUrl = plugin.settings?.workerUrl;
  if (!workerUrl || plugin.secretStorage.has(SECRET_KEYS.AUTH_TOKEN)) {
    return;
  }

  const legacyToken = plugin.secretStorage.getLegacy(SECRET_KEYS.AUTH_TOKEN);
  if (!legacyToken) {
    return;
  }

  try {
    const connection = await new SyncApiClient(workerUrl, legacyToken).testConnection();
    if (connection.success) {
      plugin.secretStorage.set(SECRET_KEYS.AUTH_TOKEN, legacyToken);
    }
  } catch {
    // Leave the vault disconnected so Cloudflare authorization can repair it.
  }
}

async function initializePluginSync(plugin: CratePlugin): Promise<void> {
  try {
    if (plugin.syncRuntime.isConfigured()) {
      await plugin.syncRuntime.initialize();
    } else {
      showSetupNotice(plugin);
    }
  } catch (error) {
    const message = errorMessage(error);
    logger.error("Sync initialization failed:", message);
    new Notice(`Crate sync failed to start: ${message}`);
  }
}

function registerPluginCommands(plugin: CratePlugin): void {
  registerSyncCommands(plugin);
}

function registerPluginProtocols(plugin: CratePlugin): void {
  plugin.registerObsidianProtocolHandler("crate-cloudflare-oauth", (params) => {
    void handleCloudflareOAuthProtocol(plugin, params);
  });
  plugin.registerObsidianProtocolHandler("crate-reminders", (params) => {
    openFullScreenReminderModal(plugin, params.project || undefined);
  });
}

async function initializePluginReminders(plugin: CratePlugin): Promise<void> {
  try {
    await initializeReminders(plugin);
  } catch (error) {
    const message = errorMessage(error);
    logger.error("Reminders initialization failed:", message);
    new Notice(`Reminders failed to initialize: ${message}`);
  }
}

function showSetupNotice(plugin: CratePlugin): void {
  const fragment = new DocumentFragment();
  fragment.createSpan({ text: "Crate is not configured. " });
  const link = fragment.createEl("a", { text: "Open settings" });
  link.addEventListener("click", () => {
    plugin.openSettingsTab();
  });
  fragment.createSpan({ text: " to set up sync." });
  new Notice(fragment, 10000);
}
