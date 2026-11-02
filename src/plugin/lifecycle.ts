import { registerSharedFeatures } from './feature-settings';
import { sharedSettingsSync } from './shared-settings-sync';
import { Notice, Platform } from "obsidian";
import { registerReading } from '../reading/register-integrations';
import { stopReading } from '../reading/runtime';
import { SecretStorageService } from "./secret-storage";
import { createLogger } from "../sync/logger";
import { errorMessage } from "../platform/logger";
import { CrateSettingTab } from "../ui/settings/settings-tab";
import { activateRemindersView, initializeReminders } from "../reminders/plugin-integration";
import { ensureReminderNotificationPolicy } from "../reminders/notification-policy-sync";
import {
	initializeSyncManagers,
	registerSyncCommands,
	registerVaultSyncEventHandlers,
} from "./sync-integration";
import { ensurePluginDeviceId } from "./device-identity";
import type CratePlugin from "./CratePlugin";
import { handleCloudflareOAuthProtocol } from "./cloudflare/operations";
import { showCloudflareServerUpdateNotice } from "../ui/cloudflare/update-notice";
import { showGetStartedNotice } from "../ui/settings/get-started-notice";
import { beginPluginLifecycle, endPluginLifecycle, getPluginLifecycleSignal, setSyncReady } from './lifecycle-state';
import { CloudflareSavedLogin } from '../cloudflare/oauth/saved-login';
import { CloudflareDeploymentService } from '../cloudflare/deployment/service';
import { loadEmbeddedCloudflareArtifacts } from '../cloudflare/deployment/embedded-artifacts';
import { cloudflareHttpTransport } from '../cloudflare/http';
import { CLOUDFLARE_OAUTH_CLIENT_ID } from '../cloudflare/oauth/config';
import { openCloudflareAuthorizationModal } from '../ui/cloudflare/authorization-modal';
import { clearServerConnection } from './sync-connection';

import { registerCheckpointBackupCleanup } from '../sync/durability/checkpoint-backup-cleanup';
import { registerCrateUpdateSync } from './crate-update-sync';
import { SECRET_KEYS } from "../platform/secret-keys";
import { workersDevOrigin } from "../cloudflare/deployment/worker-origin";

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
	registerCrateUpdateSync(plugin, signal, syncReady);
	registerSharedFeatures(plugin);
	showCloudflareServerUpdateNotice(plugin);
	showGetStartedNotice(plugin);
	registerSyncCommands(plugin);
	registerPluginProtocols(plugin);
	void reconcileNotificationsAfterStartupSync(plugin, signal, syncReady);
}

export function shutdownPlugin(plugin: CratePlugin): void {
	endPluginLifecycle(plugin);
	stopReading(plugin);
	plugin.syncRuntime?.destroy();
	plugin.cloudflareDeploymentService?.destroy();
	plugin.reminders?.watcher.unregister();
}

function createCloudflareSavedLogin(plugin: CratePlugin): CloudflareSavedLogin {
	return new CloudflareSavedLogin({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		transport: cloudflareHttpTransport,
		secrets: plugin.secretStorage,
		cache: {
			read: () => plugin.settings.usageSnapshot ?? null,
			write: snapshot => plugin.writeSettings({ usageSnapshot: snapshot }),
		},
		accountId: () => plugin.settings.cloudflareDeployment?.accountId,
		signal: getPluginLifecycleSignal(plugin),
	});
}

function createCloudflareDeploymentService(plugin: CratePlugin): CloudflareDeploymentService {
	const signal = getPluginLifecycleSignal(plugin);
	return new CloudflareDeploymentService({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		getVaultName: () => plugin.app.vault.getName(),
		settingsOwner: plugin,
		onAuthorized: (accountId, tokens) => plugin.cloudflareSavedLogin.acceptAuthorization(accountId, tokens),
		withAuthorization: operation => plugin.cloudflareSavedLogin.withAuthorization(operation),
		transport: cloudflareHttpTransport,
		loadArtifacts: loadEmbeddedCloudflareArtifacts,
		openExternal: url => openCloudflareAuthorization(plugin, url),
		serverChangesAllowed: !Platform.isMobile,
		beforeServerSwitch: async () => {
			await clearServerConnection(plugin, signal);
			plugin.refreshSettingsTab();
		},
		beforeServerReset: async () => {
			signal.throwIfAborted();
			await clearServerConnection(plugin, signal);
			signal.throwIfAborted();
			plugin.refreshSettingsTab();
		},
	});
}

function openCloudflareAuthorization(plugin: CratePlugin, url: string): void {
	if (Platform.isMobile) {
		openCloudflareAuthorizationModal(plugin.app, url, getPluginLifecycleSignal(plugin));
		return;
	}
	window.open(url, '_blank', 'noopener,noreferrer');
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
		plugin.cloudflareSavedLogin = createCloudflareSavedLogin(plugin);
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
		workerUrl: workersDevOrigin(deployment.workerName, deployment.workersSubdomain),
	});
}

async function initializePluginSync(plugin: CratePlugin, signal: AbortSignal): Promise<void> {
	try {
		if (plugin.syncRuntime.isConfigured()) {
			await plugin.syncRuntime.initialize();
			// The API client exists only now, so the pull during onload could not reach the server.
			if (!signal.aborted) void sharedSettingsSync(plugin).pull();
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
		if (!plugin.remindersSettings.enabled || !plugin.reminders) return;
		// Sync writes visible notes through the vault, so the watcher saw each
		// change; scans deferred while syncing are flushed instead of a full reload.
		if (startupSyncRan) {
			await plugin.reminders.index.flushDeferredScans();
		}
		if (signal.aborted) return;
		await ensureReminderNotificationPolicy(plugin);
	} catch (error) {
		if (signal.aborted) return;
		logger.warn("Failed to refresh reminders after startup sync:", errorMessage(error));
	}
}

function registerPluginProtocols(plugin: CratePlugin): void {
	plugin.registerObsidianProtocolHandler("crate-cloudflare-oauth", (params) => {
		void handleCloudflareOAuthProtocol(plugin, params);
	});
	plugin.registerObsidianProtocolHandler("crate-pair", (params) => {
		void import('./device-pairing').then(({ handleDevicePairingProtocol }) => handleDevicePairingProtocol(plugin, params));
	});
	plugin.registerObsidianProtocolHandler("crate-reminders", (params) => {
		if (!plugin.remindersSettings.enabled) {
			new Notice("Reminders are unavailable. Check your folder in Crate settings.");
			plugin.openSettingsTab();
			return;
		}
		void activateRemindersView(plugin, params.project || undefined).catch((error: unknown) => {
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
