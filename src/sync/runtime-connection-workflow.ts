import { ConnectionSetupError } from './connection-errors';
import { saveEncryptionKeys } from '../plugin/encryption-storage';
import { createLogger } from '../plugin/logger';
import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS, type CrateSettings } from '../plugin/settings-types';
import type { SyncApiClient } from './api';
import type { RuntimeConfigurationTransition } from './runtime';
import { applyInfrastructureConfigState, clearSyncConfigurationState, type ApplyInfrastructureConfigInput } from './runtime-config';
import { resetStoredSyncState } from './runtime-history';
import { normalizeWorkerUrl, requireNormalizedWorkerUrl } from './worker-url';

const logger = createLogger('SyncRuntime');

interface ConnectionWorkflowContext {
	settings: CrateSettings;
	secretStorage: SecretStorageService;
	transition: RuntimeConfigurationTransition;
	persistSettings: () => Promise<void>;
	clearLocalState: () => Promise<void>;
	api: Pick<SyncApiClient, 'setAbortSignal' | 'revokeCurrentToken'> | null;
}

export async function changeServerConnection(
	{ settings, secretStorage, transition, persistSettings, clearLocalState }: ConnectionWorkflowContext,
	config: ApplyInfrastructureConfigInput,
	expected?: ApplyInfrastructureConfigInput,
): Promise<void> {
	transition.verify();
	if (secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) throw new Error('Resume the encrypted folder move before changing this device’s connection.');
	if (secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('Resume the encryption reset before changing this device’s connection.');
	if (expected && (settings.workerUrl !== expected.workerUrl || secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== expected.authToken)) {
		throw new ConnectionSetupError('changed');
	}
	const workerUrl = requireNormalizedWorkerUrl(config.workerUrl);
	if (!config.authToken.trim()) throw new Error('Auth token is required');
	const changingServer = workerUrl !== normalizeWorkerUrl(settings.workerUrl);
	transition.stop();
	await transition.waitForIdle();
	transition.verify();
	if (changingServer) await clearLocalState();
	transition.verify();
	applyInfrastructureConfigState(settings, secretStorage, { ...config, workerUrl });
	if (config.encryption) saveEncryptionKeys(secretStorage, config.encryption.bundle, config.encryption.recovery);
	if (changingServer) resetStoredSyncState(settings);
	await persistSettings();
	await transition.initialize();
}

export async function disconnectServerConnection(
	{ settings, secretStorage, transition, persistSettings, clearLocalState, api }: ConnectionWorkflowContext,
	signal?: AbortSignal,
): Promise<void> {
	transition.verify();
	if (secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) throw new Error('Resume the encrypted folder move before disconnecting this device.');
	if (secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('Resume the encryption reset before disconnecting this device.');
	transition.stop();
	await transition.waitForIdle();
	transition.verify();
	try {
		// The stopped engine aborted this client. Revocation is a separate,
		// explicitly requested operation after all old work has settled.
		api?.setAbortSignal(signal ?? new AbortController().signal);
		await api?.revokeCurrentToken();
	} catch (error) {
		logger.warn('Failed to revoke the current device credential:', error);
	}
	transition.verify();
	await clearLocalState();
	transition.verify();
	resetStoredSyncState(settings);
	clearSyncConfigurationState(settings, secretStorage);
	await persistSettings();
}
