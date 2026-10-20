import { registerSharedFeatures } from './feature-settings';
import { Notice } from "obsidian";
import { registerReading } from '../reading/register-integrations';
import { stopReading } from '../reading/runtime';
import { SecretStorageService } from "./secret-storage";
import { createLogger, errorMessage } from "../sync/logger";
import { CrateSettingTab } from "../ui/settings-tab";
import { initializeReminders, ensureReminderNotificationPolicy } from "../reminders/plugin-integration";
import {
  initializeSyncManagers,
  registerSyncCommands,
  registerVaultSyncEventHandlers,
} from "../sync/plugin-integration";
import { ensurePluginDeviceId } from "./deviceId";
import { SECRET_KEYS } from "./settings-types";
import type CratePlugin from "./CratePlugin";
import {
  createCloudflareDeploymentService,
  createCloudflareUsageConnection,
  handleCloudflareOAuthProtocol,
} from "../cloudflare/plugin-integration";
import { showCloudflareServerUpdateNotice } from "../cloudflare/update-notice";
import { beginPluginLifecycle, endPluginLifecycle, setSyncReady } from './lifecycle-state';

import { registerCheckpointBackupCleanup } from '../sync/checkpoint-backup-cleanup';

const logger = createLogger("Plugin");

export async function bootstrapPlugin(plugin: CratePlugin): Promise<void> {
  const signal = beginPluginLifecycle(plugin);
  logger.info("Plugin loaded");

  const coreInitialized = await initializePluginCore(plugin, signal);
  if (!coreInitialized || signal.aborted) {
    return;
  }

  // Start from cached feature settings; registerSharedFeatures applies the
  // server's policy once it responds, without delaying startup when offline.
  registerCheckpointBackupCleanup(plugin, signal);
  plugin.registerSettingsTab(new CrateSettingTab(plugin.app, plugin));
  registerVaultSyncEventHandlers(plugin);
  registerReading(plugin);
  if (plugin.remindersSettings.enabled) {
    await initializePluginReminders(plugin, signal);
  }
  if (signal.aborted) return;
  // Manifest loading and startup sync wait for the workspace so they never
  // delay Obsidian's startup. The runtime reports `initializing` until then.
  const syncReady = new Promise<void>(resolve => {
    plugin.app.workspace.onLayoutReady(() => {
      if (signal.aborted) { resolve(); return; }
      void initializePluginSync(plugin, signal).finally(resolve);
    });
  });
  setSyncReady(plugin, syncReady);
  registerSharedFeatures(plugin);
  showCloudflareServerUpdateNotice(plugin);
  registerPluginCommands(plugin);
  registerPluginProtocols(plugin);
  void reconcileNotificationsAfterStartupSync(plugin, signal, syncReady);
}

export function shutdownPlugin(plugin: CratePlugin): void {
  endPluginLifecycle(plugin);
  stopReading(plugin);
  plugin.syncRuntime?.destroy();
  plugin.cloudflareDeploymentService?.destroy();
  plugin.remindersVaultWatcher?.unregister();
}

async function initializePluginCore(plugin: CratePlugin, signal: AbortSignal): Promise<boolean> {
  try {
    plugin.secretStorage = new SecretStorageService(
      plugin.app,
      () => plugin.settings?.cloudflareDeployment?.deploymentId ?? plugin.settings?.workerUrl ?? null,
    );
    await plugin.loadSettings();
    if (signal.aborted) return false;
    await restoreManagedWorkerConnection(plugin);
    if (signal.aborted) return false;
    plugin.cloudflareDeploymentService = createCloudflareDeploymentService(plugin);
    plugin.cloudflareUsageConnection = createCloudflareUsageConnection(plugin);
    initializeSyncManagers(plugin);
    ensurePluginDeviceId(plugin);
    return true;
  } catch (error) {
    if (signal.aborted) return false;
    shutdownPlugin(plugin);
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

async function initializePluginSync(plugin: CratePlugin, signal: AbortSignal): Promise<void> {
  try {
    if (plugin.syncRuntime.isConfigured()) {
      await plugin.syncRuntime.initialize();
    } else {
      showSetupNotice(plugin);
    }
  } catch (error) {
    if (signal.aborted) return;
    const message = errorMessage(error);
    logger.error("Sync initialization failed:", message);
    new Notice(`Crate sync failed to start: ${message}`);
  }
}

async function reconcileNotificationsAfterStartupSync(plugin: CratePlugin, signal: AbortSignal, syncReady: Promise<void>): Promise<void> {
  try {
    await syncReady;
    if (signal.aborted) return;
    const startupSyncRan = await plugin.syncRuntime.waitForStartupSync();
    if (signal.aborted) return;
    if (!plugin.remindersSettings.enabled || !plugin.reminderIndex) return;
    // Sync writes visible notes through the vault, so the watcher saw each
    // change; scans deferred while syncing are flushed instead of a full reload.
    if (startupSyncRan) {
      await plugin.reminderIndex.flushDeferredScans();
    }
    if (signal.aborted) return;
    await ensureReminderNotificationPolicy(plugin);
  } catch (error) {
    if (signal.aborted) return;
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
    if (!plugin.remindersSettings.enabled) {
      new Notice("Reminders are unavailable. Check your folder in Crate settings.");
      plugin.openSettingsTab();
      return;
    }
    void plugin.activateRemindersView(params.project || undefined).catch((error: unknown) => {
      logger.error("Failed to open reminders:", errorMessage(error));
      new Notice("Could not open reminders. Please try again.");
    });
  });
}

async function initializePluginReminders(plugin: CratePlugin, signal: AbortSignal): Promise<void> {
  try {
    await initializeReminders(plugin);
  } catch (error) {
    if (signal.aborted) return;
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
