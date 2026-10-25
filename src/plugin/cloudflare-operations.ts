import { CloudflareOperationPresentation } from '../ui/cloudflare/operation-presentation';
import { ResetBlockedError } from '../cloudflare/server-reset/reset-errors';
import { supportsSavedAuthorization, type CloudflareDeploymentResult, type DeploymentIntent, type SavedDeploymentIntent } from '../cloudflare/deployment/types';
import type { CloudflareAuthorizedDevice } from '../cloudflare/deployment/device-registration';
import type { ConnectionTestResult } from '../sync/types';
import { SyncApiClient, HttpError } from '../sync/worker-api/client';
import { checkAndRecoverUpdate } from '../ui/cloudflare/recovery-ui';
import { DeploymentRecoveryRequiredError } from '../cloudflare/deployment/fence';
import { Notice, Platform } from 'obsidian';
import { CloudflareReauthorizationRequired } from '../cloudflare/oauth/client';
import { CloudflareUsageConnection } from '../cloudflare/usage/connection';
import type CratePlugin from './CratePlugin';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { CloudflareDeploymentService } from '../cloudflare/deployment/service';
import { loadEmbeddedCloudflareArtifacts } from '../cloudflare/deployment/embedded-artifacts';
import { obsidianHttpTransport } from '../cloudflare/http';
import { configureCloudflareAuthorizedDevice } from './cloudflare-connection';
import { isSelfHostedConnectionPending } from './self-hosted-connection';
import { generateSecureToken, hashToken } from '../cloudflare/device-token';
import { getCurrentDeviceName, getCurrentPlatformCode } from './deviceInfo';
import { openCloudflareDeploymentModal, revealCloudflareOperation, type CloudflareDeploymentModal } from '../ui/cloudflare/deployment-modal';
import { dismissCloudflareAuthorizationModal, openCloudflareAuthorizationModal } from '../ui/cloudflare/authorization-modal';
import {
	CLOUDFLARE_OAUTH_CLIENT_ID,
	isCloudflareOAuthConfigured,
} from '../cloudflare/oauth/config';
import { SECRET_KEYS } from '../platform/secret-keys';
import { stableJson } from '../platform/stable-json';

export function createCloudflareUsageConnection(plugin: CratePlugin): CloudflareUsageConnection {
	return new CloudflareUsageConnection({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		transport: obsidianHttpTransport,
		secrets: plugin.secretStorage,
		cache: {
			read: () => plugin.settings.usageSnapshot ?? null,
			write: snapshot => plugin.writeSettings({ usageSnapshot: snapshot }),
		},
		accountId: () => plugin.settings.cloudflareDeployment?.accountId,
		signal: getPluginLifecycleSignal(plugin),
	});
}

export function createCloudflareDeploymentService(plugin: CratePlugin): CloudflareDeploymentService {
	const signal = getPluginLifecycleSignal(plugin);
	return new CloudflareDeploymentService({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		getVaultName: () => plugin.app.vault.getName(),
		settingsOwner: plugin,
		onAuthorized: (accountId, tokens) => plugin.cloudflareUsageConnection.acceptAuthorization(accountId, tokens),
		transport: obsidianHttpTransport,
		loadArtifacts: loadEmbeddedCloudflareArtifacts,
		openExternal: url => openCloudflareAuthorization(plugin, url),
		// Every operation passes its deployment dialog's own server picker.
		selectDeployment: () => Promise.reject(new Error('Choose a server in the Cloudflare deployment dialog.')),
		beforeServerSwitch: async () => {
			plugin.clearSettingsUiState();
			await plugin.syncRuntime.clearSyncConfiguration(signal);
			plugin.refreshSettingsTab();
		},
		beforeServerReset: async () => {
			signal.throwIfAborted();
			plugin.clearSettingsUiState();
			await plugin.syncRuntime.clearSyncConfiguration(signal);
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

export async function startCloudflareDeployment(plugin: CratePlugin, intent?: Exclude<DeploymentIntent, 'connect'>): Promise<void> {
	if (isSelfHostedConnectionPending(plugin)) {
		new Notice('Wait for the connection to your server to finish.');
		return;
	}
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	if (revealCloudflareOperation(plugin.app, plugin.getSettingsDocument())) return;
	if (!isCloudflareOAuthConfigured()) {
		new Notice('This build has no Cloudflare deployment client configured');
		return;
	}
	try {
		const selectedIntent = intent ?? (plugin.syncRuntime.isConfigured() ? 'update' : 'connect');
		if (supportsSavedAuthorization(selectedIntent) && plugin.settings.cloudflareDeployment?.accountId) {
			await runCloudflareOperation(plugin, {}, selectedIntent);
			return;
		}
		await plugin.cloudflareDeploymentService.startDeployment(selectedIntent);
	} catch (error) {
		if (signal.aborted) return;
		new Notice(`Could not start Cloudflare deployment: ${deploymentErrorMessage(error)}`);
	}
}

export async function handleCloudflareOAuthProtocol(
	plugin: CratePlugin,
	params: Record<string, string>,
): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	dismissCloudflareAuthorizationModal(plugin.app);
	plugin.openSettingsTab();
	await runCloudflareOperation(plugin, params);
}

const runningOperations = new WeakSet<CratePlugin>();

async function runCloudflareOperation(
	plugin: CratePlugin, params: Record<string, string>, savedIntent?: SavedDeploymentIntent,
): Promise<void> {
	if (runningOperations.has(plugin)) return;
	runningOperations.add(plugin);
	try { await executeCloudflareOperation(plugin, params, savedIntent); }
	finally { runningOperations.delete(plugin); }
}

/** Everything one Cloudflare operation decides up front and its steps share. */
interface CloudflareOperation {
	plugin: CratePlugin;
	signal: AbortSignal;
	params: Record<string, string>;
	savedIntent?: SavedDeploymentIntent;
	intent: DeploymentIntent | null | undefined;
	isReconnect: boolean;
	shouldConnectDevice: boolean;
	originalDeployment: string;
	originalWorkerUrl: string;
	originalToken: string | null;
	progress: CloudflareDeploymentModal;
	presentation: CloudflareOperationPresentation;
}

/** The credential this device connects with: a new one, or the reconnecting device's own. */
interface DeviceCredential {
	deviceToken: string | null;
	existingToken: string | null;
	device?: CloudflareAuthorizedDevice;
}

async function executeCloudflareOperation(
	plugin: CratePlugin, params: Record<string, string>, savedIntent?: SavedDeploymentIntent,
): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	if (revealCloudflareOperation(plugin.app, plugin.getSettingsDocument())) return;
	if (plugin.cloudflareDeploymentService.isBusy) {
		new Notice('A Cloudflare operation is still running. Wait for its result before starting another.');
		return;
	}
	const operation = beginOperation(plugin, signal, params, savedIntent);
	const accountId = plugin.settings.cloudflareDeployment?.accountId;
	let credential: DeviceCredential;
	let deployment: CloudflareDeploymentResult;
	try {
		credential = await prepareDevice(operation);
		if (signal.aborted) return;
		if ((savedIntent || operation.isReconnect) && operation.originalDeployment !== stableJson(plugin.settings.cloudflareDeployment)) throw new Error('Server settings changed. Confirm the operation again.');
		deployment = await runDeployment(operation, credential.device);
	} catch (error) {
		await handleDeploymentFailure(operation, error);
		return;
	}
	if (signal.aborted) return;

	if (deployment.status === 'deleted') {
		// This vault no longer has a server, so drop its account-wide management login.
		if (accountId) await plugin.cloudflareUsageConnection.forget(accountId);
		plugin.refreshSettingsTab();
		operation.presentation.deleted();
		return;
	}

	if (!operation.shouldConnectDevice) {
		plugin.refreshSettingsTab();
		operation.presentation.updated();
		return;
	}
	await connectDevice(operation, deployment.workerUrl, credential);
}

function beginOperation(
	plugin: CratePlugin, signal: AbortSignal, params: Record<string, string>, savedIntent?: SavedDeploymentIntent,
): CloudflareOperation {
	const intent = savedIntent ?? plugin.cloudflareDeploymentService.pendingIntent;
	const isReconnect = intent === 'reconnect';
	const isSwitch = ['switch', 'create'].includes(intent ?? '');
	const shouldConnectDevice = intent !== 'delete' && (isReconnect || isSwitch || intent === 'reset' || !plugin.syncRuntime.isConfigured());
	const originalDeployment = stableJson(plugin.settings.cloudflareDeployment);
	const originalWorkerUrl = plugin.settings.workerUrl;
	const originalToken = isReconnect ? plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) : null;
	const progress = openCloudflareDeploymentModal(
		plugin.app,
		shouldConnectDevice ? 'setup' : 'update',
		plugin.getSettingsDocument(),
		signal,
	);
	const presentation = new CloudflareOperationPresentation(progress, {
		intent, shouldConnectDevice, openSettings: () => plugin.openSettingsTab(),
		recoverUpdate: () => { void checkAndRecoverUpdate(plugin, () => { void startCloudflareDeployment(plugin, 'update'); }); },
	});
	presentation.start();
	return {
		plugin, signal, params, savedIntent, intent, isReconnect, shouldConnectDevice,
		originalDeployment, originalWorkerUrl, originalToken, progress, presentation,
	};
}

/** Reconnect keeps a still-valid device token; every other connecting operation registers a new one. */
async function prepareDevice({ plugin, signal, isReconnect, shouldConnectDevice, originalToken, presentation }: CloudflareOperation): Promise<DeviceCredential> {
	let existingToken: string | null = null;
	if (isReconnect) {
		presentation.checkingAccess();
		existingToken = originalToken;
		if (existingToken) {
			const api = new SyncApiClient(plugin.settings.workerUrl, existingToken);
			api.setAbortSignal(signal);
			try { await api.listTokens(); }
			catch (error) {
				if (!(error instanceof HttpError) || error.status !== 401) throw error;
				existingToken = null;
			}
		}
	}
	const deviceToken = shouldConnectDevice && !existingToken ? generateSecureToken() : null;
	const device = deviceToken ? {
		tokenHash: await hashToken(deviceToken),
		deviceId: plugin.settings.deviceId,
		deviceName: getCurrentDeviceName(plugin.settings.deviceId),
		platform: getCurrentPlatformCode(),
	} : undefined;
	return { deviceToken, existingToken, device };
}

function runDeployment(
	{ plugin, signal, params, savedIntent, progress, presentation }: CloudflareOperation, device?: CloudflareAuthorizedDevice,
): Promise<CloudflareDeploymentResult> {
	const onProgress = (message: string) => {
		if (!signal.aborted) presentation.advance(message);
	};
	const selectDeployment = (deployments: Parameters<typeof progress.selectVault>[0], missingServer?: boolean) => progress.selectVault(deployments, missingServer);
	return savedIntent
		? plugin.cloudflareDeploymentService.deployWithSavedAuthorization(savedIntent,
			operation => plugin.cloudflareUsageConnection.withAuthorization(operation), device, onProgress, selectDeployment)
		: plugin.cloudflareDeploymentService.handleCallback(params, device, onProgress, selectDeployment);
}

async function handleDeploymentFailure({ plugin, signal, savedIntent, intent, progress, presentation }: CloudflareOperation, error: unknown): Promise<void> {
	if (signal.aborted) return;
	if (savedIntent && error instanceof CloudflareReauthorizationRequired) {
		try {
			await plugin.cloudflareDeploymentService.startDeployment(savedIntent);
			if (!signal.aborted) progress.dismiss();
		} catch (authorizationError) {
			if (!signal.aborted) presentation.authorizationFailed(deploymentErrorMessage(authorizationError));
		}
		return;
	}
	const needsReview = error instanceof DeploymentRecoveryRequiredError;
	if (needsReview || intent === 'delete' || intent === 'reset') plugin.refreshSettingsTab();
	presentation.operationFailed(deploymentErrorMessage(error), {
		needsReview,
		canResumeDeletion: Boolean(plugin.settings.cloudflareDeployment?.deletion || plugin.settings.cloudflareDeployment?.reset?.deleteOnly),
		resetBlocked: error instanceof ResetBlockedError,
	});
}

/** Reconnect must not overwrite a connection the user changed while it ran. */
function assertDeviceConnectionUnchanged({ plugin, isReconnect, originalWorkerUrl, originalToken }: CloudflareOperation): void {
	if (isReconnect && (plugin.settings.workerUrl !== originalWorkerUrl || plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== originalToken)) throw new Error('The device connection changed. Select Reconnect again.');
}

async function connectDevice(operation: CloudflareOperation, workerUrl: string, { deviceToken, existingToken }: DeviceCredential): Promise<void> {
	const { plugin, signal, isReconnect, originalWorkerUrl, originalToken, presentation } = operation;
	presentation.connecting();
	let connection: ConnectionTestResult;
	try {
		assertDeviceConnectionUnchanged(operation);
		const token = deviceToken ?? existingToken;
		if (!token) throw new Error('Device credential was not created');
		if (isReconnect) {
			const api = new SyncApiClient(workerUrl, token);
			api.setAbortSignal(signal);
			await api.listTokens();
			const check = await api.testConnection();
			if (!check.success) throw new Error(check.error || 'Could not verify the connection.');
		}
		// Verification awaited the network, so check again before saving.
		assertDeviceConnectionUnchanged(operation);
		if (isReconnect && !deviceToken && workerUrl === originalWorkerUrl) connection = { success: true };
		else {
			connection = await configureCloudflareAuthorizedDevice(plugin, workerUrl, token, ...(isReconnect ? [{ workerUrl: originalWorkerUrl, authToken: originalToken || '' }] : []));
		}
	} catch (error) {
		if (signal.aborted) return;
		plugin.refreshSettingsTab();
		presentation.connectionFailed(deploymentErrorMessage(error));
		return;
	}
	if (signal.aborted) return;

	plugin.refreshSettingsTab();
	presentation.connected(connection);
}

function deploymentErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown deployment error';
}
