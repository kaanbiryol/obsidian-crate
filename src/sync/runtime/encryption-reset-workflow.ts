import { createAbortError } from '../abort';
import { createEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { sealRecoveryBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import { loadEncryptionKeys, saveEncryptionKeys } from '../encryption/key-storage';
import { fitsEncryptedPathLimit } from '../../encryption/path-tags';
import type { SecretStorageService } from '../../plugin/secret-storage';
import { createEncryptionReset, createEncryptionSetup, loadEncryptionReset, saveEncryptionReset, resetRemoteEncryption, EncryptionResetRejectedError } from '../encryption/reset';
import type { SyncEngine } from '../engine/engine';
import type { RuntimeConfigurationTransition } from './runtime';
import { resetStoredSyncState } from './sync-activity';
import { WorkerApiHttpClient } from '../worker-api/http';
import { SECRET_KEYS } from '../../platform/secret-keys';
import type { SyncSettings } from '../settings';

interface EncryptionResetContext {
	settings: SyncSettings;
	secretStorage: SecretStorageService;
	transition: RuntimeConfigurationTransition;
	persistSettings: (update?: Partial<SyncSettings>) => Promise<void>;
	clearLocalState: () => Promise<void>;
	/** Also pauses vault event capture until resumeEvents runs. */
	getResetEngine: () => Pick<SyncEngine, 'sync' | 'updateSettings'>;
	pushSharedSettings: () => Promise<boolean>;
	/** Sync once more so the wipe cannot discard changes that exist only on the server.
	 * Returns the paths this device syncs. */
	syncBeforeReset: () => Promise<readonly string[]>;
	resumeEvents: () => void;
	reportError: (message: string) => void;
}

/** What to start when no reset is saved: turn encryption off, or on with these keys. */
export type EncryptionResetRequest = { target: 'plain'; state: EncryptionServerState | null } | { target: 'encrypted'; bundle: VaultKeyBundle; recovery: string };

/** Keep remote reset, local invalidation and reconciliation in their durable order. A
 * saved reset always resumes in its own direction, whatever the request. */
export async function runEncryptionReset(
	{ settings, secretStorage, transition, persistSettings, clearLocalState, getResetEngine, pushSharedSettings, syncBeforeReset, resumeEvents, reportError }: EncryptionResetContext,
	request: EncryptionResetRequest, progress: (message: string) => void,
	expected: { workerUrl: string; authToken: string }, signal?: AbortSignal,
): Promise<void> {
	const { verify } = transition;
	signal?.throwIfAborted();
	if (expected.workerUrl !== settings.workerUrl || expected.authToken !== secretStorage.get(SECRET_KEYS.AUTH_TOKEN)) {
		throw new Error('The server connection changed. Reopen Manage encryption.');
	}
	let reset = loadEncryptionReset(secretStorage);
	if (reset && (reset.workerUrl !== settings.workerUrl || ![reset.oldToken, reset.replacementToken].includes(expected.authToken))) {
		throw new Error('Reconnect the original server before resuming this reset');
	}
	if (!reset) {
		if (request.target === 'plain' && !request.state) throw new Error('No encryption reset is pending');
		progress('Syncing this device before replacing the server copy…');
		const synced = await syncBeforeReset();
		verify();
		if (request.target === 'encrypted') {
			// Refuse before the wipe: an encrypted upload cannot carry these paths.
			const deep = synced.filter(path => !fitsEncryptedPathLimit(path));
			if (deep.length) throw new Error(`${deep.length === 1 ? '1 file is' : `${deep.length} files are`} nested more than 36 folders deep, which an encrypted vault cannot sync. Move ${deep.length === 1 ? 'it' : 'them'} higher, then try again. First: ${deep[0]}`);
			// Keys are saved before the checkpoint, so a resumed setup always has them.
			saveEncryptionKeys(secretStorage, request.bundle, request.recovery);
		}
		if (expected.workerUrl !== settings.workerUrl || expected.authToken !== secretStorage.get(SECRET_KEYS.AUTH_TOKEN)) throw new Error('The server connection changed. Reopen Manage encryption.');
		reset = request.target === 'plain' ? createEncryptionReset(settings.workerUrl, expected.authToken, request.state!, settings.automaticSync)
			: createEncryptionSetup(settings.workerUrl, expected.authToken, request.bundle, settings.automaticSync);
		saveEncryptionReset(secretStorage, reset);
	}
	const encrypting = reset.target === 'encrypted';
	const savedKeys = () => {
		const keys = loadEncryptionKeys(secretStorage), recovery = secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
		if (!keys || !recovery || keys.vaultId !== reset!.vaultId || keys.generation !== reset!.generation) throw new Error('This device’s encryption keys are missing. Restore them before resuming.');
		return { keys, recovery };
	};
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
			}, checkpoint => saveEncryptionReset(secretStorage, checkpoint), encrypting ? async () => {
				const { keys, recovery } = savedKeys();
				return createEncryptionState(keys, await sealRecoveryBundle(keys, recovery));
			} : undefined);
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
			if (encrypting) savedKeys();
			else for (const key of [SECRET_KEYS.ENCRYPTION_KEYS, SECRET_KEYS.ENCRYPTION_RECOVERY]) {
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
		progress(encrypting ? 'Encrypting and uploading this device’s vault…' : 'Uploading this device’s vault without end-to-end encryption…');
		// The wipe is complete. Another reconnected device may already have
		// edited the new server copy; retries must retain the normal sync baseline.
		const result = await engine.sync((current, total) => progress(`Syncing files: ${current} of ${total}`));
		verify();
		if (result.outcome === 'cancelled') throw createAbortError('Encryption reset sync cancelled');
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
		progress(encrypting ? 'Encryption is on. Reconnect your other devices and web apps.' : 'Encryption is off. Reconnect your other devices and web apps.');
	} catch (error) {
		settings.automaticSync = false;
		transition.stop();
		if (error instanceof EncryptionResetRejectedError && reset.phase === 'remote') {
			// The durable rejection marker makes cleanup retryable without another POST.
			verify();
			await persistSettings({ automaticSync: reset.automaticSync });
			verify();
			// A refused setup encrypted nothing. Keys left behind would make the next start
			// upload encrypted files to the plaintext server.
			if (reset.target === 'encrypted') {
				secretStorage.delete(SECRET_KEYS.ENCRYPTION_KEYS);
				secretStorage.delete(SECRET_KEYS.ENCRYPTION_RECOVERY);
				if (secretStorage.get(SECRET_KEYS.ENCRYPTION_KEYS) || secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY)) {
					throw new Error('Could not clear the refused setup keys. Resume to retry.');
				}
			}
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
