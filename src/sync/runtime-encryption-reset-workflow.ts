import type { EncryptionServerState } from '../encryption/server-state';
import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS, type CrateSettings } from '../plugin/settings-types';
import { createEncryptionReset, loadEncryptionReset, saveEncryptionReset, resetRemoteEncryption, EncryptionResetRejectedError } from './encryption-reset';
import type { SyncEngine } from './engine';
import type { RuntimeConfigurationTransition } from './runtime';
import { resetStoredSyncState } from './runtime-history';
import { WorkerApiHttpClient } from './worker-api/http';

interface EncryptionResetContext {
	settings: CrateSettings;
	secretStorage: SecretStorageService;
	transition: RuntimeConfigurationTransition;
	persistSettings: (update?: Partial<CrateSettings>) => Promise<void>;
	clearLocalState: () => Promise<void>;
	getResetEngine: () => Pick<SyncEngine, 'sync' | 'updateSettings'>;
	pushSharedSettings: () => Promise<boolean>;
	resumeEvents: () => void;
	reportError: (message: string) => void;
}

/** Keep remote reset, local invalidation and reconciliation in their durable order. */
export async function runEncryptionReset(
	{ settings, secretStorage, transition, persistSettings, clearLocalState, getResetEngine, pushSharedSettings, resumeEvents, reportError }: EncryptionResetContext,
	state: EncryptionServerState | null, progress: (message: string) => void,
	expected: { workerUrl: string; authToken: string }, signal?: AbortSignal,
): Promise<void> {
	const { verify } = transition;
	signal?.throwIfAborted();
	if (secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) throw new Error('Resume the encrypted folder move before turning encryption off.');
	if (expected.workerUrl !== settings.workerUrl || expected.authToken !== secretStorage.get(SECRET_KEYS.AUTH_TOKEN)) {
		throw new Error('The server connection changed. Reopen Manage encryption.');
	}
	let reset = loadEncryptionReset(secretStorage);
	if (reset && (reset.workerUrl !== settings.workerUrl || ![reset.oldToken, reset.replacementToken].includes(expected.authToken))) {
		throw new Error('Reconnect the original server before resuming this reset');
	}
	if (!reset) {
		if (!state) throw new Error('No encryption reset is pending');
		const probe = new WorkerApiHttpClient(expected.workerUrl, expected.authToken);
		if (signal) probe.setAbortSignal(signal);
		if (!(await probe.getServerInfo()).capabilities.includes('e2ee-reset-v1')) throw new Error('Update your Crate server before turning encryption off');
		verify();
		if (expected.workerUrl !== settings.workerUrl || expected.authToken !== secretStorage.get(SECRET_KEYS.AUTH_TOKEN)) throw new Error('The server connection changed. Reopen Manage encryption.');
		reset = createEncryptionReset(settings.workerUrl, expected.authToken, state, settings.automaticSync);
		saveEncryptionReset(secretStorage, reset);
	}
	transition.stop();
	try {
		await transition.waitForIdle();
		verify();
		settings.automaticSync = false;
		await persistSettings({ automaticSync: false });
		verify();
		if (reset.phase === 'remote') {
			await resetRemoteEncryption(reset, progress, verify, token => {
				const http = new WorkerApiHttpClient(expected.workerUrl, token);
				if (signal) http.setAbortSignal(signal);
				return http;
			}, checkpoint => saveEncryptionReset(secretStorage, checkpoint));
			verify();
			reset = { ...reset, phase: 'local' };
			saveEncryptionReset(secretStorage, reset);
		}
		if (reset.phase === 'local') {
			progress('Clearing this device’s previous sync state…');
			await clearLocalState();
			verify();
			secretStorage.set(SECRET_KEYS.AUTH_TOKEN, reset.replacementToken);
			if (secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== reset.replacementToken) throw new Error('Could not save the new device credential');
			for (const key of [SECRET_KEYS.ENCRYPTION_KEYS, SECRET_KEYS.ENCRYPTION_RECOVERY]) {
				secretStorage.delete(key);
				if (secretStorage.has(key)) throw new Error('Could not clear this device’s previous encryption keys');
			}
			resetStoredSyncState(settings);
			await persistSettings();
			verify();
			reset = { ...reset, phase: 'upload' };
			saveEncryptionReset(secretStorage, reset);
		}
		await transition.initialize(true);
		verify();
		const engine = getResetEngine();
		progress('Uploading this device’s vault without end-to-end encryption…');
		// The wipe is complete. Another reconnected device may already have
		// edited the new server copy; retries must retain the normal sync baseline.
		const result = await engine.sync((current, total) => progress(`Syncing files: ${current} of ${total}`));
		verify();
		if (!result.success || result.conflicts.length) throw new Error('The server reset is complete, but uploading needs attention. Resume to retry the upload.');
		if (!await pushSharedSettings()) throw new Error('Files were uploaded, but shared settings need to be retried. Resume the reset.');
		verify();
		await persistSettings({ automaticSync: reset.automaticSync });
		verify();
		secretStorage.delete(SECRET_KEYS.ENCRYPTION_RESET);
		if (secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('Could not clear the completed reset checkpoint');
		settings.automaticSync = reset.automaticSync;
		engine.updateSettings(settings);
		resumeEvents();
		progress('Encryption is off. Reconnect your other devices and web apps.');
	} catch (error) {
		settings.automaticSync = false;
		transition.stop();
		if (error instanceof EncryptionResetRejectedError && reset.phase === 'remote') {
			// The durable rejection marker makes cleanup retryable without another POST.
			verify();
			await persistSettings({ automaticSync: reset.automaticSync });
			verify();
			secretStorage.delete(SECRET_KEYS.ENCRYPTION_RESET);
			if (secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('Could not clear the rejected reset checkpoint. Resume to retry.');
			settings.automaticSync = reset.automaticSync;
			reportError(error.message);
			throw error;
		}
		reportError('Encryption reset is unfinished. Open Manage encryption to resume.');
		throw error;
	}
}
