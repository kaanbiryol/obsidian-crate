import { Notice } from "obsidian";
import { SecretStorageService } from "./secret-storage";
import { createLogger, errorMessage } from "./logger";
import { CrateSettingTab } from "../ui/settings-tab";
import { openFullScreenReminderModal } from "../reminders/ui/adapters/modals";
import { initializeReminders, reconcileReminderNotifications } from "../reminders/plugin-integration";
import {
  initializeSyncManagers,
  registerSyncCommands,
  registerVaultSyncEventHandlers,
} from "../sync/plugin-integration";
import { ensurePluginDeviceId } from "./deviceId";
import { SECRET_KEYS } from "./types";
import type CratePlugin from "./CratePlugin";
import {
  createCloudflareDeploymentService,
  handleCloudflareOAuthProtocol,
} from "../cloudflare/plugin-integration";
import { showCloudflareServerUpdateNotice } from "../cloudflare/update-notice";

const logger = createLogger("Plugin");
const activePlugins = new WeakSet<CratePlugin>();

export async function bootstrapPlugin(plugin: CratePlugin): Promise<void> {
  logger.info("Plugin loaded");

  const coreInitialized = await initializePluginCore(plugin);
  if (!coreInitialized) {
    return;
  }
  activePlugins.add(plugin);

  plugin.registerSettingsTab(new CrateSettingTab(plugin.app, plugin));
  registerVaultSyncEventHandlers(plugin);
  await initializePluginReminders(plugin);
  await initializePluginSync(plugin);
  showCloudflareServerUpdateNotice(plugin);
  registerPluginCommands(plugin);
  registerPluginProtocols(plugin);
  void reconcileNotificationsAfterStartupSync(plugin);
}

export function shutdownPlugin(plugin: CratePlugin): void {
  activePlugins.delete(plugin);
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
    plugin.cloudflareDeploymentService = createCloudflareDeploymentService(plugin);
    initializeSyncManagers(plugin);
    ensurePluginDeviceId(plugin);
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

  await plugin.writeSettings({
    workerUrl: `https://${deployment.workerName}.${deployment.workersSubdomain}.workers.dev`,
  });
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

async function reconcileNotificationsAfterStartupSync(plugin: CratePlugin): Promise<void> {
  try {
    const startupSyncRan = await plugin.syncRuntime.waitForStartupSync();
    if (!activePlugins.has(plugin)) return;
    if (startupSyncRan) {
      await plugin.reminderIndex.load();
    }
    if (!activePlugins.has(plugin)) return;
    await reconcileReminderNotifications(plugin);
  } catch (error) {
    logger.warn("Failed to refresh reminders after startup sync:", errorMessage(error));
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
