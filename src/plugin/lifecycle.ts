import { Notice } from "obsidian";
import { SecretStorageService } from "./secret-storage";
import { createLogger, errorMessage } from "./logger";
import { CrateSettingTab } from "../ui/settings-tab";
import { openFullScreenReminderModal } from "../reminders/ui/modals";
import { initializeReminders } from "../reminders/plugin-integration";
import {
  handleSyncSetupProtocol,
  initializeSyncManagers,
  registerSyncCommands,
  registerVaultSyncEventHandlers,
} from "../sync/plugin-integration";
import { ensurePluginDeviceId } from "./deviceId";
import type CratePlugin from "./CratePlugin";

const logger = createLogger("Plugin");

export async function bootstrapPlugin(plugin: CratePlugin): Promise<void> {
  logger.info("Plugin loaded");

  const coreInitialized = await initializePluginCore(plugin);
  if (!coreInitialized) {
    return;
  }

  plugin.addSettingTab(new CrateSettingTab(plugin.app, plugin));
  registerVaultSyncEventHandlers(plugin);
  await initializePluginSync(plugin);
  registerPluginCommands(plugin);
  registerPluginProtocols(plugin);
  await initializePluginReminders(plugin);
}

export function shutdownPlugin(plugin: CratePlugin): void {
  plugin.syncRuntime?.destroy();
  plugin.remindersVaultWatcher?.unregister();
}

async function initializePluginCore(plugin: CratePlugin): Promise<boolean> {
  try {
    plugin.secretStorage = new SecretStorageService(plugin.app);
    await plugin.loadSettings();
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
  plugin.registerObsidianProtocolHandler("crate-setup", (params) => {
    void handleSyncSetupProtocol(plugin, params);
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
  type AppWithSettings = CratePlugin["app"] & {
    setting: {
      open: () => void;
      openTabById: (id: string) => void;
    };
  };

  const fragment = new DocumentFragment();
  fragment.createSpan({ text: "Crate is not configured. " });
  const link = fragment.createEl("a", { text: "Open settings" });
  link.addEventListener("click", () => {
    const settings = (plugin.app as AppWithSettings).setting;
    settings.open();
    settings.openTabById(plugin.manifest.id);
  });
  fragment.createSpan({ text: " to set up sync." });
  new Notice(fragment, 10000);
}
